import {
	ensureConfiguredBranch,
	getHeadCommit,
	gitCommit,
	gitDiff,
	gitFetch,
	gitStatus,
	listUnmergedPaths,
} from "../system/git.ts";
import type { captureChanges } from "../sync/capture.ts";
import type { PiSyncConfig } from "../sync/config.ts";
import { validateFiles } from "../sync/validate.ts";
import { preparePackagePlan } from "../system/packages.ts";
import type { SyncState } from "../system/state.ts";
import type {
	CommandResult,
	SyncConflictPath,
	SyncConflictRequest,
} from "./operation-result.ts";
import {
	conflictResult,
	failureResult,
	noopResult,
} from "./operation-result.ts";
import { integrateCommittedPush } from "./push-phase.ts";
import { formatValidationErrors } from "../extension/ui.ts";

export interface PushPreparation {
	kind: "ready" | "noop" | "blocked";
	capture: Awaited<ReturnType<typeof captureChanges>>;
	changedFiles: string[];
	diff: string;
	repoHead: string;
	worktreeFingerprint: string;
	repoPath: string;
	branch: string;
	message?: string;
	conflict?: SyncConflictRequest;
}

type CaptureResult = Awaited<ReturnType<typeof captureChanges>>;
type ConflictCoordinationResult =
	| { kind: "resolved"; message: string }
	| { kind: "needs_user"; conflict: SyncConflictRequest; message: string };

export interface PushFlowOptions {
	agentDir: string;
	repoPath: string;
	config: PiSyncConfig;
	state: SyncState;
	captureLocalChanges: (
		repoPath: string,
		config: PiSyncConfig,
		state: SyncState,
		preferLocalOnConflicts: boolean,
	) => Promise<CaptureResult>;
	shouldRefreshLocalCapture: (
		status: Awaited<ReturnType<typeof gitStatus>>,
		state: SyncState,
	) => boolean;
	coordinateConflict: (
		repoPath: string,
		config: PiSyncConfig,
		state: SyncState,
	) => Promise<ConflictCoordinationResult>;
	applyCurrent: (
		repoPath: string,
		config: PiSyncConfig,
		state: SyncState,
		reason: string,
	) => Promise<CommandResult>;
	normalizeChangedFiles: (
		changedFiles: string[],
		config: PiSyncConfig,
	) => string[];
	computeFingerprint: (
		repoPath: string,
		config: PiSyncConfig,
		state: SyncState,
	) => Promise<string>;
	loadState: () => Promise<SyncState>;
	preserveRebaseConflict: (
		repoPath: string,
		config: PiSyncConfig,
	) => Promise<string>;
	mergeDeviceBranchIntoShared: (
		repoPath: string,
		config: PiSyncConfig,
		deviceBranch: string,
	) => Promise<boolean>;
	createConflictRequest: (
		repoPath: string,
		config: PiSyncConfig,
		deviceBranch: string,
		paths: SyncConflictPath[],
	) => Promise<SyncConflictRequest>;
	formatManualMergeMessage: (
		repoPath: string,
		config: PiSyncConfig,
		deviceBranch: string,
	) => string;
	formatMergedConflictMessage: (config: PiSyncConfig) => string;
	pushMainAndDeviceBranches: (
		repoPath: string,
		branch: string,
	) => Promise<unknown>;
}

function emptyCapture(): CaptureResult {
	return {
		captured: [],
		deleted: [],
		errors: [],
		hasConflicts: false,
		conflicts: [],
	};
}

function preparation(
	repoPath: string,
	branch: string,
	kind: PushPreparation["kind"],
	message: string,
	details: Partial<
		Omit<PushPreparation, "kind" | "repoPath" | "branch" | "message">
	> = {},
): PushPreparation {
	return {
		kind,
		capture: emptyCapture(),
		changedFiles: [],
		diff: "",
		repoHead: "",
		worktreeFingerprint: "",
		repoPath,
		branch,
		message,
		...details,
	};
}

function conflictPathsFrom(relativePaths: string[]): SyncConflictPath[] {
	return relativePaths.map((relativePath) => ({
		relativePath,
		changeType: "git_conflict",
	}));
}

export function resultFromPreparation(
	preparation: PushPreparation,
): CommandResult {
	if (preparation.kind === "ready") {
		return failureResult(
			"partial_failure",
			preparation.message ?? "push 准备已就绪，等待确认。",
			preparation,
		);
	}
	const details = preparation.conflict
		? { ...preparation, conflict: preparation.conflict }
		: preparation;
	return preparation.kind === "noop"
		? noopResult(preparation.message ?? "没有需要 push 的改动。", details)
		: conflictResult(preparation.message ?? "push 被阻止。", details);
}

