import {
	ensureConfiguredBranch,
	gitFetch,
	gitProbe,
	gitStatus,
	listUnmergedPaths,
} from "../system/git.ts";
import { compareFiles, hasLocalChanges } from "../sync/inventory.ts";
import type { PackageApproval } from "../system/packages.ts";
import type { PiSyncConfig } from "../sync/config.ts";
import type { SyncState } from "../system/state.ts";
import type {
	CommandResult,
	RunOptions,
	SyncConflictPath,
} from "./operation-result.ts";
import {
	commitCapturedChangesBeforePull,
	integratePulledHead,
	preparePullWorktree,
} from "./pull-phase.ts";

type CaptureResult = {
	hasConflicts: boolean;
	errors: Array<{ file: string; message: string }>;
	/** 双侧冲突详情（P2：pull 远端优先时用于收集冲突路径） */
	conflicts: Array<{ relativePath: string }>;
};

export interface PullFlowOptions {
	agentDir: string;
	repoPath: string;
	config: PiSyncConfig;
	state: SyncState;
	packageApproval?: PackageApproval;
	signal?: AbortSignal;
	onProgress?: RunOptions["onProgress"];
	onGitCommandStart?: RunOptions["onGitCommandStart"];
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
	preserveRebaseConflict: (
		repoPath: string,
		config: PiSyncConfig,
	) => Promise<string>;
	normalizeChangedFiles: (
		changedFiles: string[],
		config: PiSyncConfig,
	) => string[];
	applyCurrent: (
		repoPath: string,
		config: PiSyncConfig,
		state: SyncState,
		reason: string,
		packageApproval?: PackageApproval,
		automaticConflictResolutionAttempted?: boolean,
		useRemoteForConflicts?: ReadonlySet<string>,
	) => Promise<CommandResult>;
	loadState: () => Promise<SyncState>;
	saveState: (state: SyncState) => Promise<void>;
}

function conflictPathsFrom(relativePaths: string[], config: PiSyncConfig, normalize: PullFlowOptions["normalizeChangedFiles"]): SyncConflictPath[] {
	return relativePaths.map((relativePath) => ({
		relativePath: normalize([relativePath], config)[0] ?? relativePath,
		changeType: "git_conflict",
	}));
}

/**
 * 执行完整的无锁 pull 流程。锁的获取、生命周期决策以及
 * Pi 特有的状态访问都由调用方负责。
 */
