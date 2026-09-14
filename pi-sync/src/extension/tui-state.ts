/**
 * TUI 的状态机（docs/tui-prd.md §4）。
 *
 * 这里只有**纯状态转移**，不碰 pi-tui、不发 git 命令、不读磁盘——
 * 渲染与执行分别由 tui-view.ts 和 index.ts 负责。这样拆的原因有两个：
 *
 * 1. 状态转移可以脱离终端单测（见 test/tui-state.test.ts）
 * 2. PRD §4.3 那条硬限制要求 TUI 必须做成"单个 custom() 组件内部切页"——
 *    全屏组件与 select()/confirm() 抢占同一个编辑器容器，嵌套会把 TUI 顶掉。
 *    既然不能靠对话框推进流程，页面切换就得自己管，于是有了这个状态机。
 */

/** TUI 当前停在哪一页。 */
export type TuiPageKind =
	| "menu"
	| "confirm"
	| "conflict"
	| "result"
	| "closed";

/** 用户在 TUI 里可以发起的动作。 */
export type TuiActionId =
	| "pull-smart"
	| "pull-overwrite-local"
	| "push-smart"
	| "push-overwrite-remote"
	| "view-diff"
	| "toggle-auto-sync"
	| "exit";

/** 破坏性动作需要二次确认，且默认停在"取消"上（PRD §4.2 要求 2）。 */
export const DESTRUCTIVE_ACTIONS: ReadonlySet<TuiActionId> = new Set([
	"pull-overwrite-local",
	"push-overwrite-remote",
]);

export function isDestructiveAction(action: TuiActionId): boolean {
	return DESTRUCTIVE_ACTIONS.has(action);
}

/** 确认页的两个选项。破坏性动作进来时选中项固定为 cancel。 */
export type ConfirmChoice = "confirm" | "cancel";

/** 冲突提示页的两条出路（D9）。TUI 不做合并器，只转交。 */
export type ConflictExit = "ask-agent" | "manual";

export interface TuiMenuPage {
	kind: "menu";
	/** 光标停在哪一项，切页返回后要保持原位。 */
	selectedAction: TuiActionId;
}

export interface TuiConfirmPage {
	kind: "confirm";
	action: TuiActionId;
	/** 将要丢失的具体路径。PRD §4.2 要求 1：不能只报数量。 */
	losingPaths: string[];
	/** 路径过多时截断展示，但必须如实告知总数。 */
	totalLosingPaths: number;
	choice: ConfirmChoice;
}

export interface TuiConflictPage {
	kind: "conflict";
	conflictPaths: string[];
	/** 设备恢复分支名，两条出路都要展示它。 */
	deviceBranch: string;
	exit: ConflictExit;
}

export interface TuiResultPage {
	kind: "result";
	action: TuiActionId;
	ok: boolean;
	message: string;
	/** 配置变了需要 reload 才生效，这是必要信息而非审批。 */
	reload: boolean;
}

export interface TuiClosedPage {
	kind: "closed";
	/** TUI 关闭后由调用方继续处理的事情。 */
	pending: TuiExitIntent | null;
}

export type TuiPage =
	| TuiMenuPage
	| TuiConfirmPage
	| TuiConflictPage
	| TuiResultPage
	| TuiClosedPage;

/**
 * TUI 关闭时交还给扩展层的意图。
 *
 * TUI 自己不执行 reload、不投递 agent 消息——那些都要用到 ctx 的对话框或
 * pi.sendUserMessage，在 custom() 内部调用会把 TUI 顶掉（PRD §4.3）。
 * 所以统一等 TUI 关闭后再由 index.ts 处理。
 */
export type TuiExitIntent =
	| { kind: "reload" }
	| { kind: "ask-agent" }
	| { kind: "manual-merge" }
	| { kind: "show-diff" }
	/**
	 * 动作需要包安装审批。
	 *
	 * 审批要弹 confirm 对话框，在 custom() 内部调用会顶掉面板，所以只能
	 * 关掉面板再问。D5 要求 TUI 保留审批（直达命令才省），因此这条路径
	 * 不能像直达命令那样自动批准。
	 */
	| { kind: "package-approval"; action: TuiActionId; packages: string[] };

