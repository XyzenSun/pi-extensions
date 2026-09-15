/**
 * /pisync 命令路由（schema v2）
 *
 * 所有同步操作的主入口。
 *
 * 核心流程变化（v1 → v2）：
 * - 配置仓库不再作为 Pi Package 安装
 * - settings.json 整文件共享，不做 managed-key merge
 * - 基于同步基线的三方比较
 * - capture → commit → fetch → rebase → push → apply 完整 push 链
 * - 冲突处理与 push --continue
 */
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
	ensureConfiguredBranch,
	gitStatus,
	gitFetch,
	gitFastForward,
	gitPush,
	gitPushHeadToBranch,
	gitPushDeviceBranch,
	gitDiff,
	gitDiffRange,
	gitRebaseAbort,
	gitCommit,
	getHeadCommit,
	hasUnmergedPaths,
	isWorktreeClean,
	gitExec,
	gitProbe,
	canFastForward,
	GitCommandError,
} from "../system/git.ts";
import {
	loadPiSyncConfig,
	setAutoSyncEnabled as setAutoSyncEnabledInConfig,
} from "../sync/config.ts";
import { withOperationSignal } from "../system/operation-context.ts";
import type { PiSyncConfig } from "../sync/config.ts";
import { executeApplyTransaction } from "./apply-transaction.ts";
import { runPullFlow } from "./pull-flow.ts";
import {
	executePushFlow,
	preparePushFlow,
	resultFromPreparation,
} from "./push-flow.ts";
import {
	clearRepoContents,
	executeSetupFlow,
	isValidSetupGitUrl,
} from "./setup-flow.ts";
import { planMaterialize } from "../sync/materialize.ts";
import { SyncLock } from "../system/lock.ts";
import { ensureDeviceId, loadState, saveState } from "../system/state.ts";
import type { SyncState } from "../system/state.ts";import {
	conflictResult,
	failureResult,
	isSyncConflictRequest,
	noopResult,
	successResult,
	syncSelectionItemId,
} from "./operation-result.ts";
import type {
	CommandResult,
	ResultCode,
	RunOptions,
	RunResult,
	SyncPlan,
	SyncSelections,
	SyncConflictPath,
	SyncConflictRequest,
	SyncPhase,
} from "./operation-result.ts";
import { captureChanges } from "../sync/capture.ts";
import {
	compareFiles,
	isBilateralConflict,
	sha256,
	type FileChangeType,
} from "../sync/inventory.ts";
import { validateFiles } from "../sync/validate.ts";
import {
	getPackageDiff,
	preparePackagePlan,
	approvePackagePlan,
} from "../system/packages.ts";
import type { PackageApproval } from "../system/packages.ts";
import {
	resolveRepoSyncRoot,
	resolveWithinRoot,
} from "../system/path-safety.ts";
import {
	formatGitStatus,
	formatSyncStatusV2,
	formatComparisonDiff,
	formatValidationErrors,
} from "../extension/ui.ts";

// ========== 路径工具 ==========

function getAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) return envDir;

	const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
	return join(home, ".pi", "agent");
}

async function getRepoPathSafe(): Promise<string | null> {
	try {
		return await getRepoPath();
	} catch {
		return null;
	}
}

async function getRepoPath(configOverride?: string): Promise<string> {
	if (configOverride) return configOverride;

	const agentDir = getAgentDir();
	const state = await loadState(agentDir);
	if (state.repoPath && existsSync(state.repoPath)) {
		return state.repoPath;
	}
	throw new Error("未找到配置仓库，请先运行 /pisync 完成初始化。");
}

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

/** autoSync 单次检查的结果摘要 */
export interface AutoSyncOutcome {
	status: "applied" | "skipped";
	reason:
		| "uninitialized"
		| "disabled"
		| "busy"
		| "conflict_state"
		| "dirty_worktree"
		| "offline"
		| "drift"
		| "no_update"
		| "needs_interaction"
		| "applied";
	message: string;
	/** 应用了远端变更并需要 reload 时为 true */
	reload?: boolean;
}

/**
 * TUI 状态总览的只读快照（docs/tui-prd.md §4.1）。
 *
 * 与 `formatSyncStatusV2` 的成品文本不同，这里给的是结构化数据——
 * TUI 要自己排版上色，拿到字符串反而没法用。
 */
export interface TuiStatusSnapshot {
	branch: string;
	ahead: number;
	behind: number;
	/** 待同步的文件变更数（不含已收敛项）。 */
	pendingChanges: number;
	/** 语义层冲突数，与 Git 层冲突是两回事。 */
	conflicts: number;
	autoSyncEnabled: boolean;
	lastSyncedAt: string | null;
}

export type LifecycleState =
	| { kind: "uninitialized" }
	| {
			kind: "interrupted_setup";
			repoPath: string;
			gitUrl: string;
	  }
	| { kind: "initialized"; repoPath: string; state: SyncState }
	| { kind: "broken"; reason: string; repoPath?: string };

type ConflictCoordinationResult =
	| { kind: "resolved"; message: string }
	| {
			kind: "needs_user";
			conflict: SyncConflictRequest;
			message: string;
	  };

interface InitInternalResult {
	message: string;
	needsReload: boolean;
	ok: boolean;
	level: "info" | "warning" | "error";
	code?: ResultCode;
	details?: unknown;
}

export type InitResult = CommandResult & {
	needsReload: boolean;
	level: "info" | "warning" | "error";
};

function normalizeInitResult(result: InitInternalResult): InitResult {
	return {
		...result,
		code: result.code ?? (result.ok ? "ok" : "partial_failure"),
		reload: result.needsReload,
	};
}

function conflictPathsFrom(
	conflicts: ReadonlyArray<{
		relativePath: string;
		changeType: string;
	}>,
): SyncConflictPath[] {
	const paths = new Map<string, SyncConflictPath>();
	for (const conflict of conflicts) {
		const changeType = isBilateralConflict(
			conflict.changeType as FileChangeType,
		)
			? (conflict.changeType as SyncConflictPath["changeType"])
			: "git_conflict";
		paths.set(conflict.relativePath, {
			relativePath: conflict.relativePath,
			changeType,
		});
	}
	return [...paths.values()].sort((a, b) =>
		a.relativePath.localeCompare(b.relativePath),
	);
}

function conflictFromDetails(
	details: unknown,
): SyncConflictRequest | undefined {
	if (!details || typeof details !== "object") return undefined;
	const conflict = (details as { conflict?: unknown }).conflict;
	return isSyncConflictRequest(conflict) ? conflict : undefined;
}

function stringArray(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) return undefined;
	const items = value.filter(
		(item): item is string => typeof item === "string" && item.length > 0,
	);
	return items.length > 0 ? [...new Set(items)] : undefined;
}

/** 将不可信的 UI 选择校验为规范化、精简后的形式。 */
function normalizeSyncSelections(value: unknown): SyncSelections | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const selections: SyncSelections = {};
	if (raw.reviewed === true) selections.reviewed = true;
	const reviewedItems = stringArray(raw.reviewedItems);
	const installPackages = stringArray(raw.installPackages);
	const removePackages = stringArray(raw.removePackages);
	const deferApplyPaths = stringArray(raw.deferApplyPaths);
	const keepLocalPaths = stringArray(raw.keepLocalPaths);
	if (reviewedItems) selections.reviewedItems = reviewedItems;
	if (installPackages) selections.installPackages = installPackages;
	if (removePackages) selections.removePackages = removePackages;
	if (deferApplyPaths) selections.deferApplyPaths = deferApplyPaths;
	if (keepLocalPaths) selections.keepLocalPaths = keepLocalPaths;
	return Object.keys(selections).length > 0 ? selections : undefined;
}

const BUILTIN_SYNC_PACKAGE = "npm:@xyzensun/pi-sync";
const INCOMING_EXTENSION_CHANGE_TYPES = new Set([
	"remote_only",
	"remote_created",
	"remote_deleted",
]);

function incomingExtensionPaths(
	inventory: Awaited<ReturnType<typeof compareFiles>>,
): string[] {
	return inventory.comparisons
		.filter(
			(comparison) =>
				comparison.relativePath.startsWith("extensions/") &&
				INCOMING_EXTENSION_CHANGE_TYPES.has(comparison.changeType),
		)
		.map((comparison) => comparison.relativePath);
}

function buildExtensionSelectionRequest(
	inventory: Awaited<ReturnType<typeof compareFiles>>,
	packagePlan: Awaited<ReturnType<typeof preparePackagePlan>>,
	settingsIncoming: boolean,
): import("./operation-result.ts").ExtensionSelectionRequest {
	return {
		changes: inventory.comparisons
			.filter(
				(comparison) =>
					comparison.relativePath === "settings.json" ||
					(comparison.relativePath.startsWith("extensions/") &&
						INCOMING_EXTENSION_CHANGE_TYPES.has(comparison.changeType)),
			)
			.map(({ relativePath, changeType }) => ({ relativePath, changeType })),
		packages: settingsIncoming
			? {
					added: packagePlan.added.map((entry) => entry.source),
					changed: packagePlan.changed.map((entry) => entry.remote.source),
					removed: packagePlan.removed.map((entry) => entry.source),
				}
			: { added: [], changed: [], removed: [] },
	};
}

function hasUnreviewedIncomingItems(
	inventory: Awaited<ReturnType<typeof compareFiles>>,
	packagePlan: Awaited<ReturnType<typeof preparePackagePlan>>,
	settingsIncoming: boolean,
	selections: SyncSelections | null,
): boolean {
	const reviewed = new Set(selections?.reviewedItems ?? []);
	if (settingsIncoming) {
		for (const source of [
			...packagePlan.added.map((entry) => entry.source),
			...packagePlan.changed.map((entry) => entry.remote.source),
		]) {
			if (
				source !== BUILTIN_SYNC_PACKAGE &&
				!reviewed.has(syncSelectionItemId("package-install", source))
			)
				return true;
		}
		for (const source of packagePlan.removed.map((entry) => entry.source)) {
			if (
				source !== BUILTIN_SYNC_PACKAGE &&
				!reviewed.has(syncSelectionItemId("package-remove", source))
			)
				return true;
		}
	}
	return incomingExtensionPaths(inventory).some(
		(path) => !reviewed.has(syncSelectionItemId("extension-apply", path)),
	);
}

// ========== 命令类 ==========

export class PiSyncCommands {
	private agentDir: string;
	private lock: SyncLock;
	private orchestrationLockHeld = false;
	/** 当前 run() 调用生效的逐项计划选择。 */
	private activeSelections: SyncSelections | null = null;

	constructor(agentDir?: string) {
		this.agentDir = agentDir ?? getAgentDir();
		this.lock = new SyncLock(join(this.agentDir, ".pi-sync"));
	}

	/** 返回已配置的仓库路径，仅供扩展做展示用途。 */
	async getConflictRepoPath(): Promise<string | null> {
		const state = await loadState(this.agentDir);
		return state.repoPath && existsSync(state.repoPath) ? state.repoPath : null;
	}

