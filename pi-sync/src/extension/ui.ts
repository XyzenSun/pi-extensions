/**
 * TUI 展示和格式化（schema v2）
 *
 * 为各种命令生成格式化的展示输出
 */
import type { GitStatus } from "../system/git.ts";
import type { PackageDiff } from "../system/packages.ts";
import type { PiSyncConfig } from "../sync/config.ts";
import type { SyncState } from "../system/state.ts";
import type { FileComparison, InventoryResult } from "../sync/inventory.ts";
import type { CaptureResult } from "../sync/capture.ts";
import type { ValidationError } from "../sync/validate.ts";
import { formatLocalTimestamp } from "./time-format.ts";

// ========== ANSI 颜色 ==========

const RED = "\x1b[31m";
const BOLD_RED = "\x1b[1;31m";
const BOLD_YELLOW = "\x1b[1;33m";
const RESET = "\x1b[0m";

function red(text: string): string {
	return `${RED}${text}${RESET}`;
}

function boldRed(text: string): string {
	return `${BOLD_RED}${text}${RESET}`;
}

function boldYellow(text: string): string {
	return `${BOLD_YELLOW}${text}${RESET}`;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

// ========== Git Status 格式化 ==========

export function formatGitStatus(status: GitStatus): string {
	const lines: string[] = [
		`branch：         ${status.branch}`,
		`commit：         ${status.commitShort} (${status.commit})`,
		`远端：           ${status.remoteExists ? "origin" : "无"}`,
	];

	if (status.remoteExists) {
		const arrows: string[] = [];
		if (status.ahead > 0) arrows.push(`↑${status.ahead}`);
		if (status.behind > 0) arrows.push(`↓${status.behind}`);
		if (arrows.length === 0) arrows.push("已是最新");
		lines.push(`同步：           ${arrows.join(" ")}`);
	}

	lines.push(`未提交改动：     ${status.hasUncommittedChanges ? "有" : "无"}`);

	if (status.isRebasing) lines.push(`rebase 中：      有`);
	if (status.isMerging) lines.push(`merge 中：       有`);
	if (status.hasConflicts)
		lines.push(`冲突：           有（${status.conflictedFiles.length} 个文件）`);

	if (status.changedFiles.length > 0) {
		lines.push(`变更文件（${status.changedFiles.length}）：`);
		for (const f of status.changedFiles.slice(0, 20)) {
			lines.push(`  ${f}`);
		}
		if (status.changedFiles.length > 20) {
			lines.push(`  …… 还有 ${status.changedFiles.length - 20} 个`);
		}
	}

	return lines.join("\n");
}

// ========== 同步状态 v2 ==========

export interface SyncStatusV2Input {
	repoPath: string;
	agentDir: string;
	gitStatus: GitStatus;
	config: PiSyncConfig;
	inventory: InventoryResult;
	state: SyncState;
	pkgDiff?: PackageDiff;
}

export function formatSyncStatusV2(input: SyncStatusV2Input): string {
	const { repoPath, gitStatus: gs, config, inventory, state, pkgDiff } = input;

	const lines: string[] = ["=== pi-sync 状态 ===", ""];

	// Git 摘要
	lines.push(`  仓库       ${repoPath}`);
	lines.push(
		`  git        ${gs.branch} @ ${gs.commitShort}` +
			(gs.remoteExists
				? `  ${gs.ahead > 0 ? `↑${gs.ahead}` : "↑0"} ${gs.behind > 0 ? `↓${gs.behind}` : "↓0"}`
				: "  （无远端）") +
			(gs.hasUncommittedChanges
				? `  有未提交改动（${gs.changedFiles.length}）`
				: "  干净") +
			(gs.hasConflicts ? boldRed("  存在冲突") : ""),
	);

	// 上次同步
	if (state.lastSyncedAt) {
		const when = formatLocalTimestamp(state.lastSyncedAt);
		const short = state.lastSyncedCommit?.substring(0, 7) ?? "?";
		lines.push(`  上次同步   ${when} (${short})`);
	} else {
		lines.push(`  上次同步   从未同步`);
	}

	// 冲突详情：仅显示冲突文件与 Git 处理步骤，不暴露两端的文件路径。
	const conflictComps = inventory.comparisons.filter(
		(c) => c.changeType === "both_modified",
	);
	const conflictFiles = [
		...new Set([
			...gs.conflictedFiles,
			...conflictComps.map((c) => `${config.root}/${c.relativePath}`),
		]),
	];
	if (gs.hasConflicts || conflictComps.length > 0) {
		lines.push("");
		lines.push(
			boldRed(`⚠ ${conflictFiles.length} 个冲突需要解决：`),
		);
		lines.push("  冲突文件：");
		for (const file of conflictFiles) {
			lines.push(red(`    ${file}`));
		}
		lines.push("");
		lines.push(boldYellow("  请在配置仓库中解决："));
		lines.push(`    cd ${shellQuote(repoPath)}`);
		if (!gs.isMerging && !gs.isRebasing) {
			lines.push(`    git merge origin/${config.branch}`);
		}
		lines.push("    # 编辑上述文件并移除所有冲突标记");
		lines.push("    git add .");
		lines.push(
			gs.isRebasing
				? "    git rebase --continue"
				: '    git commit -m "resolve conflicts"',
		);
		lines.push("  然后重新运行 /pisync 完成同步。");
	}

	// 已纳管（同步中）
	lines.push("已纳管（同步中）");
	lines.push(`  root       ${config.root}/`);
	lines.push(`  include    ${config.include.length} 条模式`);
	lines.push(`  exclude    ${config.exclude.length} 条模式`);
	lines.push(`  delete     ${config.delete}`);
	if (pkgDiff) {
		lines.push(`  包         ${pkgDiff.unchanged.length} 个已同步`);
	}
	lines.push("");

	// Pending 变更摘要
	const pending = formatInventorySummary(inventory);
	if (pending) {
		lines.push("待处理");
		lines.push(pending);
	} else {
		lines.push("已是最新 —— 没有待处理变更。");
	}

	// 详细变更列表
	const detail = formatInventoryDetail(inventory);
	if (detail) {
		lines.push("");
		lines.push(detail);
	}

	return lines.join("\n").replace(/\n+$/, "");
}

// ========== 文件比较 diff ==========

export function formatComparisonDiff(comparisons: FileComparison[]): string {
	if (comparisons.length === 0) return "没有可比较的文件。";

	const lines: string[] = [];
	let hasContent = false;

	for (const comp of comparisons) {
		const icon = changeTypeIcon(comp.changeType);
		const label = changeTypeLabel(comp.changeType);
		const isConflict =
			comp.changeType === "both_modified" ||
			comp.changeType === "local_modified_remote_deleted" ||
			comp.changeType === "local_deleted_remote_modified";

		if (comp.changeType === "no_change") continue;
		hasContent = true;

		const line = `  ${icon} ${comp.relativePath}  [${label}]`;
		lines.push(isConflict ? boldRed(line) : line);

		if (
			comp.changeType === "local_only" ||
			comp.changeType === "remote_only" ||
			comp.changeType === "both_modified"
		) {
			if (comp.local && comp.remote) {
				lines.push(`    本机：  ${comp.local.sha256.substring(0, 12)}……`);
				lines.push(`    远端：  ${comp.remote.sha256.substring(0, 12)}……`);
			}
		}
	}

	if (!hasContent) return "未检测到变更。";
	return lines.join("\n");
}

// ========== Inventory 摘要 ==========

function formatInventorySummary(inventory: InventoryResult): string {
	const s = inventory.summary;
	const parts: string[] = [];

	if (s.localOnly > 0 || s.localCreated > 0 || s.localDeleted > 0) {
		parts.push(
			`agent 变更：${s.localOnly} 个修改，${s.localCreated} 个新增，${s.localDeleted} 个删除`,
		);
	}
	if (s.remoteOnly > 0 || s.remoteCreated > 0 || s.remoteDeleted > 0) {
		parts.push(
			`仓库变更：${s.remoteOnly} 个修改，${s.remoteCreated} 个新增，${s.remoteDeleted} 个删除`,
		);
	}
	if (s.bothModified > 0) {
		parts.push(
			boldRed(`冲突：${s.bothModified} 个文件在两端都被修改`),
		);
	}
	if (s.converged > 0) {
		parts.push(`${s.converged} 个已收敛`);
	}

	return parts.length > 0 ? "  " + parts.join("\n  ") : "";
}

// ========== Inventory 详情 ==========

function formatInventoryDetail(inventory: InventoryResult): string {
	const interesting = inventory.comparisons.filter(
		(c) => c.changeType !== "no_change",
	);

	if (interesting.length === 0) return "";

	const lines: string[] = ["变更："];
	for (const comp of interesting) {
		const icon = changeTypeIcon(comp.changeType);
		const label = changeTypeLabel(comp.changeType);
		const isConflict =
			comp.changeType === "both_modified" ||
			comp.changeType === "local_modified_remote_deleted" ||
			comp.changeType === "local_deleted_remote_modified";
		const line = `  ${icon} ${comp.relativePath}  (${label})`;
		lines.push(isConflict ? boldRed(line) : line);
	}

	return lines.join("\n");
}

// ========== 变更类型图标和标签 ==========

function changeTypeIcon(type: string): string {
	switch (type) {
		case "no_change":
			return " ";
		case "local_only":
			return "L";
		case "remote_only":
			return "R";
		case "converged":
			return "=";
		case "both_modified":
			return "!";
		case "local_created":
			return "+";
		case "remote_created":
			return "+";
		case "local_deleted":
			return "-";
		case "remote_deleted":
			return "-";
		case "both_deleted":
			return "~";
		case "local_modified_remote_deleted":
			return "!";
		case "local_deleted_remote_modified":
			return "!";
		default:
			return "?";
	}
}

function changeTypeLabel(type: string): string {
	switch (type) {
		case "no_change":
			return "未变更";
		case "local_only":
			return "agent 已修改";
		case "remote_only":
			return "仓库已修改";
		case "converged":
			return "已收敛";
		case "both_modified":
			return "两端都已修改";
		case "local_created":
			return "agent 新增";
		case "remote_created":
			return "仓库新增";
		case "local_deleted":
			return "agent 已删除";
		case "remote_deleted":
			return "仓库已删除";
		case "both_deleted":
			return "两端都已删除";
		case "local_modified_remote_deleted":
			return "冲突：agent 修改 / 仓库删除";
		case "local_deleted_remote_modified":
			return "冲突：agent 删除 / 仓库修改";
		default:
			return type;
	}
}

// ========== 校验错误 ==========

export function formatValidationErrors(errors: ValidationError[]): string {
	if (errors.length === 0) return "没有校验错误。";

	const lines: string[] = ["校验错误："];
	for (const err of errors) {
		const prefix = err.severity === "error" ? "错误" : "警告";
		lines.push(`  [${prefix}] ${err.file}：${err.message}`);
	}
	return lines.join("\n");
}

// ========== Capture 结果 ==========

export function formatCaptureResult(result: CaptureResult): string {
	const lines: string[] = [];

	if (result.hasConflicts) {
		lines.push(boldRed("捕获被阻止：检测到双边修改。"));
		lines.push("");
		lines.push(
			"自上次同步以来，本机 agent 副本与远端仓库副本都发生了改动。",
		);
		lines.push("");
		lines.push("解决方式：");
		lines.push(
			"  - 保留远端版本：把文件从仓库复制到 agent，然后运行 /pisync",
		);
		lines.push(
			"  - 保留本机版本：把文件从 agent 复制到仓库，然后运行 /pisync",
		);
		lines.push("  - 或手动合并两个版本，然后运行 /pisync");
		lines.push("");
		lines.push(boldRed("冲突："));
		for (const c of result.conflicts) {
			lines.push(red(`  ${c.relativePath}`));
		}
		return lines.join("\n");
	}

	lines.push("捕获完成：");

	if (result.captured.length > 0) {
		lines.push(`  已捕获（${result.captured.length}）：`);
		for (const f of result.captured) lines.push(`    + ${f}`);
	}

	if (result.deleted.length > 0) {
		lines.push(`  已从仓库删除（${result.deleted.length}）：`);
		for (const f of result.deleted) lines.push(`    - ${f}`);
	}

	if (result.keptLocal && result.keptLocal.length > 0) {
		lines.push(`  仅保留在本机（${result.keptLocal.length}）：`);
		for (const f of result.keptLocal) lines.push(`    ~ ${f}`);
	}

	if (result.errors.length > 0) {
		lines.push(`  错误（${result.errors.length}）：`);
		for (const e of result.errors) lines.push(`    x ${e.file}：${e.message}`);
	}

	if (
		result.captured.length === 0 &&
		result.deleted.length === 0 &&
		(result.keptLocal?.length ?? 0) === 0 &&
		result.errors.length === 0
	) {
		lines.push("  没有需要捕获的变更。");
	}

	return lines.join("\n");
}

// ========== 同步计划（v0.8：逐项选择） ==========

export interface ExtensionPlanInput {
	changes: Array<{ relativePath: string; changeType: string }>;
	packages: { added: string[]; removed: string[]; changed: string[] };
}

export interface ExtensionPlanItem {
	kind:
		| "package-install"
		| "package-remove"
		| "extension-apply"
		| "extension-push";
	/** 展示标签：包 source 或扩展目录名 */
	label: string;
	/** 扩展分组受影响的相对路径 */
	paths: string[];
	/** 包条目的 source */
	source?: string;
}

const INCOMING_SETTINGS_CHANGES = new Set([
	"remote_only",
	"remote_created",
	"remote_deleted",
]);
const OUTGOING_SETTINGS_CHANGES = new Set([
	"local_only",
	"local_created",
	"local_deleted",
]);
const INCOMING_EXTENSION_CHANGES = new Set([
	"remote_only",
	"remote_created",
	"remote_deleted",
]);
const OUTGOING_EXTENSION_CHANGES = new Set([
	"local_only",
	"local_created",
	"local_deleted",
]);
const BUILTIN_SYNC_PACKAGE = "npm:@xyzensun/pi-sync";

function extensionGroupKey(relativePath: string): string {
	const rest = relativePath.replace(/^extensions\//, "");
	const firstSegment = rest.split("/")[0] ?? rest;
	return firstSegment.length > 0 ? firstSegment : relativePath;
}

/**
 * 从同步计划推导需要用户逐项决定的 extensions 变更。
 *
 * - 包声明差异的方向跟随 settings.json 的三方变更方向：
 *   远端变更待应用 → 安装/卸载项；本机变更待推送 → 仅展示，不生成选择项。
 * - extensions/** 文件按顶层目录分组，远端变更 → 应用项，本机变更 → 推送项。
 * - 双边冲突由冲突流程处理，不在这里出现。
 */
export function buildExtensionPlanItems(
	plan: ExtensionPlanInput,
): ExtensionPlanItem[] {
	const settingsChange = plan.changes.find(
		(change) => change.relativePath === "settings.json",
	)?.changeType;
	const items: ExtensionPlanItem[] = [];

	if (settingsChange && INCOMING_SETTINGS_CHANGES.has(settingsChange)) {
		for (const source of plan.packages.added) {
			if (source === BUILTIN_SYNC_PACKAGE) continue;
			items.push({
				kind: "package-install",
				label: source,
				paths: [],
				source,
			});
		}
		for (const source of plan.packages.changed) {
			if (source === BUILTIN_SYNC_PACKAGE) continue;
			items.push({
				kind: "package-install",
				label: source,
				paths: [],
				source,
			});
		}
		for (const source of plan.packages.removed) {
			if (source === BUILTIN_SYNC_PACKAGE) continue;
			items.push({
				kind: "package-remove",
				label: source,
				paths: [],
				source,
			});
		}
	}

	const applyGroups = new Map<string, string[]>();
	const pushGroups = new Map<string, string[]>();
	for (const change of plan.changes) {
		if (!change.relativePath.startsWith("extensions/")) continue;
		if (INCOMING_EXTENSION_CHANGES.has(change.changeType)) {
			const key = extensionGroupKey(change.relativePath);
			const paths = applyGroups.get(key) ?? [];
			paths.push(change.relativePath);
			applyGroups.set(key, paths);
		} else if (OUTGOING_EXTENSION_CHANGES.has(change.changeType)) {
			const key = extensionGroupKey(change.relativePath);
			const paths = pushGroups.get(key) ?? [];
			paths.push(change.relativePath);
			pushGroups.set(key, paths);
		}
	}
	for (const [label, paths] of applyGroups) {
		items.push({ kind: "extension-apply", label, paths });
	}
	for (const [label, paths] of pushGroups) {
		items.push({ kind: "extension-push", label, paths });
	}

	return items;
}

/**
 * 方向感知的同步计划展示。包变更标签随 settings.json 方向变化，
 * 避免把“本机待推送的新装包”误标为“待安装/待卸载”。
 */
export function formatSyncPlanMessage(
	plan: ExtensionPlanInput & {
		remote: { ahead: number; behind: number };
		pendingRecovery: boolean;
	},
): string {
	const lines = ["同步前请确认："];
	if (plan.changes.length > 0) {
		lines.push("", "文件变更：");
		for (const change of plan.changes) {
			lines.push(`  ${change.changeType}：${change.relativePath}`);
		}
	}
	if (plan.remote.ahead > 0 || plan.remote.behind > 0) {
		lines.push(
			``,
			`远端 commit：待 push ${plan.remote.ahead} 个，待 pull ${plan.remote.behind} 个。`,
		);
	}
	const settingsChange = plan.changes.find(
		(change) => change.relativePath === "settings.json",
	)?.changeType;
	const incoming = Boolean(
		settingsChange && INCOMING_SETTINGS_CHANGES.has(settingsChange),
	);
	const outgoing = Boolean(
		settingsChange && OUTGOING_SETTINGS_CHANGES.has(settingsChange),
	);
	const packageChanges = incoming
		? [
				...plan.packages.added.map((source) => `安装 ${source}（来自共享设置）`),
				...plan.packages.changed.map((source) => `更新到 ${source}（来自共享设置）`),
				...plan.packages.removed.map((source) => `移除 ${source}（已在共享设置中移除）`),
			]
		: outgoing
			? [
					...plan.packages.added.map((source) => `停止共享 ${source}`),
					...plan.packages.changed.map((source) => `将共享声明更新为 ${source}`),
					...plan.packages.removed.map((source) => `共享新包 ${source}`),
			]
			: [
				...plan.packages.added.map((source) => `安装 ${source}`),
				...plan.packages.changed.map((source) => `变更 ${source}`),
				...plan.packages.removed.map((source) => `移除 ${source}`),
			];
	if (packageChanges.length > 0) {
		lines.push(
			"",
			"包变更：",
			...packageChanges.map((item) => `  ${item}`),
		);
	}
	if (plan.pendingRecovery) {
		lines.push("", "将恢复一次先前未完成的操作。");
	}
	lines.push("", "是否继续本次同步？");
	return lines.join("\n");
}

