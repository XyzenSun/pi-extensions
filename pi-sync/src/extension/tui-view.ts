/**
 * TUI 的渲染层（docs/tui-prd.md §4.3）。
 *
 * 输入是 tui-state.ts 的纯状态，输出是字符串数组——不持有任何可变状态，
 * 也不认识 pi-tui 的组件类。这样渲染结果可以直接在单测里断言
 * （见 test/tui-view.test.ts），不需要起终端。
 *
 * 颜色通过 ThemeLike 注入。真实运行时传入的是 Pi 的 theme，
 * 测试里传一个把 role 标记出来的假 theme 即可断言"哪段被标红了"。
 */
import {
	TUI_MENU_ENTRIES,
	type TuiActionId,
	type TuiState,
} from "./tui-state.ts";
import { formatLocalTimestamp } from "./time-format.ts";

/** Pi 主题里本模块用到的那部分。 */
export interface ThemeLike {
	fg(role: string, text: string): string;
	bold?(text: string): string;
}

function bold(theme: ThemeLike, text: string): string {
	return theme.bold ? theme.bold(text) : text;
}

/** 状态总览里"上次同步"的展示：只留到分钟，秒和时区对用户没意义。 */
function formatLastSynced(iso: string | null): string {
	if (!iso) return "从未同步";
	// lastSyncedAt 是 UTC 字符串，展示前必须换算到本机时区
	return formatLocalTimestamp(iso);
}

/**
 * 常驻顶部的状态总览（PRD §4.1）。
 *
 * 这是"反黑盒"的第一层（D4）：进 TUI 不做任何操作就能看到当前处境。
 */
export function renderStatusSummary(
	state: TuiState,
	theme: ThemeLike,
): string[] {
	const { status } = state;
	const sync =
		status.ahead === 0 && status.behind === 0
			? "已是最新"
			: `待推送 ${status.ahead} · 待拉取 ${status.behind}`;
	const lines = [
		theme.fg("accent", bold(theme, "pi-sync")),
		theme.fg(
			"muted",
			`分支 ${status.branch} · ${sync} · 上次同步 ${formatLastSynced(status.lastSyncedAt)}`,
		),
	];

	const pending =
		status.pendingChanges === 0
			? theme.fg("muted", "没有待同步的变更")
			: theme.fg("text", `${status.pendingChanges} 个待同步变更`);
	// 冲突单独一行且标红：它决定用户接下来能做什么，不该混在普通计数里。
	const conflicts =
		status.conflicts > 0
			? theme.fg("error", `${status.conflicts} 个冲突`)
			: null;
	lines.push(conflicts ? `${pending}　${conflicts}` : pending);
	lines.push(
		theme.fg(
			"muted",
			`自动同步：${status.autoSyncEnabled ? "开" : "关"}`,
		),
	);
	return lines;
}

function renderMenu(state: TuiState, theme: ThemeLike): string[] {
	if (state.page.kind !== "menu") return [];
	const selected = state.page.selectedAction;
	return TUI_MENU_ENTRIES.map((entry) => {
		const isSelected = entry.action === selected;
		const prefix = isSelected ? "❯ " : "  ";
		// 破坏性档位常驻警示色，光标没停上去时也能一眼认出（PRD §4.2）。
		const labelRole = entry.destructive
			? "warning"
			: isSelected
				? "accent"
				: "text";
		const label = theme.fg(labelRole, entry.label);
		const description = theme.fg("muted", entry.description);
		return `${theme.fg(isSelected ? "accent" : "text", prefix)}${label}  ${description}`;
	});
}

function renderConfirm(state: TuiState, theme: ThemeLike): string[] {
	if (state.page.kind !== "confirm") return [];
	const page = state.page;
	const entry = TUI_MENU_ENTRIES.find((item) => item.action === page.action);
	const lines: string[] = [
		theme.fg("warning", bold(theme, `确认：${entry?.label ?? page.action}`)),
		"",
	];

	if (page.totalLosingPaths === 0) {
		lines.push(theme.fg("muted", "没有检测到会被丢弃的内容。"));
	} else {
		// PRD §4.2 要求 1：列出将丢失的**具体路径**，不能只报数量。
		lines.push(
			theme.fg("error", `以下 ${page.totalLosingPaths} 项内容将被丢弃：`),
		);
		for (const path of page.losingPaths) {
			lines.push(theme.fg("error", `  ${path}`));
		}
		const hidden = page.totalLosingPaths - page.losingPaths.length;
		// 截断必须如实告知，否则用户会以为只丢这几条（"无静默截断"）。
		if (hidden > 0) {
			lines.push(theme.fg("error", `  …… 另有 ${hidden} 项未列出`));
		}
	}

	lines.push("");
	lines.push(
		theme.fg(
			"muted",
			"落地前会自动备份；本机已提交的内容仍会推到设备恢复分支。",
		),
	);
	lines.push("");
	const confirmSelected = page.choice === "confirm";
	lines.push(
		`${theme.fg(confirmSelected ? "error" : "muted", confirmSelected ? "❯ 确认执行" : "  确认执行")}`,
	);
	lines.push(
		`${theme.fg(confirmSelected ? "muted" : "accent", confirmSelected ? "  取消" : "❯ 取消")}`,
	);
	return lines;
}