/** 为 push 准备无锁的捕获、校验与确认边界。 */
export async function preparePushFlow(
	options: PushFlowOptions,
): Promise<PushPreparation> {
	const {
		agentDir,
		repoPath,
		config,
		state,
		captureLocalChanges,
		shouldRefreshLocalCapture,
		coordinateConflict,
		applyCurrent,
		normalizeChangedFiles,
		computeFingerprint,
	} = options;
	let statusBefore = await gitStatus(repoPath);
	if (
		statusBefore.branch !== config.branch &&
		!statusBefore.isRebasing &&
		!statusBefore.isMerging &&
		!statusBefore.hasUncommittedChanges
	) {
		try {
			await gitFetch(repoPath);
		} catch {
			// 下方的 ensureConfiguredBranch 会给出可操作的 branch 错误提示。
		}
	}
	try {
		await ensureConfiguredBranch(repoPath, config.branch);
		statusBefore = await gitStatus(repoPath);
	} catch (error) {
		return preparation(
			repoPath,
			config.branch,
			"blocked",
			error instanceof Error
				? error.message
				: "已配置 branch 的检查失败。",
			{ repoHead: statusBefore.commit },
		);
	}
	if (
		statusBefore.isRebasing ||
		statusBefore.isMerging ||
		statusBefore.hasConflicts
	) {
		return preparation(
			repoPath,
			config.branch,
			"blocked",
			"仓库处于冲突/待解决状态，请先解决后再准备 push。",
			{ repoHead: statusBefore.commit },
		);
	}

	const capture = await captureLocalChanges(
		repoPath,
		config,
		state,
		shouldRefreshLocalCapture(statusBefore, state),
	);
	if (capture.hasConflicts) {
		try {
			const coordination = await coordinateConflict(repoPath, config, state);
			if (coordination.kind === "resolved") {
				const applyResult = await applyCurrent(repoPath, config, state, "push");
				return preparation(
					repoPath,
					config.branch,
					applyResult.ok ? "noop" : "blocked",
					`${coordination.message}\n${applyResult.message}`,
					{ capture, repoHead: await getHeadCommit(repoPath) },
				);
			}
			return preparation(
				repoPath,
				config.branch,
				"blocked",
				coordination.message,
				{
					capture,
					repoHead: statusBefore.commit,
					conflict: coordination.conflict,
				},
			);
		} catch (error) {
			return preparation(
				repoPath,
				config.branch,
				"blocked",
				`无法创建本机冲突分支：${error instanceof Error ? error.message : "未知错误"}`,
				{ capture, repoHead: statusBefore.commit },
			);
		}
	}
	if (capture.errors.length > 0) {
		return preparation(
			repoPath,
			config.branch,
			"blocked",
			`捕获文件时 push 被阻止。\n${capture.errors.map((error) => `${error.file}：${error.message}`).join("\n")}`,
			{ capture, repoHead: statusBefore.commit },
		);
	}

	const status = await gitStatus(repoPath);
	const changedFiles = normalizeChangedFiles(status.changedFiles, config);
	const fingerprint = () => computeFingerprint(repoPath, config, state);
	if (!status.hasUncommittedChanges) {
		return preparation(repoPath, config.branch, "noop", "没有需要 push 的改动。", {
			capture,
			repoHead: await getHeadCommit(repoPath),
			worktreeFingerprint: await fingerprint(),
		});
	}
	const validation = await validateFiles(agentDir, repoPath, config, changedFiles);
	if (validation.blocked) {
		return preparation(
			repoPath,
			config.branch,
			"blocked",
			`push 被阻止：存在校验错误。\n${formatValidationErrors(validation.errors)}`,
			{
				capture,
				changedFiles,
				diff: await gitDiff(repoPath),
				repoHead: status.commit,
				worktreeFingerprint: await fingerprint(),
			},
		);
	}
	// 定制：无秘密扫描（design.md §3），校验通过后直接进入包计划。
	try {
		const packagePlan = await preparePackagePlan(repoPath, agentDir, config);
		if (packagePlan.approvalRequired.length > 0) {
			return preparation(
				repoPath,
				config.branch,
				"blocked",
				`push 前需要包审批：${packagePlan.approvalRequired.join("、")}`,
				{
					capture,
					changedFiles,
					diff: await gitDiff(repoPath),
					repoHead: status.commit,
					worktreeFingerprint: await fingerprint(),
				},
			);
		}
	} catch (error) {
		return preparation(
			repoPath,
			config.branch,
			"blocked",
			`包校验失败：${error instanceof Error ? error.message : "未知错误"}`,
			{
				capture,
				changedFiles,
				diff: await gitDiff(repoPath),
				repoHead: status.commit,
				worktreeFingerprint: await fingerprint(),
			},
		);
	}
	return preparation(
		repoPath,
		config.branch,
		"ready",
		`push 准备就绪：${changedFiles.length} 个文件有改动。`,
		{
			capture,
			changedFiles,
			diff: await gitDiff(repoPath),
			repoHead: status.commit,
			worktreeFingerprint: await fingerprint(),
		},
	);
}

