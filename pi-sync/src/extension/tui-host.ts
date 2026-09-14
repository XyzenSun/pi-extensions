/**
 * 把 TUI 三层（状态机 / 渲染 / 按键）组装成一个 pi-tui 组件。
 *
 * 为什么是"一个"组件：`docs/tui-prd.md` §4.3 的硬限制——`custom()` 非浮层
 * 模式与 `select()`/`confirm()`/`input()` 抢占同一个编辑器容器，在 TUI 内部
 * 调对话框会把 TUI 顶掉，且对话框关闭后恢复的是编辑器而不是 TUI。
 * 所以确认、冲突转交这些原本用对话框做的事，全部做成组件内部的页面。
 *
 * 本模块只认识"状态 + 渲染 + 按键"，不认识 git 和编排层：动作的实际执行
 * 由调用方通过 TuiHostActions 注入。这样组装逻辑也能脱离终端测试。
 */
import type { Component } from "@earendil-works/pi-tui";
import {
	beginAction,
	cancelConfirm,
	closeTui,
	createTuiState,
	finishAction,
	markBusy,
	moveMenuSelection,
	raiseConflict,
	returnToMenu,
	setAutoSyncEnabled,
	setProgress,
	toggleConfirmChoice,
	toggleConflictExit,
	type ActionOutcome,
	type ConflictInput,
	type TuiActionId,
	type TuiExitIntent,
	type TuiState,
	type TuiStatusSummary,
} from "./tui-state.ts";
import { mapKeyToIntent } from "./tui-input.ts";
import { renderTui, type ThemeLike } from "./tui-view.ts";

/** 一次动作的执行结果：正常结束，或需要转交给扩展层处理。 */
export type TuiActionResult =
	| { kind: "outcome"; outcome: Omit<ActionOutcome, "action"> }
	| { kind: "conflict"; conflict: ConflictInput }
	/**
	 * 需要包安装审批。面板内弹不了对话框（PRD §4.3），只能关掉面板再问，
	 * 所以这里直接携带待审批的包源交还调用方。
	 */
	| { kind: "package-approval"; packages: string[] }
	/** 用户在执行期间按 Esc 取消，或执行被看门狗中止。 */
	| { kind: "aborted" };

/**
 * TUI 需要外界提供的能力。
 *
 * 全部由 index.ts 注入真实实现（编排层调用），测试里注入假实现。
 */
export interface TuiHostActions {
	/** 执行一个非破坏性或已确认的动作。onProgress 用于回填进度文案。 */
	run(
		action: TuiActionId,
		onProgress: (message: string) => void,
	): Promise<TuiActionResult>;
	/** 破坏性动作的"将丢失哪些路径"清单（PRD §4.2 要求 1）。 */
	losingPaths(action: TuiActionId): Promise<string[]>;
	/** 动作结束后重新读状态总览，让界面反映实际结果（D4）。 */
	refreshStatus(): Promise<TuiStatusSummary>;
	/** 切换 autoSync 开关，返回切换后的值。 */
	toggleAutoSync(): Promise<boolean>;
}

export interface TuiHostOptions {
	initialStatus: TuiStatusSummary;
	theme: ThemeLike;
	actions: TuiHostActions;
	/** 请求重绘。真实运行时是 tui.requestRender。 */
	requestRender: () => void;
	/** 关闭 TUI 并把待办意图交还调用方。 */
	done: (intent: TuiExitIntent | null) => void;
}

/**
 * TUI 的驱动器：持有可变状态，把按键翻译成状态转移与动作执行。
 *
 * 单独成类而非塞进 custom() 的闭包里，是为了让 handleInput 的分派逻辑
 * 可以在测试里直接驱动（见 test/tui-host.test.ts）。
 */
export class TuiHost {
	private state: TuiState;
	private readonly theme: ThemeLike;
	private readonly actions: TuiHostActions;
	private readonly requestRender: () => void;
	private readonly done: (intent: TuiExitIntent | null) => void;

	constructor(options: TuiHostOptions) {
		this.state = createTuiState(options.initialStatus);
		this.theme = options.theme;
		this.actions = options.actions;
		this.requestRender = options.requestRender;
		this.done = options.done;
	}

	/** 仅供测试与渲染读取，外部不应持有引用后改它。 */
	getState(): TuiState {
		return this.state;
	}

	render(): string[] {
		return renderTui(this.state, this.theme);
	}

	private update(next: TuiState): void {
		this.state = next;
		this.requestRender();
	}

	private exit(intent: TuiExitIntent | null): void {
		this.update(closeTui(this.state, intent));
		this.done(intent);
	}