function renderConflict(state: TuiState, theme: ThemeLike): string[] {
	if (state.page.kind !== "conflict") return [];
	const page = state.page;
	const lines: string[] = [
		theme.fg("error", bold(theme, "检测到 Git 冲突")),
		"",
	];

	if (page.conflictPaths.length === 0) {
		lines.push(theme.fg("muted", "git 未报告具体路径。"));
	} else {
		lines.push(theme.fg("text", "冲突路径："));
		for (const path of page.conflictPaths) {
			lines.push(theme.fg("error", `  ${path}`));
		}
	}

	lines.push("");
	// 设备恢复分支名是两条出路都要用到的信息：交给 agent 时它是合并来源，
	// 自己处理时它是 git merge 的参数。所以无论选哪条都得看得见。
	lines.push(
		theme.fg("muted", `本机改动已保存在 origin/${page.deviceBranch}`),
	);
	lines.push("");
	// D9：pi-sync 不做合并器，这一页只有"转交"和"撒手"两条。
	const agentSelected = page.exit === "ask-agent";
	lines.push(
		theme.fg(
			agentSelected ? "accent" : "text",
			agentSelected ? "❯ 请 agent 解决冲突" : "  请 agent 解决冲突",
		),
	);
	lines.push(
		theme.fg(
			agentSelected ? "text" : "accent",
			agentSelected ? "  停止 —— 我自己处理" : "❯ 停止 —— 我自己处理",
		),
	);
	return lines;
}

function renderResult(state: TuiState, theme: ThemeLike): string[] {
	if (state.page.kind !== "result") return [];
	const page = state.page;
	const entry = TUI_MENU_ENTRIES.find((item) => item.action === page.action);
	const heading = page.ok
		? theme.fg("success", bold(theme, `完成：${entry?.label ?? page.action}`))
		: theme.fg("error", bold(theme, `未完成：${entry?.label ?? page.action}`));
	const lines = [heading, ""];
	// 逐行上色而非整块：消息里常含多行 git 输出，整体染色会盖掉原有层次。
	for (const line of page.message.split("\n")) {
		lines.push(line === "" ? line : theme.fg("text", line));
	}
	if (page.reload) {
		lines.push("");
		lines.push(
			theme.fg("warning", "配置已变更，退出后可以 reload 使其生效。"),
		);
	}
	return lines;
}

function renderBusy(state: TuiState, theme: ThemeLike): string[] {
	const entry = TUI_MENU_ENTRIES.find(
		(item) => item.action === state.busyAction,
	);
	return [
		theme.fg("accent", `正在执行：${entry?.label ?? state.busyAction}`),
		theme.fg("muted", state.progress ?? "请稍候……"),
	];
}

/** 底部按键提示。每一页可用的键不同，所以跟着页面走。 */
function renderFooter(state: TuiState, theme: ThemeLike): string {
	if (state.busyAction !== null) {
		return theme.fg("dim", "执行中…… 请等待完成");
	}
	switch (state.page.kind) {
		case "menu":
			return theme.fg("dim", "↑↓ 选择 · Enter 执行 · Esc 退出");
		case "confirm":
			return theme.fg("dim", "↑↓ 切换 · Enter 确认所选 · Esc 取消");
		case "conflict":
			return theme.fg("dim", "↑↓ 切换 · Enter 选择 · Esc 返回菜单");
		case "result":
			return theme.fg("dim", "Enter 返回菜单 · Esc 退出");
		case "closed":
			return "";
	}
}

/** 供渲染层与测试共用的页面主体。 */
export function renderPageBody(state: TuiState, theme: ThemeLike): string[] {
	if (state.busyAction !== null) return renderBusy(state, theme);
	switch (state.page.kind) {
		case "menu":
			return renderMenu(state, theme);
		case "confirm":
			return renderConfirm(state, theme);
		case "conflict":
			return renderConflict(state, theme);
		case "result":
			return renderResult(state, theme);
		case "closed":
			return [];
	}
}

/**
 * 渲染整个面板：状态总览 + 页面主体 + 按键提示。
 *
 * 状态总览常驻（PRD §4.1），所以它不属于任何一页——切页时它不动。
 */
export function renderTui(state: TuiState, theme: ThemeLike): string[] {
	if (state.page.kind === "closed") return [];
	const body = renderPageBody(state, theme);
	const footer = renderFooter(state, theme);
	return [...renderStatusSummary(state, theme), "", ...body, "", footer];
}

/** 结果页要展示的动作标签，供扩展层拼通知文案时复用。 */
export function labelForAction(action: TuiActionId): string {
	return (
		TUI_MENU_ENTRIES.find((entry) => entry.action === action)?.label ?? action
	);
}