export async function runPullFlow(
	options: PullFlowOptions,
): Promise<CommandResult> {
	const {
		agentDir,
		repoPath,
		config,
		state,
		packageApproval,
		signal,
		onProgress,
		onGitCommandStart,
		captureLocalChanges,
		shouldRefreshLocalCapture,
		preserveRebaseConflict,
		normalizeChangedFiles,
		applyCurrent,
		loadState,
		saveState,
	} = options;
	const reportProgress = (message: string) => onProgress?.("pull", message);
	const reportGitStart = (command: string) =>
		onGitCommandStart?.("pull", command, config.pullTimeoutMs);
	const gitOptions = { timeout: config.pullTimeoutMs, signal };
	const pullTimeoutSeconds = config.pullTimeoutMs / 1000;

	reportProgress("正在检查仓库状态……");
	let status = await gitStatus(repoPath);
	let switchedBranch = false;
	if (status.branch !== config.branch) {
		try {
			const localBranch = await gitProbe(repoPath, [
				"show-ref",
				"--verify",
				`refs/heads/${config.branch}`,
			]);
			if (!localBranch.ok) {
				const command = "git fetch origin";
				reportProgress(
					`正在执行：${command}（超时：${pullTimeoutSeconds}s）……`,
				);
				reportGitStart(command);
				await gitFetch(repoPath, gitOptions);
			}
			reportProgress(`正在切换到 branch ${config.branch}……`);
			switchedBranch = await ensureConfiguredBranch(repoPath, config.branch);
			status = await gitStatus(repoPath);
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
	}

	const worktree = await preparePullWorktree(repoPath, status, reportProgress);
	if (worktree.kind === "blocked") {
		return {
			ok: false,
			code: "blocked_conflict",
			message: worktree.message,
			reload: false,
		};
	}
	if (worktree.kind === "failed") {
		return {
			ok: false,
			code: "git_failed",
			message: worktree.message,
			reload: false,
		};
	}
	status = worktree.status;
	const committedRepositoryChanges = worktree.committedRepositoryChanges;

	reportProgress("正在比较本机与远端的变更……");
	const inventory = await compareFiles(agentDir, repoPath, config, state);
	let convergedBaselineChanged = false;
	for (const comparison of inventory.comparisons) {
		if (
			comparison.local &&
			comparison.remote &&
			comparison.local.sha256 === comparison.remote.sha256 &&
			state.files[comparison.relativePath]?.sha256 !== comparison.remote.sha256
		) {
			state.files[comparison.relativePath] = {
				sha256: comparison.remote.sha256,
				mode: comparison.remote.mode,
			};
			convergedBaselineChanged = true;
		}
	}
	if (convergedBaselineChanged) await saveState(state);
	const hasRemoteChanges = inventory.comparisons.some((comparison) =>
		[
			"remote_only",
			"remote_created",
			"remote_deleted",
			"local_deleted_remote_modified",
			"converged",
		].includes(comparison.changeType),
	);
	let capturedLocalChanges = committedRepositoryChanges;
	// P2（design.md §5）：pull 遇冲突默认远端优先——冲突路径在 apply 时以远端覆盖本机。
	const remoteFirstPaths = new Set<string>();
	if (hasLocalChanges(inventory.comparisons)) {
		reportProgress("正在 pull 前捕获本机改动……");
		const capture = await captureLocalChanges(
			repoPath,
			config,
			state,
			shouldRefreshLocalCapture(status, state),
		);
		if (capture.hasConflicts) {
			// P2：双向冲突时不再创建设备分支，改为丢弃本机未推送漂移、以远端覆盖冲突路径。
			reportProgress(
				"远端优先：正在丢弃冲突文件上本机未推送的改动……",
			);
			for (const conflict of capture.conflicts) {
				remoteFirstPaths.add(conflict.relativePath);
			}
		} else {
			if (capture.errors.length > 0) {
				return {
					ok: false,
					code: "blocked_conflict",
					message: `捕获本机改动时 pull 被阻止。\n${capture.errors
						.map((error) => `${error.file}：${error.message}`)
						.join("\n")}`,
					reload: false,
				};
			}
			const captureCommit = await commitCapturedChangesBeforePull(
				repoPath,
				reportProgress,
			);
			if (captureCommit.kind === "failed") {
				return {
					ok: false,
					code: "git_failed",
					message: captureCommit.message,
					reload: false,
				};
			}
			capturedLocalChanges = true;
		}
	}

	const integration = await integratePulledHead({
		repoPath,
		branch: config.branch,
		timeoutMs: config.pullTimeoutMs,
		capturedLocalChanges,
		signal,
		onProgress: reportProgress,
		onGitCommandStart: reportGitStart,
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
			// P2（design.md §5）：rebase 冲突后 main 已指向远端（preserve 内部把
			// 本机提交保存到设备分支可找回），继续以远端优先覆盖本机，不再阻塞等待手动。
			const paths = conflictPathsFrom(
				await listUnmergedPaths(repoPath),
				config,
				normalizeChangedFiles,
			);
			await preserveRebaseConflict(repoPath, config);
			for (const path of paths) {
				remoteFirstPaths.add(path.relativePath);
			}
			reportProgress("正在对冲突文件应用远端优先内容……");
			return await applyCurrent(
				repoPath,
				config,
				await loadState(),
				"pull",
				packageApproval,
				false,
				remoteFirstPaths.size > 0 ? remoteFirstPaths : undefined,
			);
		} catch (error) {
			return {
				ok: false,
				code: "git_failed",
				message: `提交本机改动后 rebase 失败：${error instanceof Error ? error.message : "未知错误"}`,
				reload: false,
			};
		}
	}
	if (integration.kind === "rebased") {
		reportProgress("正在应用拉取到的变更……");
		return applyCurrent(
			repoPath,
			config,
			await loadState(),
			"pull",
			packageApproval,
			false,
			remoteFirstPaths.size > 0 ? remoteFirstPaths : undefined,
		);
	}

	const { pulled } = integration;
	const newState = await loadState();
	if (!pulled) {
		if (packageApproval || switchedBranch || hasRemoteChanges) {
			return applyCurrent(
				repoPath,
				config,
				newState,
				"pull",
				packageApproval,
				false,
				remoteFirstPaths.size > 0 ? remoteFirstPaths : undefined,
			);
		}
		return {
			ok: true,
			code: "noop",
			message: "pi-sync: 已是最新。",
			reload: false,
		};
	}

	reportProgress("正在应用拉取到的变更……");
	return applyCurrent(
		repoPath,
		config,
		newState,
		"pull",
		packageApproval,
		false,
		remoteFirstPaths.size > 0 ? remoteFirstPaths : undefined,
	);
}