	/**
	 * 处理一次按键。
	 *
	 * 返回 Promise 是因为动作执行是异步的；调用方（组件的 handleInput）
	 * 不能 await，所以内部所有失败都必须自己兜住，不能让 Promise 悬空 reject。
	 */
	async handleInput(data: string): Promise<void> {
		const intent = mapKeyToIntent(this.state, data);
		switch (intent.kind) {
			case "ignore":
				return;
			case "move":
				this.update(moveMenuSelection(this.state, intent.delta));
				return;
			case "toggle": {
				const page = this.state.page.kind;
				this.update(
					page === "confirm"
						? toggleConfirmChoice(this.state)
						: toggleConflictExit(this.state),
				);
				return;
			}
			case "cancel-confirm":
				this.update(cancelConfirm(this.state));
				return;
			case "back-to-menu":
				this.update(returnToMenu(this.state));
				return;
			case "exit":
				this.exit(null);
				return;
			case "activate":
				await this.activate(intent.action);
				return;
			case "confirm-destructive":
				await this.execute(intent.action);
				return;
			case "resolve-conflict":
				// D9：两条出路都只是"转交"。真正的动作（投递 agent 消息、
				// 打印手动步骤）要用到 pi.sendUserMessage / ctx.ui，
				// 在 custom() 内部调用会顶掉 TUI，所以关掉 TUI 再由调用方做。
				this.exit(
					intent.exit === "ask-agent"
						? { kind: "ask-agent" }
						: { kind: "manual-merge" },
				);
				return;
		}
	}

	/** 菜单项被回车：按动作类型分流。 */
	private async activate(action: TuiActionId): Promise<void> {
		switch (action) {
			case "exit":
				this.exit(null);
				return;
			case "view-diff":
				// 差异是全屏输出，同样不能在 TUI 内部弹——交给调用方。
				this.exit({ kind: "show-diff" });
				return;
			case "toggle-auto-sync": {
				try {
					const enabled = await this.actions.toggleAutoSync();
					this.update(setAutoSyncEnabled(this.state, enabled));
				} catch (error) {
					this.update(
						finishAction(this.state, {
							action,
							ok: false,
							message: `切换自动同步失败：${messageOf(error)}`,
							reload: false,
						}),
					);
				}
				return;
			}
			case "pull-overwrite-local":
			case "push-overwrite-remote": {
				// 破坏性动作：先算将丢失的路径，再进确认页。
				let paths: string[] = [];
				try {
					paths = await this.actions.losingPaths(action);
				} catch (error) {
					this.update(
						finishAction(this.state, {
							action,
							ok: false,
							message: `无法确认将要丢弃的内容，已中止：${messageOf(error)}`,
							reload: false,
						}),
					);
					return;
				}
				this.update(beginAction(this.state, action, { paths }));
				return;
			}
			default:
				await this.execute(action);
		}
	}

	/** 真正执行一个动作，期间屏蔽输入并回填进度。 */
	private async execute(action: TuiActionId): Promise<void> {
		this.update(markBusy(this.state, action));
		let result: TuiActionResult;
		try {
			result = await this.actions.run(action, (message) => {
				this.update(setProgress(this.state, message));
			});
		} catch (error) {
			// 动作抛异常不应让 TUI 卡在"执行中"——落到结果页如实报错。
			this.update(
				finishAction(this.state, {
					action,
					ok: false,
					message: `执行失败：${messageOf(error)}`,
					reload: false,
				}),
			);
			return;
		}

		if (result.kind === "aborted") {
			this.update(returnToMenu({ ...this.state, busyAction: null }));
			return;
		}
		if (result.kind === "conflict") {
			this.update(raiseConflict(this.state, result.conflict));
			return;
		}
		if (result.kind === "package-approval") {
			// 审批要弹对话框，面板里弹不了——关掉面板交给调用方。
			this.exit({
				kind: "package-approval",
				action,
				packages: result.packages,
			});
			return;
		}

		// 动作改了仓库状态，刷新总览让界面反映实际结果。
		// 刷新失败不影响结果页展示，沿用旧总览即可。
		const status = await this.actions
			.refreshStatus()
			.catch(() => this.state.status);
		this.update(
			finishAction(this.state, { action, ...result.outcome }, status),
		);
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : "未知错误";
}

/**
 * 构造交给 `ctx.ui.custom()` 的组件。
 *
 * handleInput 不能返回 Promise（Component 接口要求 void），所以这里显式
 * 吞掉 rejection——TuiHost.handleInput 内部已经把所有失败落到结果页了，
 * 这层 catch 只是兜住意料之外的异常，避免 unhandled rejection 打爆终端。
 */
export function createTuiComponent(host: TuiHost): Component {
	return {
		render: () => host.render(),
		invalidate: () => {},
		handleInput: (data: string) => {
			void host.handleInput(data).catch(() => undefined);
		},
	};
}