	/** 为交互式同步确认构建只读、带指纹的摘要。 */
	async plan(): Promise<SyncPlan> {
		const lifecycle = await this.inspectLifecycleState();
		if (lifecycle.kind === "broken") {
			return {
				kind: "blocked",
				message: `同步状态已损坏：${lifecycle.reason}`,
			};
		}
		if (lifecycle.kind === "uninitialized") {
			return {
				kind: "setup",
				message:
					"请输入配置仓库的 Git URL，以查看并完成首次初始化。",
			};
		}
		if (lifecycle.kind === "interrupted_setup") {
			return {
				kind: "setup",
				message:
					"确认仓库 URL 后，将继续被中断的初始化流程。",
			};
		}
		return await this.planInitializedSync(lifecycle.repoPath, lifecycle.state);
	}

	private async planInitializedSync(
		repoPath: string,
		state: SyncState,
	): Promise<Extract<SyncPlan, { kind: "ready" }>> {
		const config = await loadPiSyncConfig(repoPath);
		const [status, inventory, packageDiff] = await Promise.all([
			gitStatus(repoPath, config.branch),
			compareFiles(this.agentDir, repoPath, config, state),
			getPackageDiff(repoPath, this.agentDir, config).catch(() => ({
				added: [],
				removed: [],
				changed: [],
				unchanged: [],
			})),
		]);
		const changes = inventory.comparisons
			.filter(
				(comparison) =>
					comparison.changeType !== "no_change" &&
					comparison.changeType !== "converged",
			)
			.map(({ relativePath, changeType, local, remote }) => ({
				relativePath,
				changeType,
				local: local?.sha256 ?? "absent",
				remote: remote?.sha256 ?? "absent",
			}));
		const packages = {
			added: packageDiff.added,
			removed: packageDiff.removed,
			changed: packageDiff.changed,
		};
		const fingerprint = sha256(
			JSON.stringify({
				branch: status.branch,
				commit: status.commit,
				ahead: status.ahead,
				behind: status.behind,
				pendingOperation: state.pendingOperation,
				changes,
				packages,
			}),
		);
		return {
			kind: "ready",
			fingerprint,
			changes: changes.map(({ relativePath, changeType }) => ({
				relativePath,
				changeType,
			})),
			packages,
			remote: { ahead: status.ahead, behind: status.behind },
			pendingRecovery: state.pendingOperation !== null,
			message:
				"同步会改动你的配置，请先审阅此计划。",
		};
	}

	/**
	 * 检查本机生命周期状态，且不把已损坏的仓库误判为全新安装。
	 * 这是 `run()` 唯一的状态判定点。
	 */
	async inspectLifecycleState(): Promise<LifecycleState> {
		const state = await loadState(this.agentDir);
		const defaultPath = join(this.agentDir, "..", "config-repo");

		if (!state.repoPath) {
			if (!existsSync(defaultPath)) return { kind: "uninitialized" };
			if (!existsSync(join(defaultPath, ".git"))) {
				return {
					kind: "broken",
					reason:
						"存在不完整的配置仓库，且缺少 .git 目录。",
					repoPath: defaultPath,
				};
			}

			const [origin, status, commitCount] = await Promise.all([
				gitProbe(defaultPath, ["remote", "get-url", "origin"]),
				gitProbe(defaultPath, ["status", "--porcelain"]),
				gitProbe(defaultPath, ["rev-list", "--count", "HEAD"]),
			]);
			const gitUrl = origin.stdout.trim();
			if (!origin.ok || !gitUrl || !status.ok) {
				return {
					kind: "broken",
					reason:
						"该不完整的配置仓库不是带 origin 远端的可用克隆。",
					repoPath: defaultPath,
				};
			}

			const repositoryIsEmpty =
				!commitCount.ok || parseInt(commitCount.stdout.trim(), 10) === 0;
			if (!existsSync(join(defaultPath, "pi-sync.json"))) {
				return repositoryIsEmpty
					? {
							kind: "interrupted_setup",
							repoPath: defaultPath,
							gitUrl,
						}
					: {
							kind: "broken",
							reason:
								"配置仓库已有提交，但缺少 pi-sync.json。",
							repoPath: defaultPath,
						};
			}

			try {
				await loadPiSyncConfig(defaultPath);
			} catch (error) {
				return {
					kind: "broken",
					reason:
						error instanceof Error
							? `该不完整仓库的 pi-sync.json 无效：${error.message}`
							: "该不完整仓库的 pi-sync.json 无效。",
					repoPath: defaultPath,
				};
			}

			return {
				kind: "interrupted_setup",
				repoPath: defaultPath,
				gitUrl,
			};
		}

		if (!existsSync(state.repoPath)) {
			return {
				kind: "broken",
				reason: "同步状态指向的仓库已不存在。",
				repoPath: state.repoPath,
			};
		}
		if (!existsSync(join(state.repoPath, ".git"))) {
			return {
				kind: "broken",
				reason: "已配置的仓库缺少 .git 目录。",
				repoPath: state.repoPath,
			};
		}
		if (!existsSync(join(state.repoPath, "pi-sync.json"))) {
			return {
				kind: "broken",
				reason: "已配置的仓库缺少 pi-sync.json。",
				repoPath: state.repoPath,
			};
		}

		try {
			await loadPiSyncConfig(state.repoPath);
		} catch (error) {
			return {
				kind: "broken",
				reason:
					error instanceof Error
						? `已配置仓库的 pi-sync.json 无效：${error.message}`
						: "已配置仓库的 pi-sync.json 无效。",
				repoPath: state.repoPath,
			};
		}

		return { kind: "initialized", repoPath: state.repoPath, state };
	}

	private emitProgress(
		onProgress: RunOptions["onProgress"],
		phase: SyncPhase,
		message: string,
	): void {
		onProgress?.(phase, message);
	}

	/** 为公开操作管理锁的归属，不改变阶段语义。 */
	private async withCommandLock<T>(
		operation: string,
		onBusy: () => T,
		run: () => Promise<T>,
	): Promise<T> {
		if (this.orchestrationLockHeld) return run();
		if (!(await this.lock.acquire(operation, 5000))) return onBusy();
		try {
			return await run();
		} finally {
			await this.lock.release();
		}
	}

	private busyCommandResult(): CommandResult {
		return failureResult(
			"partial_failure",
			"已有同步操作正在进行。",
		);
	}

	private async recoverPendingInternal(
		lifecycle: Extract<LifecycleState, { kind: "initialized" }>,
		options: RunOptions,
	): Promise<CommandResult> {
		const pending = lifecycle.state.pendingOperation;
		if (!pending) {
			return {
				ok: true,
				code: "noop",
				message: "无需恢复。",
				reload: false,
			};
		}
		if (pending.type === "push-rebase-conflict") {
			return await this.push(lifecycle.repoPath, undefined, "--continue");
		}
		if (pending.type === "apply-failed") {
			return await this.apply(lifecycle.repoPath, options.packageApproval);
		}
		return {
			ok: false,
			code: "partial_failure",
			message: `未知的待处理操作 "${String((pending as { type?: unknown }).type)}"，请先手动处理后再同步。`,
			reload: false,
		};
	}

	private async syncInternal(
		repoPath: string,
		options: RunOptions,
		initialReload = false,
	): Promise<RunResult> {
		this.emitProgress(options.onProgress, "pull", "正在拉取远端变更……");
		const pull = await this.pull(
			repoPath,
			options.packageApproval,
			options.onProgress,
			{
				signal: options.signal,
				onGitCommandStart: options.onGitCommandStart,
			},
		);
		if (
			!pull.ok ||
			pull.code === "approval_required" ||
			pull.code === "selection_required"
		) {
			const pullDetails =
				typeof pull.details === "object" && pull.details !== null
					? (pull.details as {
							packages?: unknown;
							extensionSelection?: unknown;
						})
					: undefined;
			const conflict = conflictFromDetails(pull.details);
			return {
				...pull,
				mode: "sync",
				phase:
					pull.code === "approval_required" || pull.code === "selection_required"
						? "apply"
						: "pull",
				reload: initialReload || pull.reload,
				details: {
					pull,
					conflict,
					packages: Array.isArray(pullDetails?.packages)
						? pullDetails.packages
						: undefined,
					extensionSelection: pullDetails?.extensionSelection,
				},
			};
		}

		this.emitProgress(options.onProgress, "push", "正在推送本机改动……");
		const push = await this.push(repoPath);
		const code = !push.ok
			? push.code
			: pull.code === "noop" && push.code === "noop"
				? "noop"
				: "ok";
		return {
			ok: push.ok,
			code,
			message:
				`同步${push.ok ? "完成" : "未完成"}。\n` +
				`Pull：${pull.message}\nPush：${push.message}`,
			reload: initialReload || pull.reload || push.reload,
			mode: "sync",
			phase: "complete",
			details: {
				pull,
				push,
				conflict: conflictFromDetails(push.details),
			},
		};
	}

	/** 执行初始化、恢复，或完整的“先 pull 后 push”同步流程。 */
	async run(options: RunOptions = {}): Promise<RunResult> {
		return await withOperationSignal(options.signal, () =>
			this.runWithOperationSignal(options),
		);
	}

	private async runWithOperationSignal(
		options: RunOptions,
	): Promise<RunResult> {
		this.emitProgress(
			options.onProgress,
			"preflight",
			"正在检查同步状态……",
		);
		const lifecycle = await this.inspectLifecycleState();

		if (lifecycle.kind === "broken") {
			return {
				ok: false,
				code: "partial_failure",
				message: `同步状态已损坏：${lifecycle.reason}`,
				reload: false,
				mode: "sync",
				phase: "preflight",
				details: { reason: lifecycle.reason },
			};
		}

		if (
			lifecycle.kind === "uninitialized" ||
			lifecycle.kind === "interrupted_setup"
		) {
			const gitUrl =
				lifecycle.kind === "interrupted_setup"
					? lifecycle.gitUrl
					: options.gitUrl;
			if (!gitUrl) {
				return {
					ok: false,
					code: "blocked_validation",
					message: "请输入你的配置仓库 Git URL 以开始。",
					reload: false,
					mode: "setup",
					phase: "preflight",
					details: { needsGitUrl: true },
				};
			}
			if (lifecycle.kind === "interrupted_setup") {
				this.emitProgress(
					options.onProgress,
					"preflight",
					"正在继续被中断的初始化……",
				);
			}
			const reportSetupProgress = (message: string) =>
				this.emitProgress(options.onProgress, "preflight", message);
			const setup =
				lifecycle.kind === "interrupted_setup"
					? normalizeInitResult(
							await this.initFresh(
								gitUrl,
								lifecycle.repoPath,
								reportSetupProgress,
								false,
								options.packageApproval,
							),
						)
					: await this.init(
							gitUrl,
							reportSetupProgress,
							false,
							options.packageApproval,
						);
			return {
				...setup,
				mode: "setup",
				phase: setup.ok ? "complete" : "preflight",
				details:
					typeof setup.details === "object" && setup.details !== null
						? (setup.details as RunResult["details"])
						: undefined,
			};
		}

		const acquired = await this.lock.acquire("sync", 5000);
		if (!acquired) {
			return {
				ok: false,
				code: "partial_failure",
				message: "已有同步操作正在进行。",
				reload: false,
				mode: "sync",
				phase: "preflight",
			};
		}

		this.orchestrationLockHeld = true;
		try {
			if (options.expectedPlanFingerprint) {
				const currentPlan = await this.planInitializedSync(
					lifecycle.repoPath,
					lifecycle.state,
				);
				if (currentPlan.fingerprint !== options.expectedPlanFingerprint) {
					return {
						ok: false,
						code: "blocked_validation",
						message:
							"同步计划在你审阅期间发生了变化，请审阅新计划后重新运行 /pisync。",
						reload: false,
						mode: "sync",
						phase: "preflight",
					};
				}
			}
			// 每个消费点都会用实时仓库状态重新校验这些选择；
			// 未知的键一律丢弃，绝不凭空产生。
			this.activeSelections =
				normalizeSyncSelections(options.selections) ?? null;
			let recoveryReload = false;
			if (lifecycle.state.pendingOperation) {
				this.emitProgress(
					options.onProgress,
					"preflight",
					"正在恢复待处理操作……",
				);
				const recovery = await this.recoverPendingInternal(lifecycle, options);
				recoveryReload = recovery.reload;
				if (!recovery.ok || recovery.code === "approval_required") {
					return {
						...recovery,
						mode: "recovery",
						phase:
							recovery.code === "approval_required" ? "apply" : "preflight",
						details:
							typeof recovery.details === "object" && recovery.details !== null
								? (recovery.details as RunResult["details"])
								: undefined,
					};
				}
			}
			return await this.syncInternal(
				lifecycle.repoPath,
				options,
				recoveryReload,
			);
		} finally {
			this.orchestrationLockHeld = false;
			this.activeSelections = null;
			await this.lock.release();
		}
	}

