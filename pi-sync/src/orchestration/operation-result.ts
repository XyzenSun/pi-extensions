import type { PackageApproval } from "../system/packages.ts";

export type ResultCode =
	| "ok"
	| "noop"
	| "blocked_conflict"
	| "blocked_validation"
	| "approval_required"
	| "selection_required"
	| "git_failed"
	| "partial_failure";

export type NotificationLevel = "info" | "warning" | "error";
type FailureResultCode = Exclude<ResultCode, "ok" | "noop">;

function assertNever(value: never): never {
	throw new Error(`未知的结果码：${value}`);
}

export type RunMode = "setup" | "sync" | "recovery";
export type SyncPhase = "preflight" | "pull" | "apply" | "push" | "complete";

/**
 * Git 冲突的两条出路（v0.2.0.md 决策 3 的 D9）。
 *
 * pi-sync 不提供 Git 冲突合并器，因此这里只有"转交给 agent"与"用户自己处理"。
 * 曾经存在的 use_local / use_remote / choose_by_file 已随 D9 移除——那些只是
 * 给 git 的 ours/theirs 包了层 UI，并非语义合并。
 *
 * 注意：这与 pull 的"冲突自动远端优先"无关，后者是三方比较层的裁决（D7），
 * 由 materialize 的 useRemoteForConflicts 实现，不走本类型。
 */
export type ConflictChoice = "ask_agent" | "abort";

/**
 * 用户针对已审阅同步计划做出的逐项选择。
 * 执行时会再次用实时计划校验这些键；未知条目一律忽略，绝不凭空产生新动作。
 */
export interface SyncSelections {
	/** 本次运行来自交互式扩展计划确认。 */
	reviewed?: true;
	/** 标记选择 UI 中向用户展示过的每一项。 */
	reviewedItems?: string[];
	/** 用户批准安装的传入包源。 */
	installPackages?: string[];
	/** 传入的已移除包源，其残留文件可被卸载。 */
	removePackages?: string[];
	/** 推迟到后续同步再应用的远端扩展路径。 */
	deferApplyPaths?: string[];
	/** 仅保留在本机的本机扩展路径（永不捕获）。 */
	keepLocalPaths?: string[];
}

export interface SyncConflictPath {
	relativePath: string;
	changeType:
		| "both_modified"
		| "local_modified_remote_deleted"
		| "local_deleted_remote_modified"
		| "git_conflict";
}

export interface SyncConflictRequest {
	kind: "sync_conflict";
	sharedBranch: string;
	deviceBranch: string;
	sharedHead?: string;
	deviceHead: string;
	paths: SyncConflictPath[];
}

export interface SyncPlanChange {
	relativePath: string;
	changeType: string;
}

/** 在常规同步做出改动前展示的只读快照。 */
export interface ExtensionSelectionRequest {
	changes: SyncPlanChange[];
	packages: { added: string[]; removed: string[]; changed: string[] };
}

/** 同步计划中被审阅条目的稳定、与 UI 无关的标识。 */
export function syncSelectionItemId(
	kind: "package-install" | "package-remove" | "extension-apply" | "extension-push",
	value: string,
): string {
	return `${kind}:${value}`;
}

export type SyncPlan =
	| {
			kind: "setup";
			message: string;
	  }
	| {
			kind: "blocked";
			message: string;
	  }
	| {
			kind: "ready";
			fingerprint: string;
			changes: SyncPlanChange[];
			packages: { added: string[]; removed: string[]; changed: string[] };
			remote: { ahead: number; behind: number };
			pendingRecovery: boolean;
			message: string;
	  };

export function isSyncConflictRequest(
	value: unknown,
): value is SyncConflictRequest {
	if (!value || typeof value !== "object") return false;
	const conflict = value as Partial<SyncConflictRequest>;
	return (
		conflict.kind === "sync_conflict" &&
		typeof conflict.sharedBranch === "string" &&
		typeof conflict.deviceBranch === "string" &&
		typeof conflict.deviceHead === "string" &&
		Array.isArray(conflict.paths)
	);
}

export interface RunOptions {
	gitUrl?: string;
	packageApproval?: PackageApproval;
	/** 从已审阅计划的确认 UI 收集到的逐项选择。 */
	selections?: SyncSelections;
	/** 若只读计划在用户决策期间发生变化，则拒绝执行。 */
	expectedPlanFingerprint?: string;
	/** 用户中止或触发超时时取消嵌套子进程。 */
	signal?: AbortSignal;
	onProgress?: (phase: SyncPhase, message: string) => void;
	/** 启动独立于子进程超时的 UI 层兜底保护。 */
	onGitCommandStart?: (
		phase: SyncPhase,
		command: string,
		timeoutMs: number,
	) => void;
}

export interface RunResult extends CommandResult {
	mode: RunMode;
	phase: SyncPhase;
	details?: {
		needsGitUrl?: boolean;
		pull?: CommandResult;
		push?: CommandResult;
		approvalRequired?: string[];
		reason?: string;
		conflict?: SyncConflictRequest;
		[key: string]: unknown;
	};
}

export interface CommandResult {
	ok: boolean;
	code: ResultCode;
	message: string;
	reload: boolean;
	details?: unknown;
}

export function successResult(
	message: string,
	reload = false,
	details?: unknown,
): CommandResult {
	const result = { ok: true, code: "ok" as const, message, reload };
	return details === undefined ? result : { ...result, details };
}

export function noopResult(message: string, details?: unknown): CommandResult {
	const result = { ok: true, code: "noop" as const, message, reload: false };
	return details === undefined ? result : { ...result, details };
}

export function failureResult(
	code: FailureResultCode,
	message: string,
	details?: unknown,
): CommandResult {
	const result = { ok: false, code, message, reload: false };
	return details === undefined ? result : { ...result, details };
}

export function conflictResult(
	message: string,
	details?: unknown,
): CommandResult {
	return failureResult("blocked_conflict", message, details);
}

export function notificationLevelForResult(
	code: ResultCode,
): NotificationLevel {
	switch (code) {
		case "ok":
		case "noop":
			return "info";
		case "blocked_conflict":
		case "blocked_validation":
		case "approval_required":
		case "selection_required":
			return "warning";
		case "git_failed":
		case "partial_failure":
			return "error";
		default:
			return assertNever(code);
	}
}