/** 每个菜单项的静态描述，供渲染层直接使用。 */
export interface TuiMenuEntry {
	action: TuiActionId;
	label: string;
	description: string;
	destructive: boolean;
}

/**
 * 菜单项。顺序即渲染顺序，也是上下键的遍历顺序。
 *
 * 措辞上刻意区分"智能化"与"覆盖"：前者是现有 pull/push 流程（PRD §2.1
 * 明确"智能化"只是给现有流程起的名字，零引擎改动），后者是整机对齐。
 */
export const TUI_MENU_ENTRIES: readonly TuiMenuEntry[] = [
	{
		action: "pull-smart",
		label: "智能化拉取",
		description: "拉取远端配置；保留计划预览与包审批",
		destructive: false,
	},
	{
		action: "pull-overwrite-local",
		label: "以远端覆盖本机",
		description: "整机对齐：丢弃本机全部未推送改动",
		destructive: true,
	},
	{
		action: "push-smart",
		label: "智能化推送",
		description: "推送本机配置；保留计划预览与包审批",
		destructive: false,
	},
	{
		action: "push-overwrite-remote",
		label: "以本机覆盖远端",
		description: "整机对齐：远端变成本机当前的样子",
		destructive: true,
	},
	{
		action: "view-diff",
		label: "查看差异",
		description: "全屏查看待同步的变更",
		destructive: false,
	},
	{
		action: "toggle-auto-sync",
		label: "设置：自动同步",
		description: "开关 session 期间的定时静默拉取",
		destructive: false,
	},
	{
		action: "exit",
		label: "退出",
		description: "关闭 pi-sync 面板",
		destructive: false,
	},
];

/** 常驻顶部的状态总览（PRD §4.1）。 */
export interface TuiStatusSummary {
	branch: string;
	/** 待推送 / 待拉取的 commit 数。 */
	ahead: number;
	behind: number;
	/** 待同步的文件变更数。 */
	pendingChanges: number;
	/** 语义层冲突数，与 Git 层冲突是两回事。 */
	conflicts: number;
	autoSyncEnabled: boolean;
	lastSyncedAt: string | null;
}

export interface TuiState {
	page: TuiPage;
	status: TuiStatusSummary;
	/** 正在执行的动作；非 null 时屏蔽输入，避免重复触发。 */
	busyAction: TuiActionId | null;
	/** 执行期间的进度文案，复用 operation-runner 的回调。 */
	progress: string | null;
}

export function createTuiState(status: TuiStatusSummary): TuiState {
	return {
		page: { kind: "menu", selectedAction: TUI_MENU_ENTRIES[0]!.action },
		status,
		busyAction: null,
		progress: null,
	};
}

/** 菜单项在遍历顺序中的下标；找不到时落回 0，避免光标丢失。 */
function menuIndexOf(action: TuiActionId): number {
	const index = TUI_MENU_ENTRIES.findIndex((entry) => entry.action === action);
	return index >= 0 ? index : 0;
}

export function moveMenuSelection(
	state: TuiState,
	delta: number,
): TuiState {
	if (state.page.kind !== "menu") return state;
	const count = TUI_MENU_ENTRIES.length;
	const current = menuIndexOf(state.page.selectedAction);
	// 循环选择：到底再按下回到第一项，省掉用户长按回滚的麻烦。
	const next = (((current + delta) % count) + count) % count;
	return {
		...state,
		page: { kind: "menu", selectedAction: TUI_MENU_ENTRIES[next]!.action },
	};
}

export interface LosingPathsInput {
	paths: string[];
	/** 展示上限；超出部分只报总数，不逐条列。 */
	limit?: number;
}

const DEFAULT_LOSING_PATH_LIMIT = 12;

/**
 * 进入某个动作。破坏性动作先落到确认页，其余交由调用方直接执行。
 *
 * losingPaths 只对破坏性动作有意义：PRD §4.2 要求执行前列出将丢失的
 * 具体路径，所以这个清单必须由调用方先算出来再进这一页。
 */
