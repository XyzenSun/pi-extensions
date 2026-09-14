import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import extension from "../index.ts";
import { PiSyncCommands } from "../src/orchestration/commands.ts";
import type { RunResult } from "../src/orchestration/operation-result.ts";
import type { TuiStatusSnapshot } from "../src/orchestration/commands.ts";
import { createTuiComponent, TuiHost } from "../src/extension/tui-host.ts";
import type { TuiExitIntent } from "../src/extension/tui-state.ts";
import { FakeCommandContext, FakeExtensionApi, FakeUi } from "./helpers/fake-pi.ts";

function register(api: FakeExtensionApi): void {
	extension(api as unknown as ExtensionAPI);
}

function snapshot(
	overrides: Partial<TuiStatusSnapshot> = {},
): TuiStatusSnapshot {
	return {
		branch: "main",
		ahead: 0,
		behind: 0,
		pendingChanges: 0,
		conflicts: 0,
		autoSyncEnabled: false,
		lastSyncedAt: null,
		...overrides,
	};
}

/**
 * 驱动 custom() 的假 UI：捕获组件工厂，允许测试模拟按键并主动收尾。
 *
 * 真实 pi-tui 会把组件挂到终端上；这里只取出组件本身，直接调 handleInput，
 * 因此不需要终端也能验证"面板 → 编排层"的接线。
 */
class TuiFakeUi extends FakeUi {
	lastComponent: ReturnType<typeof createTuiComponent> | null = null;
	/** 测试注入的脚本：拿到组件后按顺序送入这些按键。 */
	script: string[] = [];
	/** 开过几次面板。用于断言审批不会把面板再画回来。 */
	panelOpenCount = 0;
	renderRequests = 0;
	captureFirstFrame = false;
	firstFrame: string[] = [];

	async custom<T>(renderer: unknown): Promise<T | undefined> {
		const factory = renderer as (
			tui: { requestRender(): void },
			theme: { fg(role: string, text: string): string; bold(text: string): string },
			keybindings: unknown,
			done: (value?: T) => void,
		) => ReturnType<typeof createTuiComponent>;

		let settle!: (value: T | undefined) => void;
		const finished = new Promise<T | undefined>((resolve) => {
			settle = resolve;
		});
		const component = factory(
			{ requestRender: () => { this.renderRequests += 1; } },
			{ fg: (_role, text) => text, bold: (text) => text },
			undefined,
			(value) => settle(value),
		);
		this.lastComponent = component;
		if (this.captureFirstFrame) this.firstFrame = component.render(80);
		this.panelOpenCount += 1;

		for (const key of this.script) {
			component.handleInput?.(key);
			// 让动作里的 await 链推进完再送下一个键。
			await new Promise((resolve) => setImmediate(resolve));
		}
		return await finished;
	}
}

function tuiContext(script: string[]): FakeCommandContext {
	const ctx = new FakeCommandContext("tui");
	const ui = new TuiFakeUi();
	ui.script = script;
	ui.confirmResponses = ctx.ui.confirmResponses;
	ui.selectResponses = ctx.ui.selectResponses;
	ui.inputResponses = ctx.ui.inputResponses;
	ctx.ui = ui;
	return ctx;
}

const KEYS = {
	up: "\x1b[A",
	down: "\x1b[B",
	enter: "\r",
	escape: "\x1b",
} as const;

function okRun(message = "已完成"): RunResult {
	return {
		ok: true,
		code: "ok",
		message,
		reload: false,
		mode: "sync",
		phase: "complete",
	};
}