/** 在外观层获取锁之后，提交并整合已确认的 push。 */
export async function executePushFlow(
	options: PushFlowOptions,
	preparation: PushPreparation,
	message?: string,
): Promise<CommandResult> {
	const {
		repoPath,
		config,
		state,
		computeFingerprint,
		loadState,
		preserveRebaseConflict,
		mergeDeviceBranchIntoShared,
		createConflictRequest,
		formatManualMergeMessage,
		formatMergedConflictMessage,
		pushMainAndDeviceBranches,
		applyCurrent,
		normalizeChangedFiles,
	} = options;
	try {
		await ensureConfiguredBranch(repoPath, config.branch);
	} catch (error) {
		return {
			ok: false,
			code: "blocked_conflict",
			message:
				error instanceof Error
					? error.message
					: "已配置 branch 的检查失败。",
			reload: false,
		};
	}
	if (
		(await getHeadCommit(repoPath)) !== preparation.repoHead ||
		(await computeFingerprint(repoPath, config, state)) !==
			preparation.worktreeFingerprint
	) {
		return {
			ok: false,
			code: "blocked_conflict",
			message:
				"push 准备已失效：确认后仓库或 agent 发生了变化，请重新准备 push。",
			reload: false,
		};
	}
	await gitCommit(repoPath, message ?? "pi-sync: 更新配置");
	const integration = await integrateCommittedPush({
		repoPath,
		branch: preparation.branch,
	});
	if (integration.kind === "failed") {
		return {
			ok: false,
			code: "git_failed",
			message: integration.message,
			reload: false,
		};
	}
	if (integration.kind === "rebase_conflict") {
		try {
			const paths = conflictPathsFrom(
				normalizeChangedFiles(await listUnmergedPaths(repoPath), config),
			);
			const branch = await preserveRebaseConflict(repoPath, config);
			if (!(await mergeDeviceBranchIntoShared(repoPath, config, branch))) {
				const conflict = await createConflictRequest(
					repoPath,
					config,
					branch,
					paths,
				);
				return {
					ok: false,
					code: "blocked_conflict",
					message: formatManualMergeMessage(repoPath, config, branch),
					reload: false,
					details: { conflict },
				};
			}
			const applyResult = await applyCurrent(
				repoPath,
				config,
				await loadState(),
				"push",
			);
			if (!applyResult.ok) {
				return {
					ok: false,
					code: applyResult.code,
					message: `push 已完成，但应用同步后的配置失败。\n${formatMergedConflictMessage(config)}\n${applyResult.message}`,
					reload: false,
				};
			}
			return {
				ok: true,
				code: "ok",
				message: `push 成功。\n${formatMergedConflictMessage(config)}\n${applyResult.message}`,
				reload: applyResult.reload,
			};
		} catch (error) {
			return {
				ok: false,
				code: "git_failed",
				message: `无法创建或合并当前设备的冲突分支：${error instanceof Error ? error.message : "未知错误"}`,
				reload: false,
			};
		}
	}
	try {
		await pushMainAndDeviceBranches(repoPath, preparation.branch);
	} catch (error) {
		return {
			ok: false,
			code: "git_failed",
			message: `push 失败：${error instanceof Error ? error.message : "未知错误"}\n本机提交已保留。`,
			reload: false,
		};
	}
	const applyResult = await applyCurrent(
		repoPath,
		config,
		await loadState(),
		"push",
	);
	if (!applyResult.ok) {
		return {
			ok: false,
			code: applyResult.code,
			message: `push 已完成，但应用同步后的配置失败。\n${applyResult.message}`,
			reload: false,
		};
	}
	return {
		ok: true,
		code: "ok",
		message: `push 成功。\n${applyResult.message}`,
		reload: applyResult.reload,
	};
}