export function beginAction(
	state: TuiState,
	action: TuiActionId,
	losing: LosingPathsInput = { paths: [] },
): TuiState {
	if (state.busyAction !== null) return state;
	if (!isDestructiveAction(action)) return state;
	const limit = losing.limit ?? DEFAULT_LOSING_PATH_LIMIT;
	return {
		...state,
		page: {
			kind: "confirm",
			action,
			losingPaths: losing.paths.slice(0, limit),
			totalLosingPaths: losing.paths.length,
			// 默认停在取消上（PRD §4.2 要求 2）：误触 Enter 不应造成破坏。
			choice: "cancel",
		},
	};
}

export function setConfirmChoice(
	state: TuiState,
	choice: ConfirmChoice,
): TuiState {
	if (state.page.kind !== "confirm") return state;
	return { ...state, page: { ...state.page, choice } };
}

export function toggleConfirmChoice(state: TuiState): TuiState {
	if (state.page.kind !== "confirm") return state;
	return setConfirmChoice(
		state,
		state.page.choice === "confirm" ? "cancel" : "confirm",
	);
}

/** 取消确认页，回到菜单并把光标停回原动作上。 */
export function cancelConfirm(state: TuiState): TuiState {
	if (state.page.kind !== "confirm") return state;
	return {
		...state,
		page: { kind: "menu", selectedAction: state.page.action },
	};
}

export function markBusy(state: TuiState, action: TuiActionId): TuiState {
	return { ...state, busyAction: action, progress: null };
}

export function setProgress(state: TuiState, progress: string): TuiState {
	if (state.busyAction === null) return state;
	return { ...state, progress };
}

export interface ActionOutcome {
	action: TuiActionId;
	ok: boolean;
	message: string;
	reload: boolean;
}

/** 动作执行完毕：落到结果页，让用户看到"实际发生了什么"（D4）。 */
export function finishAction(
	state: TuiState,
	outcome: ActionOutcome,
	status: TuiStatusSummary = state.status,
): TuiState {
	return {
		...state,
		status,
		busyAction: null,
		progress: null,
		page: {
			kind: "result",
			action: outcome.action,
			ok: outcome.ok,
			message: outcome.message,
			reload: outcome.reload,
		},
	};
}

export interface ConflictInput {
	conflictPaths: string[];
	deviceBranch: string;
}

/**
 * 动作撞上 Git 冲突：落到冲突提示页。
 *
 * 按 D9，这一页只展示 + 转交，没有合并器，所以它就是一个静态清单加两项选择。
 */
export function raiseConflict(
	state: TuiState,
	conflict: ConflictInput,
): TuiState {
	return {
		...state,
		busyAction: null,
		progress: null,
		page: {
			kind: "conflict",
			conflictPaths: conflict.conflictPaths,
			deviceBranch: conflict.deviceBranch,
			// 默认停在"我自己处理"：不动是安全默认，与直达命令的 Esc 行为一致。
			exit: "manual",
		},
	};
}

export function setConflictExit(
	state: TuiState,
	exit: ConflictExit,
): TuiState {
	if (state.page.kind !== "conflict") return state;
	return { ...state, page: { ...state.page, exit } };
}

export function toggleConflictExit(state: TuiState): TuiState {
	if (state.page.kind !== "conflict") return state;
	return setConflictExit(
		state,
		state.page.exit === "ask-agent" ? "manual" : "ask-agent",
	);
}

/** 从结果页或冲突页回到菜单。 */
export function returnToMenu(state: TuiState): TuiState {
	const selectedAction =
		state.page.kind === "result" || state.page.kind === "confirm"
			? state.page.action
			: TUI_MENU_ENTRIES[0]!.action;
	return { ...state, page: { kind: "menu", selectedAction } };
}

/** 关闭 TUI，并把待办意图交还给扩展层。 */
export function closeTui(
	state: TuiState,
	pending: TuiExitIntent | null = null,
): TuiState {
	return { ...state, busyAction: null, progress: null, page: { kind: "closed", pending } };
}

export function setAutoSyncEnabled(
	state: TuiState,
	enabled: boolean,
): TuiState {
	return { ...state, status: { ...state.status, autoSyncEnabled: enabled } };
}

export function isClosed(state: TuiState): boolean {
	return state.page.kind === "closed";
}