	// ========== 冲突分支 ==========

	/**
	 * 每个 agent 拥有一个稳定的远端快照分支。主机名可读但不唯一，
	 * 因此与仅持久化在本机状态里的 UUID 配对使用。
	 * 我们绝不扫描远端分支去猜测：当前设备分支是确定可知的，
	 * 而其他设备本就可能合理地拥有多个分支。
	 */
	private async getDeviceBranchName(): Promise<string> {
		const host =
			hostname()
				.toLowerCase()
				.replace(/[^a-z0-9_-]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 40) || "device";
		const deviceId = await ensureDeviceId(this.agentDir);
		return `pisync-device/${host}-${deviceId}`;
	}

	/** 在同一 HEAD 上推送共享 branch 与当前设备的快照分支。 */
	private async pushMainAndDeviceBranches(
		repoPath: string,
		branch: string,
	): Promise<string> {
		await gitPush(repoPath, branch);
		const deviceBranch = await this.getDeviceBranchName();
		await gitPushHeadToBranch(repoPath, deviceBranch);
		return deviceBranch;
	}

	private async createSyncConflictRequest(
		repoPath: string,
		config: PiSyncConfig,
		deviceBranch: string,
		paths: SyncConflictPath[],
	): Promise<SyncConflictRequest> {
		const [sharedRef, deviceRef] = await Promise.all([
			gitProbe(repoPath, [
				"show-ref",
				"--hash",
				"--verify",
				`refs/remotes/origin/${config.branch}`,
			]),
			gitProbe(repoPath, [
				"show-ref",
				"--hash",
				"--verify",
				`refs/remotes/origin/${deviceBranch}`,
			]),
		]);
		if (!deviceRef.ok || !deviceRef.stdout.trim()) {
			throw new Error(
				`当前设备分支 origin/${deviceBranch} 尚未发布。`,
			);
		}
		return {
			kind: "sync_conflict",
			sharedBranch: config.branch,
			deviceBranch,
			sharedHead: sharedRef.ok ? sharedRef.stdout.trim() : undefined,
			deviceHead: deviceRef.stdout.trim(),
			paths,
		};
	}

	private formatManualMergeMessage(
		repoPath: string,
		config: PiSyncConfig,
		branch: string,
	): string {
		return [
			"检测到同步冲突，共享 branch 未做改动。",
			`当前设备的改动已保存到 origin/${branch}。`,
			"",
			"请将当前设备分支合并到共享 branch：",
			`  cd ${repoPath}`,
			"  git fetch origin",
			`  git switch ${config.branch}`,
			`  git merge origin/${branch}`,
			"",
			`解决所有冲突后，依次运行 git add、git commit 和 git push origin ${config.branch}。`,
		].join("\n");
	}

	private formatFastForwardedConflictMessage(config: PiSyncConfig): string {
		return [
			"已通过快进当前设备的改动解决同步冲突。",
			`当前设备的版本已发布到 ${config.branch}。`,
		].join("\n");
	}

	private formatMergedConflictMessage(config: PiSyncConfig): string {
		return [
			"已通过自动合并当前设备的改动解决同步冲突。",
			`合并后的版本已发布到 ${config.branch}。`,
		].join("\n");
	}

	/**
	 * 无需用户介入即可把已发布的设备快照合并进共享 branch。
	 * 遇到真正的内容冲突则中止合并，保留两侧远端分支不变，
	 * 交由既有的手动解决兜底路径处理。
	 */
	private async mergeDeviceBranchIntoShared(
		repoPath: string,
		config: PiSyncConfig,
		deviceBranch: string,
	): Promise<boolean> {
		try {
			await gitExec(repoPath, ["merge", "--no-edit", `origin/${deviceBranch}`]);
		} catch (error) {
			const output =
				error instanceof GitCommandError
					? `${error.stdout}\n${error.stderr}`
					: "";
			if (!/CONFLICT|Automatic merge failed/i.test(output)) throw error;
			await gitExec(repoPath, ["merge", "--abort"]);
			return false;
		}

		try {
			await this.pushMainAndDeviceBranches(repoPath, config.branch);
			return true;
		} catch (error) {
			const output =
				error instanceof GitCommandError
					? `${error.stdout}\n${error.stderr}`
					: "";
			if (!/rejected|fetch first|non-fast-forward/i.test(output)) throw error;

			// 保留已发布的设备快照，但丢弃本机的这次合并——
			// 它已被并发的共享 branch 更新作废。
			await gitFetch(repoPath);
			await gitExec(repoPath, ["reset", "--hard", `origin/${config.branch}`]);
			return false;
		}
	}

	/** 保存并发布当前设备的改动，在安全时快进共享 branch。 */
	private async preserveConflictOnDeviceBranch(
		repoPath: string,
		config: PiSyncConfig,
		state: SyncState,
	): Promise<{
		branch: string;
		fastForwarded: boolean;
		paths: SyncConflictPath[];
	}> {
		const branch = await this.getDeviceBranchName();
		await gitExec(repoPath, ["switch", "-C", branch]);
		try {
			const capture = await captureChanges(
				this.agentDir,
				repoPath,
				config,
				state,
				{ preferLocalOnConflicts: true },
			);
			const paths = conflictPathsFrom(capture.conflicts);
			if (capture.errors.length > 0) {
				throw new Error(
					`无法在 ${branch} 上保留当前设备的改动：${capture.errors
						.map((error) => `${error.file}：${error.message}`)
						.join("；")}`,
				);
			}
			await gitCommit(
				repoPath,
				"pi-sync: 保留当前设备的冲突改动",
			);
			await gitPushDeviceBranch(repoPath, branch);
			await gitFetch(repoPath);

			if (
				!(await canFastForward(repoPath, `origin/${config.branch}`, branch))
			) {
				return { branch, fastForwarded: false, paths };
			}

			await gitExec(repoPath, ["switch", config.branch]);
			await gitExec(repoPath, ["merge", "--ff-only", branch]);
			try {
				await gitPush(repoPath, config.branch);
				return { branch, fastForwarded: true, paths };
			} catch (error) {
				const output =
					error instanceof GitCommandError
						? `${error.stdout}\n${error.stderr}`
						: "";
				if (!/rejected|fetch first|non-fast-forward/i.test(output)) {
					throw error;
				}
				// 并发的远端更新使预检结果失效。设备分支已经发布，
				// 因此恢复共享 branch，让常规的手动解决路径处理新的拓扑。
				await gitFetch(repoPath);
				await gitExec(repoPath, [
					"branch",
					"-f",
					config.branch,
					`origin/${config.branch}`,
				]);
				return { branch, fastForwarded: false, paths };
			}
		} finally {
			await gitExec(repoPath, ["switch", config.branch]);
		}
	}

	/**
	 * rebase 已经把当前设备的改动提交在已配置的 branch 上。
	 * 将该提交发布到设备分支，再把共享 branch 恢复到 origin，
	 * 以便用户显式合并远端的设备分支。
	 */
	private async coordinateDeviceBranchConflict(
		repoPath: string,
		config: PiSyncConfig,
		state: SyncState,
		fallbackPaths?: SyncConflictPath[],
	): Promise<ConflictCoordinationResult> {
		const preservation = await this.preserveConflictOnDeviceBranch(
			repoPath,
			config,
			state,
		);
		if (preservation.fastForwarded) {
			return {
				kind: "resolved",
				message: this.formatFastForwardedConflictMessage(config),
			};
		}
		if (
			await this.mergeDeviceBranchIntoShared(
				repoPath,
				config,
				preservation.branch,
			)
		) {
			return {
				kind: "resolved",
				message: this.formatMergedConflictMessage(config),
			};
		}
		const conflict = await this.createSyncConflictRequest(
			repoPath,
			config,
			preservation.branch,
			preservation.paths.length > 0
				? preservation.paths
				: (fallbackPaths ?? []),
		);
		return {
			kind: "needs_user",
			conflict,
			message: this.formatManualMergeMessage(
				repoPath,
				config,
				preservation.branch,
			),
		};
	}

	private async preserveRebaseConflictOnDeviceBranch(
		repoPath: string,
		config: PiSyncConfig,
	): Promise<string> {
		const branch = await this.getDeviceBranchName();
		await gitRebaseAbort(repoPath);
		await gitExec(repoPath, ["branch", "-f", branch]);
		await gitExec(repoPath, ["switch", branch]);
		try {
			await gitExec(repoPath, [
				"branch",
				"-f",
				config.branch,
				`origin/${config.branch}`,
			]);
			await gitPushDeviceBranch(repoPath, branch);
		} finally {
			await gitExec(repoPath, ["switch", config.branch]);
		}
		return branch;
	}

	// ========== status ==========

