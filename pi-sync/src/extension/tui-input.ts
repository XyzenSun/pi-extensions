/**
 * TUI 的按键映射（docs/tui-prd.md §4）。
 *
 * 把"按了什么键"翻译成"要做什么"，不直接改状态、也不执行动作。
 * 单独成层的原因：按键语义是 TUI 最容易出回归的地方（比如确认页的 Enter
 * 必须落在当前选中项上，而不是无条件确认），抽出来才能穷举测试。
 *
 * 返回的 TuiIntent 由 index.ts 消费——只有那里才能调 git、弹对话框、
 * 投递 agent 消息。这一层保持无副作用。
 */
import { matchesKey } from "@earendil-works/pi-tui";
import {
	isDestructiveAction,
	type TuiActionId,
	type TuiState,
} from "./tui-state.ts";

/** 按键翻译出的意图。 */
export type TuiIntent =
	/** 仅移动光标，由调用方改状态后重绘。 */
	| { kind: "move"; delta: number }
	/** 在确认页/冲突页切换选项。 */
	| { kind: "toggle" }
	/** 执行菜单当前选中的动作。 */
	| { kind: "activate"; action: TuiActionId }
	/** 破坏性动作已被二次确认，可以执行。 */
	| { kind: "confirm-destructive"; action: TuiActionId }
	/** 放弃确认，回到菜单。 */
	| { kind: "cancel-confirm" }
	/** 冲突页选定了一条出路。 */
	| { kind: "resolve-conflict"; exit: "ask-agent" | "manual" }
	/** 结果页/冲突页返回菜单。 */
	| { kind: "back-to-menu" }
	/** 关闭 TUI。 */
	| { kind: "exit" }
	/** 该按键在当前页无意义，忽略。 */
	| { kind: "ignore" };

const IGNORE: TuiIntent = { kind: "ignore" };

function isUp(data: string): boolean {
	return matchesKey(data, "up") || matchesKey(data, "shift+tab");
}

function isDown(data: string): boolean {
	return matchesKey(data, "down") || matchesKey(data, "tab");
}

function isEnter(data: string): boolean {
	return matchesKey(data, "enter");
}

function isEscape(data: string): boolean {
	return matchesKey(data, "escape");
}

/**
 * 把一次按键翻译为意图。
 *
 * 执行中（busyAction 非 null）一律忽略输入：动作正在改磁盘和远端，
 * 此时接受按键会让用户以为能中断，实际不能——宁可无响应也不给假承诺。
 * 取消由 operation-runner 的 Esc 通道负责，不走这里。
 */
export function mapKeyToIntent(state: TuiState, data: string): TuiIntent {
	if (state.busyAction !== null) return IGNORE;

	switch (state.page.kind) {
		case "menu": {
			if (isUp(data)) return { kind: "move", delta: -1 };
			if (isDown(data)) return { kind: "move", delta: 1 };
			if (isEscape(data)) return { kind: "exit" };
			if (isEnter(data)) {
				const action = state.page.selectedAction;
				// 退出项和 Esc 等价，省得用户找退路。
				if (action === "exit") return { kind: "exit" };
				return { kind: "activate", action };
			}
			return IGNORE;
		}
		case "confirm": {
			// 上下键在两个选项间切换，不区分方向——只有两项，切换即取反。
			if (isUp(data) || isDown(data)) return { kind: "toggle" };
			if (isEscape(data)) return { kind: "cancel-confirm" };
			if (isEnter(data)) {
				// Enter 落在**当前选中项**上，而不是无条件确认。
				// 默认选中项是取消（tui-state 的 beginAction），所以误触 Enter 是安全的。
				if (state.page.choice === "cancel") return { kind: "cancel-confirm" };
				return { kind: "confirm-destructive", action: state.page.action };
			}
			return IGNORE;
		}
		case "conflict": {
			if (isUp(data) || isDown(data)) return { kind: "toggle" };
			// Esc 回菜单而非直接退出：冲突还没处理，用户可能想先看差异。
			if (isEscape(data)) return { kind: "back-to-menu" };
			if (isEnter(data)) {
				return { kind: "resolve-conflict", exit: state.page.exit };
			}
			return IGNORE;
		}
		case "result": {
			if (isEnter(data)) return { kind: "back-to-menu" };
			if (isEscape(data)) return { kind: "exit" };
			return IGNORE;
		}
		case "closed":
			return IGNORE;
	}
}

/**
 * 菜单项是否需要先过确认页。
 *
 * 与 isDestructiveAction 同义，单独导出是为了让调用方在 activate 分支里
 * 读起来直白：needsConfirmation(action) 比 isDestructiveAction(action) 更贴合语境。
 */
export function needsConfirmation(action: TuiActionId): boolean {
	return isDestructiveAction(action);
}