describe.sequential("pisync TUI entry (tui-prd 4)", () => {
	it("opens the panel in TUI mode instead of the dialog flow", async () => {
		const statusSpy = vi
			.spyOn(PiSyncCommands.prototype, "statusSummary")
			.mockResolvedValue(snapshot({ pendingChanges: 2 }));
		const planSpy = vi.spyOn(PiSyncCommands.prototype, "plan");
		try {
			const api = new FakeExtensionApi();
			register(api);
			// 直接 Esc 退出面板。
			const ctx = tuiContext([KEYS.escape]);

			await api.commands.get("pisync")!.handler(undefined, ctx);

			// 进的是面板，不是对话框式流程。
			expect(planSpy).not.toHaveBeenCalled();
			expect(ctx.ui.confirmCalls).toHaveLength(0);
			expect((ctx.ui as TuiFakeUi).lastComponent).not.toBeNull();
		} finally {
			statusSpy.mockRestore();
			planSpy.mockRestore();
		}
	});

	it("falls back to the dialog flow outside TUI mode", async () => {
		// custom() 在非 TUI 模式返回 undefined，不显式分流会静默失效。
		const statusSpy = vi
			.spyOn(PiSyncCommands.prototype, "statusSummary")
			.mockResolvedValue(snapshot());
		const planSpy = vi
			.spyOn(PiSyncCommands.prototype, "plan")
			.mockResolvedValue({ kind: "blocked", message: "Repo broken" });
		try {
			const api = new FakeExtensionApi();
			register(api);
			const ctx = new FakeCommandContext("rpc");

			await api.commands.get("pisync")!.handler(undefined, ctx);

			expect(planSpy).toHaveBeenCalled();
			expect(
				ctx.ui.notifications.map((n) => n.message).join("\n"),
			).toContain("Repo broken");
		} finally {
			statusSpy.mockRestore();
			planSpy.mockRestore();
		}
	});

	it("routes to setup when the repository is not initialized", async () => {
		const statusSpy = vi
			.spyOn(PiSyncCommands.prototype, "statusSummary")
			.mockResolvedValue(null);
		const planSpy = vi
			.spyOn(PiSyncCommands.prototype, "plan")
			.mockResolvedValue({ kind: "setup", message: "需要初始化" });
		try {
			const api = new FakeExtensionApi();
			register(api);
			const ctx = tuiContext([]);

			await api.commands.get("pisync")!.handler(undefined, ctx);

			// 未初始化不进面板，走初始化流程。
			expect(planSpy).toHaveBeenCalled();
			expect((ctx.ui as TuiFakeUi).lastComponent).toBeNull();
		} finally {
			statusSpy.mockRestore();
			planSpy.mockRestore();
		}
	});

	it("runs the smart pull as a one-way pull, not a full sync", async () => {
		const statusSpy = vi
			.spyOn(PiSyncCommands.prototype, "statusSummary")
			.mockResolvedValue(snapshot({ behind: 1 }));
		const pullSpy = vi
			.spyOn(PiSyncCommands.prototype, "pull")
			.mockResolvedValue({
				ok: true,
				code: "ok",
				message: "已拉取 1 个文件",
				reload: false,
			});
		const runSpy = vi.spyOn(PiSyncCommands.prototype, "run");
		const pushSpy = vi.spyOn(PiSyncCommands.prototype, "push");
		const pullOnlySpy = vi.spyOn(PiSyncCommands.prototype, "pullOnly");
		try {
			const api = new FakeExtensionApi();
			register(api);
			// Enter 执行首项（智能化拉取）→ Esc 关闭结果页。
			const ctx = tuiContext([KEYS.enter, KEYS.escape]);

			await api.commands.get("pisync")!.handler(undefined, ctx);

			// 菜单写的是"拉取"，就只能拉取：run() 是完整双向同步，
			// 用它会让"拉取"顺带把本机改动推上远端。
			expect(pullSpy).toHaveBeenCalled();
			expect(runSpy).not.toHaveBeenCalled();
			expect(pushSpy).not.toHaveBeenCalled();
			// 与直达命令的差别在审批，不在流程。
			expect(pullOnlySpy).not.toHaveBeenCalled();
		} finally {
			statusSpy.mockRestore();
			pullSpy.mockRestore();
			runSpy.mockRestore();
			pushSpy.mockRestore();
			pullOnlySpy.mockRestore();
		}
	});

	it("runs the smart push as a one-way push", async () => {
		const statusSpy = vi
			.spyOn(PiSyncCommands.prototype, "statusSummary")
			.mockResolvedValue(snapshot({ ahead: 1 }));
		const pushSpy = vi
			.spyOn(PiSyncCommands.prototype, "push")
			.mockResolvedValue({
				ok: true,
				code: "ok",
				message: "已推送",
				reload: false,
			});
		const pullSpy = vi.spyOn(PiSyncCommands.prototype, "pull");
		const runSpy = vi.spyOn(PiSyncCommands.prototype, "run");
		try {
			const api = new FakeExtensionApi();
			register(api);
			// ↓↓ 移到"智能化推送" → Enter → Esc。
			const ctx = tuiContext([
				KEYS.down,
				KEYS.down,
				KEYS.enter,
				KEYS.escape,
			]);

			await api.commands.get("pisync")!.handler(undefined, ctx);

			expect(pushSpy).toHaveBeenCalled();
			expect(pullSpy).not.toHaveBeenCalled();
			expect(runSpy).not.toHaveBeenCalled();
		} finally {
			statusSpy.mockRestore();
			pushSpy.mockRestore();
			pullSpy.mockRestore();
			runSpy.mockRestore();
		}
	});

	it("asks for package approval after closing the panel, then finishes the action (D5)", async () => {
		const statusSpy = vi
			.spyOn(PiSyncCommands.prototype, "statusSummary")
			.mockResolvedValue(snapshot({ behind: 1 }));
		const pullSpy = vi
			.spyOn(PiSyncCommands.prototype, "pull")
			.mockImplementation(async (_repo, approval) => {
				// 首次要求审批；带着审批重试才放行。
				if (!approval) {
					return {
						ok: false,
						code: "approval_required",
						message: "需要批准包安装",
						reload: false,
						details: { packages: ["npm:some-package"] },
					};
				}
				return {
					ok: true,
					code: "ok",
					message: "已安装并拉取",
					reload: false,
				};
			});
		try {
			const api = new FakeExtensionApi();
			register(api);
			// Enter 触发拉取 → 需要审批 → 面板关闭 → 弹审批框。
			const ctx = tuiContext([KEYS.enter]);
			ctx.ui.confirmResponses.push(true);

			await api.commands.get("pisync")!.handler(undefined, ctx);

			// TUI 保留审批：必须弹过确认框（面板内弹不了，所以在关闭后弹）。
			expect(ctx.ui.confirmCalls.map((call) => call.title)).toContain(
				"pi-sync: 批准包安装",
			);
			expect(ctx.ui.confirmCalls[0]?.message).toContain("npm:some-package");
			// 批准后直接把动作跑完，不重开面板。
			expect(pullSpy).toHaveBeenCalledTimes(2);
			expect(pullSpy.mock.calls[1]?.[1]).toMatchObject({
				approvedSources: ["npm:some-package"],
				// 一次审批只对本次生效，不扩大持久信任。
				remember: false,
			});
			// 结果通过通知汇报，面板已经关了。
			expect(
				ctx.ui.notifications.map((n) => n.message).join("\n"),
			).toContain("已安装并拉取");
			// 只开过一次面板。
			expect((ctx.ui as TuiFakeUi).panelOpenCount).toBe(1);
		} finally {
			statusSpy.mockRestore();
			pullSpy.mockRestore();
		}
	});

	it("stops without installing when package approval is declined", async () => {
		const statusSpy = vi
			.spyOn(PiSyncCommands.prototype, "statusSummary")
			.mockResolvedValue(snapshot({ behind: 1 }));
		const pullSpy = vi
			.spyOn(PiSyncCommands.prototype, "pull")
			.mockResolvedValue({
				ok: false,
				code: "approval_required",
				message: "需要批准包安装",
				reload: false,
				details: { packages: ["npm:some-package"] },
			});
		try {
			const api = new FakeExtensionApi();
			register(api);
			const ctx = tuiContext([KEYS.enter]);
			ctx.ui.confirmResponses.push(false);

			await api.commands.get("pisync")!.handler(undefined, ctx);

			expect(
				ctx.ui.notifications.map((n) => n.message).join("\n"),
			).toContain("已取消包安装");
			// 拒绝就到此为止，不重跑、不装包。
			expect(pullSpy).toHaveBeenCalledTimes(1);
		} finally {
			statusSpy.mockRestore();
			pullSpy.mockRestore();
		}
	});

	it("previews losing paths before a destructive action", async () => {
		const statusSpy = vi
			.spyOn(PiSyncCommands.prototype, "statusSummary")
			.mockResolvedValue(snapshot({ pendingChanges: 2 }));
		const previewSpy = vi
			.spyOn(PiSyncCommands.prototype, "previewOverwrite")
			.mockResolvedValue(["prompts/a.md", "prompts/b.md"]);
		const overwriteSpy = vi.spyOn(
			PiSyncCommands.prototype,
			"overwriteFromRemote",
		);
		try {
			const api = new FakeExtensionApi();
			register(api);
			// 移到"以远端覆盖本机" → Enter 进确认页 → Esc 取消 → Esc 退出。
			const ctx = tuiContext([
				KEYS.down,
				KEYS.enter,
				KEYS.escape,
				KEYS.escape,
			]);

			await api.commands.get("pisync")!.handler(undefined, ctx);

			expect(previewSpy).toHaveBeenCalledWith("pull");
			// 停在确认页就取消，不该真的执行。
			expect(overwriteSpy).not.toHaveBeenCalled();
		} finally {
			statusSpy.mockRestore();
			previewSpy.mockRestore();
			overwriteSpy.mockRestore();
		}
	});

	it("executes the overwrite only after the confirm cursor moves off cancel", async () => {
		const statusSpy = vi
			.spyOn(PiSyncCommands.prototype, "statusSummary")
			.mockResolvedValue(snapshot({ pendingChanges: 1 }));
		const previewSpy = vi
			.spyOn(PiSyncCommands.prototype, "previewOverwrite")
			.mockResolvedValue(["prompts/a.md"]);
		const overwriteSpy = vi
			.spyOn(PiSyncCommands.prototype, "overwriteFromRemote")
			.mockResolvedValue(okRun("本机已对齐到远端"));
		try {
			const api = new FakeExtensionApi();
			register(api);
			// 移到覆盖档 → Enter 进确认页 → ↓ 切到"确认执行" → Enter → Esc。
			const ctx = tuiContext([
				KEYS.down,
				KEYS.enter,
				KEYS.down,
				KEYS.enter,
				KEYS.escape,
			]);

			await api.commands.get("pisync")!.handler(undefined, ctx);

			expect(overwriteSpy).toHaveBeenCalled();
		} finally {
			statusSpy.mockRestore();
			previewSpy.mockRestore();
			overwriteSpy.mockRestore();
		}
	});

	it("hands a Git conflict to the agent after the panel closes", async () => {
		const statusSpy = vi
			.spyOn(PiSyncCommands.prototype, "statusSummary")
			.mockResolvedValue(snapshot());
		const repoSpy = vi
			.spyOn(PiSyncCommands.prototype, "getConflictRepoPath")
			.mockResolvedValue("/tmp/config-repo");
		const runSpy = vi.spyOn(PiSyncCommands.prototype, "push").mockResolvedValue({
			ok: false,
			code: "blocked_conflict",
			message: "检测到同步冲突",
			reload: false,
			details: {
				conflict: {
					kind: "sync_conflict",
					sharedBranch: "main",
					deviceBranch: "pisync-device/test",
					deviceHead: "abc123",
					paths: [
						{ relativePath: "prompts/welcome.md", changeType: "git_conflict" },
					],
				},
			},
		});
		try {
			const api = new FakeExtensionApi();
			register(api);
			// ↓↓ 移到"智能化推送" → Enter 执行 → 落到冲突页（默认"我自己处理"）
			// → ↓ 切到 agent → Enter。
			const ctx = tuiContext([
				KEYS.down,
				KEYS.down,
				KEYS.enter,
				KEYS.down,
				KEYS.enter,
			]);

			await api.commands.get("pisync")!.handler(undefined, ctx);

			// 消息只能在面板关闭后投递，否则会顶掉 TUI。
			expect(api.sentUserMessages).toHaveLength(1);
			expect(api.sentUserMessages[0]?.content).toContain(
				"请解决 /tmp/config-repo 中的 pi-sync 冲突。",
			);
			expect(api.sentUserMessages[0]?.content).toContain("prompts/welcome.md");
		} finally {
			statusSpy.mockRestore();
			repoSpy.mockRestore();
			runSpy.mockRestore();
		}
	});

	it("shows manual merge guidance when the user keeps the conflict", async () => {
		const statusSpy = vi
			.spyOn(PiSyncCommands.prototype, "statusSummary")
			.mockResolvedValue(snapshot());
		const runSpy = vi.spyOn(PiSyncCommands.prototype, "push").mockResolvedValue({
			ok: false,
			code: "blocked_conflict",
			message: "检测到同步冲突\n请将当前设备分支合并到共享 branch：\n  git merge origin/pisync-device/test",
			reload: false,
			details: {
				conflict: {
					kind: "sync_conflict",
					sharedBranch: "main",
					deviceBranch: "pisync-device/test",
					deviceHead: "abc123",
					paths: [],
				},
			},
		});
		try {
			const api = new FakeExtensionApi();
			register(api);
			// ↓↓ 移到"智能化推送" → Enter 执行 → 冲突页默认停在"我自己处理"
			// → Enter 确认。
			const ctx = tuiContext([
				KEYS.down,
				KEYS.down,
				KEYS.enter,
				KEYS.enter,
			]);

			await api.commands.get("pisync")!.handler(undefined, ctx);

			expect(api.sentUserMessages).toHaveLength(0);
			expect(
				ctx.ui.notifications.map((n) => n.message).join("\n"),
			).toContain("git merge origin/pisync-device/test");
		} finally {
			statusSpy.mockRestore();
			runSpy.mockRestore();
		}
	});

	it("toggles autoSync through the orchestration layer", async () => {
		const statusSpy = vi
			.spyOn(PiSyncCommands.prototype, "statusSummary")
			.mockResolvedValue(snapshot());
		const toggleSpy = vi
			.spyOn(PiSyncCommands.prototype, "toggleAutoSync")
			.mockResolvedValue(true);
		try {
			const api = new FakeExtensionApi();
			register(api);
			// 菜单第 6 项是设置：↓×5 → Enter → Esc。
			const ctx = tuiContext([
				KEYS.down,
				KEYS.down,
				KEYS.down,
				KEYS.down,
				KEYS.down,
				KEYS.enter,
				KEYS.escape,
			]);

			await api.commands.get("pisync")!.handler(undefined, ctx);

			expect(toggleSpy).toHaveBeenCalled();
		} finally {
			statusSpy.mockRestore();
			toggleSpy.mockRestore();
		}
	});

	it("renders the status summary into the panel", async () => {
		const statusSpy = vi
			.spyOn(PiSyncCommands.prototype, "statusSummary")
			.mockResolvedValue(snapshot({ ahead: 2, behind: 1, conflicts: 1 }));
		try {
			const api = new FakeExtensionApi();
			register(api);
			const ctx = tuiContext([KEYS.escape]);
			// 关闭后组件渲染为空，所以在送 Esc 之前先抓一帧。
			(ctx.ui as TuiFakeUi).captureFirstFrame = true;

			await api.commands.get("pisync")!.handler(undefined, ctx);

			const rendered = (ctx.ui as TuiFakeUi).firstFrame.join("\n");
			expect(rendered).toContain("分支 main");
			expect(rendered).toContain("待推送 2 · 待拉取 1");
			expect(rendered).toContain("1 个冲突");
			// 菜单四项主功能都在，退出项也在。
			expect(rendered).toContain("智能化拉取");
			expect(rendered).toContain("以远端覆盖本机");
			expect(rendered).toContain("智能化推送");
			expect(rendered).toContain("以本机覆盖远端");
			expect(rendered).toContain("退出");
		} finally {
			statusSpy.mockRestore();
		}
	});
});