	/**
	 * TUI 状态总览所需的结构化快照（docs/tui-prd.md §4.1）。
	 *
	 * 与 status() 的区别是返回**数据而非格式化字符串**——TUI 要自己排版、
	 * 上色，拿到成品文本反而没法用。两者都是只读的，不改仓库或 agent 文件。
	 *
	 * 不做 fetch：这是进入 TUI 和每次动作后都要刷的，带网络请求会让界面发卡。
	 * ahead/behind 反映的是上次 fetch 以来的本机视角，够用于"我该拉还是该推"。
	 */
	async statusSummary(): Promise<TuiStatusSnapshot | null> {
		const lifecycle = await this.inspectLifecycleState();
		if (lifecycle.kind !== "initialized") return null;

		const { repoPath, state } = lifecycle;
		const config = await loadPiSyncConfig(repoPath);
		const [status, inventory] = await Promise.all([
			gitStatus(repoPath, config.branch),
			compareFiles(this.agentDir, repoPath, config, state),
		]);

		const changed = inventory.comparisons.filter(
			(comparison) =>
				comparison.changeType !== "no_change" &&
				comparison.changeType !== "converged",
		);
		// 语义层冲突自己数，不用 inventory.summary——它漏统计了 both_deleted
		// 与两种删改冲突（docs/decision-3-review.md §5 问题 2），
		// UI 不能依赖它判断冲突。
		const conflicts = changed.filter((comparison) =>
			isBilateralConflict(comparison.changeType),
		);

		return {
			branch: status.branch,
			ahead: status.ahead,
			behind: status.behind,
			pendingChanges: changed.length,
			conflicts: conflicts.length,
			autoSyncEnabled: config.autoSync.enabled,
			lastSyncedAt: state.lastSyncedAt ?? null,
		};
	}

	/** 检查本机与远端状态，不改动仓库或 agent 文件。 */
	async needsSync(): Promise<boolean> {
		const lifecycle = await this.inspectLifecycleState();
		if (lifecycle.kind !== "initialized") return false;

		const { repoPath, state } = lifecycle;
		const config = await loadPiSyncConfig(repoPath);
		const [status, inventory, remote] = await Promise.all([
			gitStatus(repoPath, config.branch),
			compareFiles(this.agentDir, repoPath, config, state),
			gitProbe(
				repoPath,
				["ls-remote", "--heads", "origin", `refs/heads/${config.branch}`],
				{ timeout: config.pullTimeoutMs },
			),
		]);
		const remoteCommit = remote.ok
			? remote.stdout.trim().split(/\s+/, 1)[0]
			: undefined;
		const hasConfigurationChanges = inventory.comparisons.some(
			(comparison) => comparison.changeType !== "no_change",
		);

		return Boolean(
			state.pendingOperation ||
				status.branch !== config.branch ||
				status.isRebasing ||
				status.isMerging ||
				status.hasConflicts ||
				status.hasUncommittedChanges ||
				status.ahead > 0 ||
				status.behind > 0 ||
				state.lastSyncedCommit !== status.commit ||
				hasConfigurationChanges ||
				(remoteCommit && remoteCommit !== status.commit),
		);
	}

	async status(repoPath?: string): Promise<string> {
		const rp = repoPath ?? (await getRepoPathSafe());
		if (!rp) return "尚未配置配置仓库，请先运行 /pisync 完成初始化。";

		const config = await loadPiSyncConfig(rp);
		const status = await gitStatus(rp, config.branch);
		const state = await loadState(this.agentDir);

		// 三方比较
		const inventory = await compareFiles(this.agentDir, rp, config, state);

		// 包差异
		let pkgDiff = null;
		try {
			pkgDiff = await getPackageDiff(rp, this.agentDir, config);
		} catch {
			/* 尽力而为 */
		}

		return formatSyncStatusV2({
			repoPath: rp,
			agentDir: this.agentDir,
			gitStatus: status,
			config,
			inventory,
			state,
			pkgDiff: pkgDiff ?? undefined,
		});
	}

	// ========== diff ==========

	async diff(repoPath?: string): Promise<string> {
		const rp = repoPath ?? (await getRepoPathSafe());
		if (!rp) return "尚未配置配置仓库，请先运行 /pisync 完成初始化。";

		const config = await loadPiSyncConfig(rp);
		const status = await gitStatus(rp, config.branch);
		const state = await loadState(this.agentDir);

		// 三方比较
		const inventory = await compareFiles(this.agentDir, rp, config, state);

		const lines: string[] = [];

		// Git 状态
		lines.push("=== Git 状态 ===");
		lines.push(formatGitStatus(status));
		if (status.branch !== config.branch) {
			lines.push(
				`警告：config.branch 为 "${config.branch}"，但仓库当前处于 "${status.branch}"。`,
			);
		}
		lines.push("");

		// Agent ↔ Repo 差异（基于基线）
		lines.push("=== 文件比较 ===");
		lines.push(formatComparisonDiff(inventory.comparisons));
		lines.push("");

		// 远端差异（如果有 ahead/behind）
		if (status.remoteExists) {
			if (status.behind > 0) {
				try {
					await gitFetch(rp);
					const rangeDiff = await gitDiffRange(
						rp,
						status.commit,
						`origin/${config.branch}`,
					);
					if (rangeDiff) {
						lines.push("=== 远端变更（待拉取）===");
						lines.push(rangeDiff);
						lines.push("");
					}
				} catch {
					/* 离线 */
				}
			}
		}

		return lines.join("\n");
	}

	// ========== apply ==========

	async apply(
		repoPath?: string,
		packageApproval?: PackageApproval,
	): Promise<CommandResult> {
		const rp = repoPath ?? (await getRepoPath());
		const config = await loadPiSyncConfig(rp);
		const state = await loadState(this.agentDir);

		return this.withCommandLock<CommandResult>(
			"apply",
			() => this.busyCommandResult(),
			async () => {
				try {
					await ensureConfiguredBranch(rp, config.branch);
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
				return this.applyCurrent(rp, config, state, "apply", packageApproval);
			},
		);
	}

	// ========== pull ==========

	async pull(
		repoPath?: string,
		packageApproval?: PackageApproval,
		onProgress?: RunOptions["onProgress"],
		executionOptions: Pick<RunOptions, "signal" | "onGitCommandStart"> = {},
	): Promise<CommandResult> {
		const rp = repoPath ?? (await getRepoPath());
		const config = await loadPiSyncConfig(rp);
		const state = await loadState(this.agentDir);
		return this.withCommandLock<CommandResult>(
			"pull",
			() => this.busyCommandResult(),
			() =>
				runPullFlow({
					agentDir: this.agentDir,
					repoPath: rp,
					config,
					state,
					packageApproval,
					signal: executionOptions.signal,
					onProgress,
					onGitCommandStart: executionOptions.onGitCommandStart,
					captureLocalChanges: (path, flowConfig, flowState, preferLocal) =>
						this.captureWithScaffoldCalibration(
							path,
							flowConfig,
							flowState,
							preferLocal,
						),
					shouldRefreshLocalCapture: (status, flowState) =>
						this.shouldRefreshLocalCapture(status, flowState),
					preserveRebaseConflict: (path, flowConfig) =>
						this.preserveRebaseConflictOnDeviceBranch(path, flowConfig),
					normalizeChangedFiles: (changedFiles, flowConfig) =>
						this.normalizeRepoChangedFiles(changedFiles, flowConfig),
					applyCurrent: (path, flowConfig, flowState, reason, approval) =>
						this.applyCurrent(path, flowConfig, flowState, reason, approval),
					loadState: () => loadState(this.agentDir),
					saveState: (flowState) => saveState(this.agentDir, flowState),
				}),
		);
	}

	// ========== 直达命令（/pisync pull、/pisync push） ==========

	/**
	 * 直达命令的生命周期前置检查。
	 *
	 * run() 靠 inspectLifecycleState() 拦截未初始化/损坏状态，而 pull()/push()
	 * 只调 getRepoPath()，未初始化时会直接抛错。直达命令自行补这道检查，
	 * 把异常换成可操作的提示（autoSync 也是同样的做法）。
	 */
	private async requireInitialized(): Promise<
		{ ok: true; repoPath: string } | { ok: false; result: RunResult }
	> {
		const lifecycle = await this.inspectLifecycleState();
		if (lifecycle.kind === "initialized") {
			return { ok: true, repoPath: lifecycle.repoPath };
		}
		const message =
			lifecycle.kind === "broken"
				? `同步状态已损坏：${lifecycle.reason}`
				: "尚未初始化同步，请先运行 /pisync 配置配置仓库。";
		return {
			ok: false,
			result: {
				ok: false,
				code: lifecycle.kind === "broken" ? "partial_failure" : "blocked_validation",
				message,
				reload: false,
				mode: lifecycle.kind === "broken" ? "sync" : "setup",
				phase: "preflight",
			},
		};
	}

	/**
	 * 直达命令的包审批：自动批准计划内需要审批的全部包源。
	 *
	 * 见 docs/tui-prd.md §3.3——两个直达命令的信任模型是"完全信任远端仓库"，
	 * 审批交互交由 TUI 承担。这里只批准**本次计划实际要求的**源，
	 * 不写信任记录（remember 保持 false），避免零询问命令悄悄扩大持久信任。
	 */
	private autoApprovalFromResult(
		result: CommandResult,
	): PackageApproval | undefined {
		const details = result.details as { packages?: unknown } | undefined;
		const packages = Array.isArray(details?.packages)
			? details.packages.filter((pkg): pkg is string => typeof pkg === "string")
			: [];
		return packages.length > 0 ? { approvedSources: packages } : undefined;
	}

	/**
	 * `/pisync pull`：智能化拉取（docs/tui-prd.md §3.1）。
	 *
	 * 零询问——包审批自动批准，冲突自动远端优先（由 runPullFlow 内建）。
	 * 不推共享分支；rebase 冲突时仍推设备恢复分支，那是保命写入。
	 *
	 * 包审批采用"先跑、遇审批自动批准后重试"而非预计算：待审批源只有在
	 * fetch 之后才可见，预计算会漏掉远端新引入的包；而首次尝试在写盘前
	 * 即返回，重试是幂等的。
	 */
	async pullOnly(options: RunOptions = {}): Promise<RunResult> {
		return withOperationSignal(options.signal, async () => {
			const ready = await this.requireInitialized();
			if (!ready.ok) return ready.result;

			this.emitProgress(options.onProgress, "pull", "正在拉取远端配置……");
			let result = await this.pull(
				ready.repoPath,
				options.packageApproval,
				options.onProgress,
				{
					signal: options.signal,
					onGitCommandStart: options.onGitCommandStart,
				},
			);
			if (result.code === "approval_required" && !options.packageApproval) {
				const approval = this.autoApprovalFromResult(result);
				if (approval) {
					this.emitProgress(
						options.onProgress,
						"apply",
						"正在自动批准并安装远端包……",
					);
					result = await this.pull(
						ready.repoPath,
						approval,
						options.onProgress,
						{
							signal: options.signal,
							onGitCommandStart: options.onGitCommandStart,
						},
					);
				}
			}
			return {
				...result,
				mode: "sync",
				phase: result.ok ? "complete" : "pull",
				details:
					typeof result.details === "object" && result.details !== null
						? (result.details as RunResult["details"])
						: undefined,
			};
		});
	}

	/**
	 * `/pisync push`：智能化推送（docs/tui-prd.md §3.2）。
	 *
	 * 除冲突外零询问。冲突时返回 blocked_conflict 并携带 conflict 详情，
	 * 由扩展层弹出现有的冲突菜单——这是"快"的唯一破例，理由见 PRD §3.2。
	 *
	 * push 的落地收口若需要包审批（远端 rebase 进来的 settings 引入了新包），
	 * 同样自动批准后用 apply 补完收口——此时共享分支已推送成功，
	 * 剩下的只是基线与包安装的落地。
	 */
	async pushOnly(options: RunOptions = {}): Promise<RunResult> {
		return withOperationSignal(options.signal, async () => {
			const ready = await this.requireInitialized();
			if (!ready.ok) return ready.result;

			this.emitProgress(options.onProgress, "push", "正在推送本机配置……");
			let result = await this.push(ready.repoPath);
			if (result.code === "approval_required" && !options.packageApproval) {
				const approval = this.autoApprovalFromResult(result);
				if (approval) {
					this.emitProgress(
						options.onProgress,
						"apply",
						"正在自动批准并安装远端包……",
					);
					result = await this.apply(ready.repoPath, approval);
				}
			}
			return {
				...result,
				mode: "sync",
				phase: result.ok ? "complete" : "push",
				details:
					typeof result.details === "object" && result.details !== null
						? (result.details as RunResult["details"])
						: undefined,
			};
		});
	}

	// ========== 整机对齐（仅 TUI，docs/tui-prd.md §4.2） ==========

	/**
	 * 预览整机对齐会丢弃哪些内容。
	 *
	 * 确认页必须列出**将丢失的具体路径**而非只报数量（PRD §4.2 要求 1），
	 * 所以这一步必须在执行前单独算出来。
	 *
	 * 先 fetch 再比较：三方比较里的 R 是本地 git 工作区，不 fetch 就看不到
	 * 远端新增的内容，"以本机覆盖远端"会漏报即将被删掉的远端文件——
	 * 破坏性操作的清单漏报比慢一点严重得多。fetch 失败时按当前工作区
	 * 出清单，聊胜于无。
	 */
	async previewOverwrite(
		direction: "pull" | "push",
		repoPath?: string,
	): Promise<string[]> {
		const lifecycle = await this.inspectLifecycleState();
		if (lifecycle.kind !== "initialized") return [];
		const rp = repoPath ?? lifecycle.repoPath;
		const config = await loadPiSyncConfig(rp);

		// 只取远端引用，不动工作区——预览必须是只读的。
		await gitFetch(rp, { timeout: config.pullTimeoutMs }).catch(
			() => undefined,
		);
		const state = await loadState(this.agentDir);
		const inventory = await compareFiles(this.agentDir, rp, config, state);

		// 丢的是哪一侧的改动，取决于对齐方向：
		// 以远端覆盖本机 → 丢本机侧的改动；以本机覆盖远端 → 丢仓库侧的改动。
		// 双边冲突两个方向都会丢掉一侧，所以都要列。
		const losesLocalSide =
			direction === "pull"
				? (changeType: FileChangeType) =>
						changeType === "local_only" ||
						changeType === "local_created" ||
						isBilateralConflict(changeType)
				: (changeType: FileChangeType) =>
						changeType === "remote_only" ||
						changeType === "remote_created" ||
						isBilateralConflict(changeType);

		const worktreeLosses = inventory.comparisons
			.filter((comparison) => losesLocalSide(comparison.changeType))
			.map((comparison) => comparison.relativePath);

		// 以本机覆盖远端时，工作区之外还有一类损失：远端已提交、但本机
		// 尚未 fetch 进工作区的改动。上面的比较看不到它们，需要问 git。
		if (direction === "push") {
			const remoteOnlyCommits = await gitProbe(rp, [
				"diff",
				"--name-only",
				`HEAD...origin/${config.branch}`,
			]);
			if (remoteOnlyCommits.ok) {
				const prefix = `${config.root}/`;
				for (const line of remoteOnlyCommits.stdout.split("\n")) {
					const path = line.trim();
					if (path.startsWith(prefix)) {
						worktreeLosses.push(path.slice(prefix.length));
					}
				}
			}
		}

		return [...new Set(worktreeLosses)].sort();
	}

	/**
	 * 「以远端覆盖本机」：丢弃本机全部未推送改动，本机变成远端当前的样子。
	 *
	 * 与智能化拉取的区别是**结果确定**——不需要理解三方比较就能预期
	 * （PRD §4.2）。实现上先 pull 把远端取到工作区，再以 mirrorRemote 落地。
	 *
	 * 先 pull 的原因：镜像的对象是"远端当前的样子"，而三方比较里的 R 是
	 * 本地 git 工作区，不 fetch 就只能镜像到上次拉取的状态。
	 *
	 * 落地前仍走自动备份（apply 事务的固有步骤），rebase 冲突时仍推设备
	 * 恢复分支——这两条是 PRD §4.2 要求 3，靠复用既有链路自动满足。
	 */
	async overwriteFromRemote(options: RunOptions = {}): Promise<RunResult> {
		return withOperationSignal(options.signal, async () => {
			const ready = await this.requireInitialized();
			if (!ready.ok) return ready.result;

			const rp = ready.repoPath;
			this.emitProgress(options.onProgress, "pull", "正在获取远端配置……");
			// 先把远端取到工作区。这一步可能报 Git 冲突，那时按 D9 转交，
			// 不在这里自行合并。
			const pulled = await this.pull(rp, options.packageApproval, options.onProgress, {
				signal: options.signal,
				onGitCommandStart: options.onGitCommandStart,
			});
			const conflict =
				pulled.details && typeof pulled.details === "object"
					? (pulled.details as { conflict?: unknown }).conflict
					: undefined;
			if (isSyncConflictRequest(conflict)) {
				return {
					...pulled,
					mode: "sync",
					phase: "pull",
					details: pulled.details as RunResult["details"],
				};
			}

			this.emitProgress(options.onProgress, "apply", "正在以远端覆盖本机……");
			const config = await loadPiSyncConfig(rp);
			const state = await loadState(this.agentDir);
			const result = await this.withCommandLock<CommandResult>(
				"overwrite-from-remote",
				() => this.busyCommandResult(),
				() =>
					this.applyCurrent(
						rp,
						config,
						state,
						"overwrite-from-remote",
						options.packageApproval ??
							this.autoApprovalFromResult(pulled),
						false,
						undefined,
						true,
					),
			);
			return {
				...result,
				mode: "sync",
				phase: result.ok ? "complete" : "apply",
				details:
					typeof result.details === "object" && result.details !== null
						? (result.details as RunResult["details"])
						: undefined,
			};
		});
	}

	/**
	 * 「以本机覆盖远端」：远端变成本机当前的样子，含删除远端独有的文件。
	 *
	 * 顺序是先把远端取进工作区、再以本机内容镜像覆盖、最后走常规 push。
	 *
	 * **为什么必须先取远端**：capture 写的是本地 git 工作区，而三方比较里的
	 * R 也是工作区。若跳过这一步，工作区停留在上次拉取的状态，于是
	 * （1）远端新增的文件在比较中根本不出现，镜像删不掉它们；
	 * （2）随后的 push 会因为落后于远端而 rebase，撞上本机的镜像改动产生
	 * Git 冲突——用户明明选了"以本机覆盖远端"，却收到一个冲突提示。
	 * 先快进到远端，再用本机内容整体覆盖，push 就是一次直路推进。
	 *
	 * 快进用 --ff-only：这里只想把工作区对齐到远端起点，不想产生合并提交。
	 * 本机若有未推送的提交导致快进失败，说明状态需要人介入，按 D9 转交而非
	 * 自行 reset——仓库明确禁止 reset --hard 这类不可逆操作。
	 *
	 * Git 冲突仍按 D9 转交，不自行合并。
	 */
	async overwriteFromLocal(options: RunOptions = {}): Promise<RunResult> {
		return withOperationSignal(options.signal, async () => {
			const ready = await this.requireInitialized();
			if (!ready.ok) return ready.result;

			const rp = ready.repoPath;
			const config = await loadPiSyncConfig(rp);

			this.emitProgress(options.onProgress, "push", "正在获取远端状态……");
			const prepared = await this.withCommandLock<CommandResult | null>(
				"overwrite-from-local",
				() => this.busyCommandResult(),
				async () => {
					try {
						await ensureConfiguredBranch(rp, config.branch);
						await gitFetch(rp, {
							timeout: config.pullTimeoutMs,
							signal: options.signal,
						});
						// 先对齐到远端起点，让 capture 能看到远端全部内容。
						await gitFastForward(rp, config.branch, {
							timeout: config.pullTimeoutMs,
							signal: options.signal,
						});
					} catch (error) {
						return {
							ok: false,
							code: "blocked_conflict" as const,
							message: [
								"无法把仓库快进到远端最新状态，已停止，未做任何改动。",
								"这通常意味着本机仓库有未推送的提交或处于中断状态。",
								"请先运行 /pisync 处理，或在配置仓库中手动解决后重试。",
								"",
								error instanceof Error ? error.message : "未知错误",
							].join("\n"),
							reload: false,
						};
					}

					this.emitProgress(
						options.onProgress,
						"push",
						"正在以本机内容覆盖仓库……",
					);
					// 快进后基线可能已落后于工作区，重新读一次再比较。
					const state = await loadState(this.agentDir);
					const capture = await captureChanges(
						this.agentDir,
						rp,
						config,
						state,
						{ mirrorLocal: true },
					);
					if (capture.errors.length > 0) {
						return {
							ok: false,
							code: "partial_failure" as const,
							message: `捕获本机配置失败：${capture.errors
								.map((error) => `${error.file}：${error.message}`)
								.join("；")}`,
							reload: false,
						};
					}
					return null;
				},
			);
			if (prepared !== null) {
				return {
					...prepared,
					mode: "sync",
					phase: "push",
					details:
						typeof prepared.details === "object" && prepared.details !== null
							? (prepared.details as RunResult["details"])
							: undefined,
				};
			}

			// 工作区已是本机的样子，其余交给常规 push 链路
			// （commit / rebase / 推共享分支 + 设备分支 / 落地收口）。
			this.emitProgress(options.onProgress, "push", "正在推送到远端……");
			const result = await this.push(rp);
			if (result.code === "approval_required" && !options.packageApproval) {
				const approval = this.autoApprovalFromResult(result);
				if (approval) {
					return {
						...(await this.apply(rp, approval)),
						mode: "sync",
						phase: "complete",
					} as RunResult;
				}
			}
			return {
				...result,
				mode: "sync",
				phase: result.ok ? "complete" : "push",
				details:
					typeof result.details === "object" && result.details !== null
						? (result.details as RunResult["details"])
						: undefined,
			};
		});
	}

	/**
	 * 切换 autoSync 开关，返回切换后的值（docs/tui-prd.md §4.1 的设置项）。
	 *
	 * 开关存在**仓库文件** pi-sync.json 里，所以改完是一次待推送的本机改动，
	 * 不在这里自动推送——TUI 的设置项应当只做它说的那件事，顺带 push 会
	 * 越权。用户下次同步时它会跟着走。
	 */
	async toggleAutoSync(repoPath?: string): Promise<boolean> {
		const lifecycle = await this.inspectLifecycleState();
		if (lifecycle.kind !== "initialized") {
			throw new Error("同步尚未初始化，无法切换自动同步。");
		}
		const rp = repoPath ?? lifecycle.repoPath;
		const config = await loadPiSyncConfig(rp);
		const next = !config.autoSync.enabled;
		await setAutoSyncEnabledInConfig(rp, next);
		return next;
	}

	// ========== autoSync ==========

	/**
	 * 自动同步单次检查（design.md §6）：单向 git 为权威，不自动 push。
	 *
	 * 仅当仓库有更新（R≠B）且本机无未推送漂移（L≈B）时静默 pull/apply；
	 * 本机有漂移或冲突时跳过本次，留待手动 /pisync。
	 *
	 * 返回描述本次结果的摘要，供定时器决定是否需要 reload 提示。
	 */
	async autoSyncOnce(repoPath?: string): Promise<AutoSyncOutcome> {
		// 同进程互斥：withCommandLock 对本实例已持锁的调用会重入短路（不再取文件锁），
		// 而 autoSync 定时器与 /pisync 命令共用同一个实例。若手动 run() 正在执行，
		// 下方的 pull() 会命中那条短路直通执行，绕过文件锁——所以这里必须先自查。
		// 文件锁只能挡住跨进程竞争，挡不住同进程重入。
		if (this.orchestrationLockHeld) {
			return {
				status: "skipped",
				reason: "busy",
				message: "已有同步操作正在进行。",
			};
		}
		const lifecycle = await this.inspectLifecycleState();
		if (lifecycle.kind !== "initialized") {
			return { status: "skipped", reason: "uninitialized", message: "同步尚未初始化。" };
		}
		const rp = repoPath ?? lifecycle.repoPath;
		const config = await loadPiSyncConfig(rp);
		if (!config.autoSync.enabled) {
			return { status: "skipped", reason: "disabled", message: "autoSync 已禁用。" };
		}
		const state = await loadState(this.agentDir);

		// 快速健康检查（只读，不持锁；真正的同步由下方 pull() 内的 withCommandLock 提供防重入）
		const status = await gitStatus(rp, config.branch);
		if (status.isRebasing || status.isMerging || status.hasConflicts) {
			return { status: "skipped", reason: "conflict_state", message: "仓库处于冲突中，请手动运行 /pisync。" };
		}
		// 仓库未同步到工作树之外（如中断状态）时跳过。
		if (status.hasUncommittedChanges) {
			return { status: "skipped", reason: "dirty_worktree", message: "仓库工作区有未提交改动，请手动运行 /pisync。" };
		}
		// 本机有未推送提交或待恢复操作时跳过（绝不 auto-push）。
		if (status.ahead > 0 || state.pendingOperation) {
			return { status: "skipped", reason: "drift", message: "存在待推送的本机提交或需要恢复操作，请手动运行 /pisync。" };
		}

		// fetch 远端，判定 R≠B
		try {
			await gitFetch(rp, { timeout: config.pullTimeoutMs });
		} catch {
			return { status: "skipped", reason: "offline", message: "git fetch 失败，将在下个周期重试。" };
		}

		// fetch 后重读状态：behind>0 表示远端有新提交（R≠B）
		const fetchedStatus = await gitStatus(rp, config.branch);
		const hasRemoteUpdate = fetchedStatus.behind > 0;

		// 三方比较：检测本机漂移（L≠B）——autoSync 绝不吞本机未推送改动。
		const inventory = await compareFiles(this.agentDir, rp, config, state);
		const hasLocalDrift = inventory.comparisons.some((comparison) =>
			[
				"local_only",
				"local_created",
				"local_deleted",
				"both_modified",
				"local_modified_remote_deleted",
				"local_deleted_remote_modified",
			].includes(comparison.changeType),
		);

		if (hasLocalDrift) {
			return { status: "skipped", reason: "drift", message: "存在本机未推送的改动，请手动运行 /pisync。" };
		}
		if (!hasRemoteUpdate) {
			return { status: "skipped", reason: "no_update", message: "仓库已是最新。" };
		}

		// 满足 R≠B 且 L≈B：静默执行 pull（P2 远端优先已内建；withCommandLock 防重入）。
		const result = await this.pull(rp);
		if (result.ok) {
			return {
				status: "applied",
				reason: "applied",
				message: result.message,
				reload: result.reload,
			};
		}
		if (result.code === "partial_failure" && result.message.includes("已有同步操作")) {
			return { status: "skipped", reason: "busy", message: "已有同步操作正在进行。" };
		}
		// pull 需要审批/选择/冲突处理等交互时，静默跳过，不打扰。
		return { status: "skipped", reason: "needs_interaction", message: result.message };
	}

	// ========== push ==========

	/**
	 * 准备 push：捕获变更、校验内容并生成稳定指纹，但不 commit/push。
	 * prepare 结束后 repo 工作树保持可供用户检查和取消后重试。
	 */
	async preparePush(repoPath?: string): Promise<PushPreparation> {
		const rp = repoPath ?? (await getRepoPath());
		const config = await loadPiSyncConfig(rp);
		const state = await loadState(this.agentDir);
		return this.withCommandLock<PushPreparation>(
			"push-prepare",
			() => ({
				kind: "blocked",
				capture: {
					captured: [],
					deleted: [],
					errors: [],
					hasConflicts: false,
					conflicts: [],
				},
				changedFiles: [],
				diff: "",
				repoHead: "",
				worktreeFingerprint: "",
				repoPath: rp,
				branch: config.branch,
				message: "已有同步操作正在进行。",
			}),
			() =>
				preparePushFlow({
					agentDir: this.agentDir,
					repoPath: rp,
					config,
					state,
					captureLocalChanges: this.captureWithScaffoldCalibration.bind(this),
					shouldRefreshLocalCapture: this.shouldRefreshLocalCapture.bind(this),
					coordinateConflict: this.coordinateDeviceBranchConflict.bind(this),
					applyCurrent: this.applyCurrent.bind(this),
					normalizeChangedFiles: this.normalizeRepoChangedFiles.bind(this),
					computeFingerprint: this.computePushFingerprint.bind(this),
					loadState: () => loadState(this.agentDir),
					preserveRebaseConflict:
						this.preserveRebaseConflictOnDeviceBranch.bind(this),
					mergeDeviceBranchIntoShared:
						this.mergeDeviceBranchIntoShared.bind(this),
					createConflictRequest: this.createSyncConflictRequest.bind(this),
					formatManualMergeMessage: this.formatManualMergeMessage.bind(this),
					formatMergedConflictMessage:
						this.formatMergedConflictMessage.bind(this),
					pushMainAndDeviceBranches: this.pushMainAndDeviceBranches.bind(this),
				}),
		);
	}

	/** 执行已确认的 preparation，并在执行前重新校验 HEAD/worktree 指纹。 */
	async executePush(
		preparation: PushPreparation,
		message?: string,
	): Promise<CommandResult> {
		if (preparation.kind !== "ready") return resultFromPreparation(preparation);
		const rp = preparation.repoPath;
		const config = await loadPiSyncConfig(rp);
		const state = await loadState(this.agentDir);
		return this.withCommandLock<CommandResult>(
			"push",
			() => this.busyCommandResult(),
			() =>
				executePushFlow(
					{
						agentDir: this.agentDir,
						repoPath: rp,
						config,
						state,
						captureLocalChanges: this.captureWithScaffoldCalibration.bind(this),
						shouldRefreshLocalCapture:
							this.shouldRefreshLocalCapture.bind(this),
						coordinateConflict: this.coordinateDeviceBranchConflict.bind(this),
						applyCurrent: this.applyCurrent.bind(this),
						normalizeChangedFiles: this.normalizeRepoChangedFiles.bind(this),
						computeFingerprint: this.computePushFingerprint.bind(this),
							loadState: () => loadState(this.agentDir),
						preserveRebaseConflict:
							this.preserveRebaseConflictOnDeviceBranch.bind(this),
						mergeDeviceBranchIntoShared:
							this.mergeDeviceBranchIntoShared.bind(this),
						createConflictRequest: this.createSyncConflictRequest.bind(this),
						formatManualMergeMessage: this.formatManualMergeMessage.bind(this),
						formatMergedConflictMessage:
							this.formatMergedConflictMessage.bind(this),
						pushMainAndDeviceBranches:
							this.pushMainAndDeviceBranches.bind(this),
					},
					preparation,
					message,
				),
		);
	}

	async push(
		repoPath?: string,
		message?: string,
		subCommand?: string,
	): Promise<CommandResult> {
		if (subCommand === "--continue") {
			return this.pushContinue(repoPath);
		}
		const preparation = await this.preparePush(repoPath);
		if (preparation.kind === "noop") {
			try {
				const status = await gitStatus(preparation.repoPath);
				const hasAheadCommit = status.ahead > 0;
				if (hasAheadCommit) {
					await this.pushMainAndDeviceBranches(
						preparation.repoPath,
						preparation.branch,
					);
				} else {
					const deviceBranch = await this.getDeviceBranchName();
					const remoteDeviceRef = await gitProbe(preparation.repoPath, [
						"show-ref",
						"--hash",
						"--verify",
						`refs/remotes/origin/${deviceBranch}`,
					]);
					if (
						!remoteDeviceRef.ok ||
						remoteDeviceRef.stdout.trim() !== status.commit
					) {
						await gitPushHeadToBranch(preparation.repoPath, deviceBranch);
					}
				}
				return {
					ok: true,
					code: hasAheadCommit ? "ok" : "noop",
					message: hasAheadCommit
						? "工作区无改动；已把领先的提交同步到共享 branch 与设备分支。"
						: (preparation.message ??
							"没有需要 push 的改动，main 与设备分支已同步。"),
					reload: false,
				};
			} catch (error) {
				return {
					ok: false,
					code: "git_failed",
					message: `无法同步 main 与设备分支：${error instanceof Error ? error.message : "未知错误"}`,
					reload: false,
				};
			}
		}
		if (preparation.kind !== "ready") {
			return {
				ok: false,
				code: "blocked_conflict",
				message: preparation.message ?? "push 被阻止。",
				reload: false,
			};
		}
		const result = await this.executePush(preparation, message);
		return result;
	}

	/**
	 * push --continue：解决冲突后继续推送
	 */
	private async pushContinue(repoPath?: string): Promise<CommandResult> {
		const rp = repoPath ?? (await getRepoPath());
		const config = await loadPiSyncConfig(rp);
		const state = await loadState(this.agentDir);

		if (state.pendingOperation?.type !== "push-rebase-conflict") {
			return noopResult("没有待继续的 push 操作。");
		}

		return this.withCommandLock<CommandResult>(
			"push-continue",
			() => this.busyCommandResult(),
			async () => {
				try {
					await ensureConfiguredBranch(rp, config.branch);
				} catch (error) {
					return conflictResult(
						error instanceof Error
							? error.message
							: "已配置 branch 的检查失败。",
					);
				}

				// 1. 确认无 unmerged paths
				if (await hasUnmergedPaths(rp)) {
					return conflictResult(
						"仍存在未合并的路径，请先解决全部冲突并运行 git add + git rebase --continue。",
					);
				}

				// 2. 确认工作树干净
				if (!(await isWorktreeClean(rp))) {
					return conflictResult(
						"工作区不干净，请先 commit 或 stash 改动。",
					);
				}

				// 3. 校验最终提交
				await gitDiffRange(rp, `origin/${config.branch}`, "HEAD").catch(
					() => "",
				);
				const allRepoSyncFiles = await this.getRepoSyncFiles(rp, config);

				const validation = await validateFiles(
					this.agentDir,
					rp,
					config,
					allRepoSyncFiles,
				);
				if (validation.blocked) {
					return failureResult(
						"blocked_validation",
						`解决冲突后仍存在校验错误：\n${formatValidationErrors(validation.errors)}`,
					);
				}

				// 4. 定制：无秘密扫描（design.md §3）。
				// 5. 推送共享 branch 与当前设备的快照分支。
				try {
					await this.pushMainAndDeviceBranches(rp, config.branch);
				} catch (err) {
					return failureResult(
						"git_failed",
						`push 失败：${err instanceof Error ? err.message : "未知错误"}`,
					);
				}

				// 6. Apply + 更新状态
				const newState = { ...state, pendingOperation: null };
				await saveState(this.agentDir, newState);

				const applyResult = await this.applyCurrent(
					rp,
					config,
					newState,
					"push",
				);

				if (!applyResult.ok) {
					return {
						...applyResult,
						message:
							"push 已继续完成，但应用同步后的配置失败。\n" +
							applyResult.message,
						reload: false,
					};
				}
				return successResult(
					`push 继续执行成功。\n${applyResult.message}`,
					applyResult.reload,
				);
			},
		);
	}

	// ========== init (统一入口) ==========

	async init(
		gitUrl?: string,
		onProgress?: (message: string) => void,
		force = false,
		packageApproval?: PackageApproval,
	): Promise<InitResult> {
		const defaultPath = join(this.agentDir, "..", "config-repo");

		// 已初始化：直接 apply（force 时跳过，走 fresh 流程）
		if (!force && (await this.isAlreadyInitialized(defaultPath))) {
			return normalizeInitResult(
				await this.initAlreadyInitialized(
					defaultPath,
					onProgress,
					packageApproval,
				),
			);
		}

		// 未初始化 — 需要 gitUrl
		if (!gitUrl) {
			return normalizeInitResult({
				message:
					"请运行 /pisync 并输入你的配置仓库 Git URL 以开始。",
				needsReload: false,
				ok: false,
				code: "blocked_validation",
				details: { needsGitUrl: true },
				level: "info",
			});
		}

		// 校验 URL 格式
		if (!isValidSetupGitUrl(gitUrl)) {
			return normalizeInitResult({
				message:
					`无效的 Git URL：${gitUrl}\n` +
					"期望的格式：\n" +
					"  git@github.com:user/repo.git\n" +
					"  https://github.com/user/repo.git",
				needsReload: false,
				ok: false,
				code: "blocked_validation",
				level: "error",
			});
		}

		return normalizeInitResult(
			await this.initFresh(
				gitUrl,
				defaultPath,
				onProgress,
				force,
				packageApproval,
			),
		);
	}

	private async initAlreadyInitialized(
		defaultPath: string,
		onProgress?: (message: string) => void,
		packageApproval?: PackageApproval,
	): Promise<InitInternalResult> {
		const acquired = await this.lock.acquire("apply", 5000);
		if (!acquired) {
			return {
				message: "已有同步操作正在进行。",
				needsReload: false,
				ok: false,
				level: "warning",
			};
		}

		try {
			const config = await loadPiSyncConfig(defaultPath);

			// 拉取最新变更
			onProgress?.("正在拉取最新变更……");
			try {
				await gitFetch(defaultPath);
			} catch {
				/* 离线 */
			}

			try {
				await ensureConfiguredBranch(defaultPath, config.branch);
			} catch (error) {
				return {
					message:
						error instanceof Error
							? error.message
							: "已配置 branch 的检查失败。",
					needsReload: false,
					ok: false,
					code: "blocked_conflict",
					level: "error",
				};
			}

			const status = await gitStatus(defaultPath);
			if (status.behind > 0) {
				onProgress?.("正在快进已拉取的变更……");
				await gitFastForward(defaultPath, config.branch, {
					timeout: config.pullTimeoutMs,
				});
			}

			onProgress?.("正在将配置应用到 agent……");
			const state = await loadState(this.agentDir);
			const applyResult = await this.applyCurrent(
				defaultPath,
				config,
				state,
				"init",
				packageApproval,
			);

			return {
				message: `已完成初始化，已应用当前配置。\n${applyResult.message}`,
				needsReload: applyResult.reload,
				ok: applyResult.ok,
				code: applyResult.code,
				details: applyResult.details,
				level: applyResult.ok ? "info" : "warning",
			};
		} finally {
			await this.lock.release();
		}
	}

	private async initFresh(
		gitUrl: string,
		defaultPath: string,
		onProgress?: (message: string) => void,
		force = false,
		packageApproval?: PackageApproval,
	): Promise<InitInternalResult> {
		const acquired = await this.lock.acquire("init", 5000);
		if (!acquired) {
			return {
				message: "已有同步操作正在进行。",
				needsReload: false,
				ok: false,
				level: "warning",
			};
		}

		try {
			return await executeSetupFlow({
				agentDir: this.agentDir,
				gitUrl,
				repoPath: defaultPath,
				force,
				packageApproval,
				onProgress,
				dependencies: {
					captureInitialLocalConfig: this.captureInitialLocalConfig.bind(this),
					createRepositoryBaseline: this.createRepositoryBaseline.bind(this),
					applyCurrent: this.applyCurrent.bind(this),
					getDeviceBranchName: this.getDeviceBranchName.bind(this),
					pushMainAndDeviceBranches: this.pushMainAndDeviceBranches.bind(this),
				},
			});
		} finally {
			await this.lock.release();
		}
	}

	private async isAlreadyInitialized(_repoPath: string): Promise<boolean> {
		try {
			const state = await loadState(this.agentDir);
			if (!state.repoPath || !existsSync(state.repoPath)) return false;
			if (!existsSync(join(state.repoPath, ".git"))) return false;
			if (!existsSync(join(state.repoPath, "pi-sync.json"))) return false;
			return true;
		} catch {
			return false;
		}
	}

	// ========== debug: clear-repo ==========

	async clearRepo(repoPath?: string): Promise<CommandResult> {
		const rp = repoPath ?? (await getRepoPathSafe());
		if (!rp) {
			return failureResult("blocked_validation", "尚未配置配置仓库。");
		}

		const acquired = await this.lock.acquire("clear-repo", 5000);
		if (!acquired) {
			return failureResult(
				"partial_failure",
				"已有同步操作正在进行。",
			);
		}

		try {
			const lines: string[] = [];
			const config = await loadPiSyncConfig(rp);
			await ensureConfiguredBranch(rp, config.branch);
			// 1. 清空本地仓库内容（保留 .git）
			lines.push("正在清空本地仓库内容……");
			await clearRepoContents(rp);

			// 2. 提交清空操作
			lines.push("正在提交清空操作……");
			await gitExec(rp, ["add", "-A"]);
			await gitExec(rp, ["commit", "-m", "debug: 清空仓库", "--allow-empty"]);

			// 3. 强制推送到远端以清空远端仓库
			lines.push("正在强制推送到远端……");
			await gitExec(rp, ["push", "--force", "origin", config.branch]);

			// 4. 清空本地同步状态
			lines.push("正在清空本机同步状态……");
			await saveState(this.agentDir, {
				schemaVersion: 3,
				repoPath: "",
				branch: "main",
				lastSyncedCommit: null,
				lastSyncedAt: null,
				files: {},
				pendingOperation: null,
				lastBackup: null,
				deviceId: null,
			});

			lines.push("仓库已清空（本地 + 远端）。");
			return successResult(lines.join("\n"), true);
		} catch (err) {
			return failureResult(
				"partial_failure",
				`清空仓库失败：${err instanceof Error ? err.message : "未知错误"}`,
			);
		} finally {
			await this.lock.release();
		}
	}

	// ========== Private: applyCurrent ==========

	/**
	 * 将当前 repo 状态应用到 agent（v0.2: 使用完整 nextBaseline 替换）
	 */
	/**
	 * 仅对发起初始化的机器，把刚生成脚手架的仓库当作基线。
	 * 这样“本机 settings.json + 脚手架占位内容”会被识别为纯本机改动，
	 * 首次捕获便能安全保留用户配置，而不会写入残缺的基线。
	 */
	private async captureInitialLocalConfig(
		repoPath: string,
		config: PiSyncConfig,
	): Promise<Awaited<ReturnType<typeof captureChanges>>> {
		const emptyState: SyncState = {
			schemaVersion: 3,
			repoPath,
			branch: config.branch,
			lastSyncedCommit: null,
			lastSyncedAt: null,
			files: {},
			pendingOperation: null,
			lastBackup: null,
			deviceId: null,
		};
		const scaffoldState = await this.createRepositoryBaseline(
			repoPath,
			config,
			emptyState,
		);
		return captureChanges(this.agentDir, repoPath, config, scaffoldState);
	}

	/**
	 * 修复历史遗留的首次脚手架，同时不让既有仓库产生歧义：
	 * 只有“未初始化状态 + 与生成物完全一致的 settings 占位内容”
	 * 才会被当作以本机为源的引导场景。
	 */
	private async captureWithScaffoldCalibration(
		repoPath: string,
		config: PiSyncConfig,
		state: SyncState,
		preferLocalOnConflicts = false,
	): Promise<Awaited<ReturnType<typeof captureChanges>>> {
		const shouldCalibrate =
			state.lastSyncedCommit === null &&
			state.pendingOperation === null &&
			Object.keys(state.files).length === 0 &&
			(await this.hasScaffoldSettingsPlaceholder(repoPath, config));
		const captureState = shouldCalibrate
			? await this.createRepositoryBaseline(repoPath, config, state)
			: state;

		const keepLocalPaths = this.activeSelections?.keepLocalPaths;
		return captureChanges(this.agentDir, repoPath, config, captureState, {
			preferLocalOnConflicts,
			keepLocalPaths: keepLocalPaths ? new Set(keepLocalPaths) : undefined,
		});
	}

	/**
	 * 若工作区有未提交改动、且所在 commit 正是基线记录的那个，
	 * 说明其中是本机捕获的暂存内容，而非仓库侧的已提交改动。
	 * 此时从 agent 重新刷新，避免重试把本设备的两份快照误判为双侧冲突。
	 * 已提交的 HEAD 改动仍走严格比较。
	 */
	private shouldRefreshLocalCapture(
		status: Awaited<ReturnType<typeof gitStatus>>,
		state: SyncState,
	): boolean {
		return (
			status.hasUncommittedChanges &&
			state.lastSyncedCommit !== null &&
			status.commit === state.lastSyncedCommit
		);
	}

	private async hasScaffoldSettingsPlaceholder(
		repoPath: string,
		config: PiSyncConfig,
	): Promise<boolean> {
		try {
			const syncRoot = await resolveRepoSyncRoot(repoPath, config.root, "read");
			const settingsPath = await resolveWithinRoot(
				syncRoot,
				"settings.json",
				"read",
			);
			const parsed: unknown = JSON.parse(await readFile(settingsPath, "utf-8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
				return false;

			const settings = parsed as Record<string, unknown>;
			return (
				Object.keys(settings).length === 1 &&
				Array.isArray(settings.packages) &&
				settings.packages.length === 1 &&
				settings.packages[0] === "npm:@xyzensun/pi-sync"
			);
		} catch {
			return false;
		}
	}

	private async createRepositoryBaseline(
		repoPath: string,
		config: PiSyncConfig,
		state: SyncState,
	): Promise<SyncState> {
		const inventory = await compareFiles(this.agentDir, repoPath, config, {
			...state,
			files: {},
		});
		return {
			...state,
			files: Object.fromEntries(
				inventory.comparisons.flatMap((comparison) =>
					comparison.remote
						? [
								[
									comparison.relativePath,
									{
										sha256: comparison.remote.sha256,
										mode: comparison.remote.mode,
									},
								],
							]
						: [],
				),
			),
		};
	}

	private async applyCurrent(
		rp: string,
		config: PiSyncConfig,
		state: SyncState,
		reason: string,
		packageApproval?: PackageApproval,
		automaticConflictResolutionAttempted = false,
		useRemoteForConflicts?: ReadonlySet<string>,
		/**
		 * 整机对齐到远端（docs/tui-prd.md §4.2）。透传给 planMaterialize，
		 * 使冲突不再阻断、本机独有文件被删除。其余链路（备份、包安装、
		 * 基线收口）与常规 apply 完全一致，故在此复用而非另起流程。
		 */
		mirrorRemote = false,
	): Promise<CommandResult> {
		const commit = await getHeadCommit(rp);
		const selections = this.activeSelections;

		// 1. 只读比较，确定 settings.json 变更方向。包的安装/卸载只在
		//    “远端 settings 变更待应用”时才有效；本机待推送的 settings 差异
		//    （如本机新装包尚未推送）不得被误当作远端指令。
		const inventory = await compareFiles(this.agentDir, rp, config, state);
		const settingsComparison = inventory.comparisons.find(
			(comparison) => comparison.relativePath === "settings.json",
		);
		const settingsIncoming =
			(settingsComparison !== undefined &&
				(settingsComparison.changeType === "remote_only" ||
					settingsComparison.changeType === "remote_created" ||
					settingsComparison.changeType === "remote_deleted")) ||
			useRemoteForConflicts?.has("settings.json") === true;

		// 2. 只读取并计划 package 变化。审批必须发生在 settings 写入前，
		//    但实际安装要延迟到 materialize 成功之后。
		let packagePlan: Awaited<ReturnType<typeof preparePackagePlan>>;
		try {
			packagePlan = await preparePackagePlan(rp, this.agentDir, config);
		} catch (error) {
			return {
				ok: false,
				code: "blocked_validation",
				message: `包校验失败：${error instanceof Error ? error.message : "未知错误"}`,
				reload: false,
			};
		}

		if (
			reason === "pull" &&
			selections?.reviewed === true &&
			hasUnreviewedIncomingItems(
				inventory,
				packagePlan,
				settingsIncoming,
				selections,
			)
		) {
			return {
				ok: false,
				code: "selection_required",
				message:
					"应用拉取到的配置前，需要先做出扩展选择。",
				reload: false,
				details: {
					extensionSelection: buildExtensionSelectionRequest(
						inventory,
						packagePlan,
						settingsIncoming,
					),
				},
			};
		}

		// 3. 由用户逐项选择推导安装/卸载/推迟计划。只信任当前 plan 中真实
		//    存在的项；选择中的未知条目一律忽略，绝不凭空产生新动作。
		const incomingSources = [
			...packagePlan.added.map((entry) => entry.source),
			...packagePlan.changed.map((entry) => entry.remote.source),
		].filter((source) => source !== BUILTIN_SYNC_PACKAGE);
		const approvedInstalls =
			selections?.installPackages?.filter((source) =>
				incomingSources.includes(source),
			) ?? [];
		// 显式的交互式审批同样算作安装决定；
		// 只有两种机制都未批准的包源才会被推迟。
		const approvedSources = new Set([
			...approvedInstalls,
			...(packageApproval?.approvedSources ?? []),
		]);
		const deferredPackages =
			settingsIncoming && selections
				? incomingSources.filter(
						(source) => !approvedSources.has(source),
				)
				: [];
		const confirmedRemovals =
			settingsIncoming && deferredPackages.length === 0
				? (selections?.removePackages ?? []).filter((source) =>
						packagePlan.removed.some(
							(entry) => entry.source === source,
						),
				)
				: [];
		const deferApplyPaths = new Set<string>(selections?.deferApplyPaths ?? []);
		if (deferredPackages.length > 0) deferApplyPaths.add("settings.json");

		// 4. 生成 apply 计划（包含完整 nextBaseline），复用上面的三方比较。
		const plan = await planMaterialize(this.agentDir, rp, config, state, {
			useRemoteForConflicts,
			deferApplyPaths: deferApplyPaths.size > 0 ? deferApplyPaths : undefined,
			inventory,
			mirrorRemote,
		});

		if (plan.blocked) {
			const errorLines: string[] = [];
			let conflictRequest: SyncConflictRequest | undefined;
			if (plan.conflicts.length > 0 && automaticConflictResolutionAttempted) {
				return {
					ok: false,
					code: "blocked_conflict",
					message: `自动解决后仍存在冲突：${plan.conflicts.map((conflict) => conflict.relativePath).join("、")}`,
					reload: false,
					details: { conflicts: plan.conflicts },
				};
			}
			// P2（design.md §5）：pull 场景下 apply 三方冲突也默认远端优先覆盖本机，
			// 无需创建设备分支或等用户手动。
			if (
				plan.conflicts.length > 0 &&
				reason === "pull" &&
				!automaticConflictResolutionAttempted
			) {
				const remoteFirst = new Set<string>([
					...(useRemoteForConflicts ?? []),
					...plan.conflicts.map((conflict) => conflict.relativePath),
				]);
				return await this.applyCurrent(
					rp,
					config,
					state,
					reason,
					packageApproval,
					true,
					remoteFirst,
				);
			}
			if (plan.conflicts.length > 0) {
				try {
					const coordination = await this.coordinateDeviceBranchConflict(
						rp,
						config,
						state,
						conflictPathsFrom(plan.conflicts),
					);
					if (coordination.kind === "resolved") {
						const resolved = await this.applyCurrent(
							rp,
							config,
							state,
							reason,
							packageApproval,
							true,
						);
						return {
							...resolved,
							message: `${coordination.message}\n${resolved.message}`,
						};
					}
					conflictRequest = coordination.conflict;
					errorLines.push(coordination.message);
				} catch (error) {
					errorLines.push(
						`无法创建当前设备的冲突分支：${error instanceof Error ? error.message : "未知错误"}`,
					);
				}
			}
			if (plan.validationErrors.length > 0) {
				errorLines.push(formatValidationErrors(plan.validationErrors));
			}
			return {
				ok: false,
				code:
					plan.conflicts.length > 0 ? "blocked_conflict" : "blocked_validation",
				message: errorLines.join("\n"),
				reload: false,
				details: {
					conflict: conflictRequest,
					conflicts: plan.conflicts,
					validationErrors: plan.validationErrors,
				},
			};
		}

		// 5. settings 变更不是来自远端时（本机待推送或无待应用变更），
		//    抑制包安装/卸载：这些差异属于 capture 方向。
		const effectivePackagePlan = settingsIncoming
			? packagePlan
			: {
					...packagePlan,
					added: [],
					changed: [],
					removed: [],
					approvalRequired: [],
			};

		// 6. 审批门禁：任何 deferred 包 → 本轮不安装也不改 settings；
		//    selection 提供的安装许可必须覆盖全部 approvalRequired，
		//    否则回落到交互式 approval_required。
		if (
			settingsIncoming &&
			deferredPackages.length === 0 &&
			effectivePackagePlan.approvalRequired.length > 0
		) {
			const effectiveApproval =
				packageApproval ??
				(selections && approvedInstalls.length > 0
					? { approvedSources: approvedInstalls }
					: undefined);
			if (
				!effectiveApproval ||
				!approvePackagePlan(effectivePackagePlan, effectiveApproval).approved
			) {
				return {
					ok: false,
					code: "approval_required",
					message: `应用 settings 前需要包审批：${effectivePackagePlan.approvalRequired.join("、")}`,
					reload: false,
					details: { packages: effectivePackagePlan.approvalRequired },
				};
			}
			return executeApplyTransaction({
				agentDir: this.agentDir,
				commit,
				config,
				state,
				reason,
				plan,
				packagePlan: effectivePackagePlan,
				packageApproval: effectiveApproval,
				packageRemovals:
					confirmedRemovals.length > 0
						? new Set(confirmedRemovals)
						: undefined,
			});
		}
		return executeApplyTransaction({
			agentDir: this.agentDir,
			commit,
			config,
			state,
			reason,
			plan,
			packagePlan: effectivePackagePlan,
			packageApproval,
			packageRemovals:
				confirmedRemovals.length > 0 ? new Set(confirmedRemovals) : undefined,
		});
	}

	private normalizeRepoChangedFiles(
		changedFiles: string[],
		config: PiSyncConfig,
	): string[] {
		const prefix = `${config.root.replace(/\\/g, "/")}/`;
		return changedFiles
			.map((file) => file.replace(/\\/g, "/"))
			.map((file) =>
				file.startsWith(prefix) ? file.slice(prefix.length) : file,
			)
			.filter((file) => file.length > 0 && !file.includes(" -> "));
	}

	private async computePushFingerprint(
		rp: string,
		config: PiSyncConfig,
		state: SyncState,
	): Promise<string> {
		const inventory = await compareFiles(this.agentDir, rp, config, state);
		const status = await gitStatus(rp);
		const diff = await gitDiff(rp);
		const files = inventory.comparisons.map((comparison) => ({
			path: comparison.relativePath,
			type: comparison.changeType,
			local: comparison.local?.sha256 ?? "absent",
			remote: comparison.remote?.sha256 ?? "absent",
			baseline: comparison.baseline?.sha256 ?? "absent",
		}));
		return sha256(
			JSON.stringify({
				head: status.commit,
				changedFiles: status.changedFiles,
				diff,
				files,
			}),
		);
	}

	private async getRepoSyncFiles(
		rp: string,
		config: PiSyncConfig,
	): Promise<string[]> {
		const safeRoot = await resolveRepoSyncRoot(rp, config.root, "read");
		const syncRoot = safeRoot.path;
		const files: string[] = [];
		const { readdir: rd } = await import("node:fs/promises");

		async function walk(dir: string): Promise<void> {
			if (!existsSync(dir)) return;
			let entries;
			try {
				entries = await rd(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const fullPath = join(dir, entry.name);
				const relPath = fullPath
					.replace(syncRoot + "/", "")
					.replace(syncRoot, "");
				if (entry.isSymbolicLink())
					throw new Error(`拒绝枚举符号链接：${fullPath}`);
				if (entry.isDirectory()) {
					await walk(fullPath);
					continue;
				}
				if (entry.isFile()) files.push(relPath);
			}
		}

		await walk(syncRoot);
		return files;
	}
}
