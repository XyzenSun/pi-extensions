import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import extension from "../index.ts";
import { PiSyncCommands } from "../src/orchestration/commands.ts";
import type {
	RunResult,
	SyncPlan,
} from "../src/orchestration/operation-result.ts";
import {
	FakeCommandContext,
	FakeExtensionApi,
} from "./helpers/fake-pi.ts";

function register(api: FakeExtensionApi): void {
	extension(api as unknown as ExtensionAPI);
}

function notificationsOf(ctx: FakeCommandContext): string {
	return ctx.ui.notifications
		.map((notification) => notification.message)
		.join("\n");
}

function okResult(): RunResult {
	return {
		ok: true,
		code: "noop",
		message: "Done",
		reload: false,
		mode: "sync",
		phase: "complete",
	};
}

type ReadyPlan = Extract<SyncPlan, { kind: "ready" }>;

function readyPlan(overrides: Partial<ReadyPlan> = {}): ReadyPlan {
	return {
		kind: "ready",
		fingerprint: "fp-1",
		changes: [{ relativePath: "prompts/a.md", changeType: "local_only" }],
		packages: { added: [], removed: [], changed: [] },
		remote: { ahead: 1, behind: 0 },
		pendingRecovery: false,
		message: "Review this plan",
		...overrides,
	};
}

/**
 * 这些用例覆盖的是**对话框式**的逐项选择流程，即非 TUI 模式下 /pisync
 * 走的那条路径。TUI 模式另有面板入口（tui-prd.md §4），行为不同，
 * 由 test/tui-*.test.ts 覆盖，所以这里一律显式用 rpc 模式构造 ctx。
 */
describe("extension per-item selection branches", () => {
	it("stops when the plan is blocked without running", async () => {
		const planSpy = vi
			.spyOn(PiSyncCommands.prototype, "plan")
			.mockResolvedValue({ kind: "blocked", message: "Repo broken" });
		const runSpy = vi.spyOn(PiSyncCommands.prototype, "run");
		try {
			const api = new FakeExtensionApi();
			register(api);
			const ctx = new FakeCommandContext("rpc");

			await api.commands.get("pisync")!.handler(undefined, ctx);

			expect(runSpy).not.toHaveBeenCalled();
			expect(notificationsOf(ctx)).toContain("Repo broken");
		} finally {
			planSpy.mockRestore();
			runSpy.mockRestore();
		}
	});

	it("requires an interactive UI session for confirmation", async () => {
		const planSpy = vi
			.spyOn(PiSyncCommands.prototype, "plan")
			.mockResolvedValue(readyPlan());
		const runSpy = vi.spyOn(PiSyncCommands.prototype, "run");
		try {
			const api = new FakeExtensionApi();
			register(api);
			const ctx = new FakeCommandContext("rpc");
			ctx.hasUI = false;

			await api.commands.get("pisync")!.handler(undefined, ctx);

			expect(runSpy).not.toHaveBeenCalled();
			expect(notificationsOf(ctx)).toContain(
				"同步需要交互式确认",
			);
		} finally {
			planSpy.mockRestore();
			runSpy.mockRestore();
		}
	});

	it("runs without selections when no extension items need decisions", async () => {
		const planSpy = vi
			.spyOn(PiSyncCommands.prototype, "plan")
			.mockResolvedValue(readyPlan());
		const runSpy = vi
			.spyOn(PiSyncCommands.prototype, "run")
			.mockResolvedValue(okResult());
		try {
			const api = new FakeExtensionApi();
			register(api);
			const ctx = new FakeCommandContext("rpc");
			ctx.ui.confirmResponses = [true];

			await api.commands.get("pisync")!.handler(undefined, ctx);

			expect(ctx.ui.selectCalls).toHaveLength(0);
			expect(runSpy).toHaveBeenCalledTimes(1);
			expect(runSpy.mock.calls[0]?.[0]).toMatchObject({
				expectedPlanFingerprint: "fp-1",
			});
		} finally {
			planSpy.mockRestore();
			runSpy.mockRestore();
		}
	});

	it("cancels when the sync plan confirmation is rejected", async () => {
		const planSpy = vi
			.spyOn(PiSyncCommands.prototype, "plan")
			.mockResolvedValue(readyPlan());
		const runSpy = vi.spyOn(PiSyncCommands.prototype, "run");
		try {
			const api = new FakeExtensionApi();
			register(api);
			const ctx = new FakeCommandContext("rpc");
			ctx.ui.confirmResponses = [false];

			await api.commands.get("pisync")!.handler(undefined, ctx);

			expect(runSpy).not.toHaveBeenCalled();
			expect(notificationsOf(ctx)).toContain(
				"已在改动前取消同步。",
			);
		} finally {
			planSpy.mockRestore();
			runSpy.mockRestore();
		}
	});

	it("collects remove/defer/keep decisions in one run", async () => {
		const planSpy = vi.spyOn(PiSyncCommands.prototype, "plan").mockResolvedValue(
			readyPlan({
				changes: [
					{ relativePath: "settings.json", changeType: "remote_only" },
					{
						relativePath: "extensions/foo/a.md",
						changeType: "remote_only",
					},
					{ relativePath: "extensions/bar/b.md", changeType: "local_only" },
				],
				packages: {
					added: [],
					removed: ["npm:old-pkg@1.0.0"],
					changed: [],
				},
			}),
		);
		const runSpy = vi
			.spyOn(PiSyncCommands.prototype, "run")
			.mockResolvedValue(okResult());
		try {
			const api = new FakeExtensionApi();
			register(api);
			const ctx = new FakeCommandContext("rpc");
			ctx.ui.confirmResponses = [true, true];
			ctx.ui.selectResponses = [
				"移除「npm:old-pkg@1.0.0」的残留文件",
				"推迟到后续同步",
				"仅保留在本机",
			];

			await api.commands.get("pisync")!.handler(undefined, ctx);

			expect(ctx.ui.selectCalls).toHaveLength(3);
			expect(ctx.ui.confirmCalls[1]?.title).toBe(
				"是否应用这些扩展决定？",
			);
			const options = runSpy.mock.calls[0]?.[0] as
				| { selections?: Record<string, unknown> }
				| undefined;
			expect(options?.selections).toMatchObject({
				removePackages: ["npm:old-pkg@1.0.0"],
				deferApplyPaths: ["extensions/foo/a.md"],
				keepLocalPaths: ["extensions/bar/b.md"],
			});
		} finally {
			planSpy.mockRestore();
			runSpy.mockRestore();
		}
	});

	it("applies shared extensions and shares local ones without deferrals", async () => {
		const planSpy = vi.spyOn(PiSyncCommands.prototype, "plan").mockResolvedValue(
			readyPlan({
				changes: [
					{
						relativePath: "extensions/foo/a.md",
						changeType: "remote_only",
					},
					{ relativePath: "extensions/bar/b.md", changeType: "local_only" },
				],
			}),
		);
		const runSpy = vi
			.spyOn(PiSyncCommands.prototype, "run")
			.mockResolvedValue(okResult());
		try {
			const api = new FakeExtensionApi();
			register(api);
			const ctx = new FakeCommandContext("rpc");
			ctx.ui.confirmResponses = [true, true];
			ctx.ui.selectResponses = [
				"从共享远端应用「foo」（1 个文件）",
				"与其他机器共享「bar」（1 个文件）",
			];

			await api.commands.get("pisync")!.handler(undefined, ctx);

			const options = runSpy.mock.calls[0]?.[0] as
				| { selections?: Record<string, unknown> }
				| undefined;
			expect(options?.selections).toMatchObject({ reviewed: true });
			expect(options?.selections).not.toHaveProperty("deferApplyPaths");
			expect(options?.selections).not.toHaveProperty("keepLocalPaths");
		} finally {
			planSpy.mockRestore();
			runSpy.mockRestore();
		}
	});

	it("keeps a removed package installed when the user declines cleanup", async () => {
		const planSpy = vi.spyOn(PiSyncCommands.prototype, "plan").mockResolvedValue(
			readyPlan({
				changes: [{ relativePath: "settings.json", changeType: "remote_only" }],
				packages: {
					added: [],
					removed: ["npm:old-pkg@1.0.0"],
					changed: [],
				},
			}),
		);
		const runSpy = vi
			.spyOn(PiSyncCommands.prototype, "run")
			.mockResolvedValue(okResult());
		try {
			const api = new FakeExtensionApi();
			register(api);
			const ctx = new FakeCommandContext("rpc");
			ctx.ui.confirmResponses = [true, true];
			ctx.ui.selectResponses = [
				"在本机保留「npm:old-pkg@1.0.0」",
			];

			await api.commands.get("pisync")!.handler(undefined, ctx);

			const options = runSpy.mock.calls[0]?.[0] as
				| { selections?: Record<string, unknown> }
				| undefined;
			expect(options?.selections).not.toHaveProperty("removePackages");
		} finally {
			planSpy.mockRestore();
			runSpy.mockRestore();
		}
	});

	it("cancels when an extension choice selects Cancel sync", async () => {
		const planSpy = vi.spyOn(PiSyncCommands.prototype, "plan").mockResolvedValue(
			readyPlan({
				changes: [{ relativePath: "settings.json", changeType: "remote_only" }],
				packages: {
					added: ["npm:new-pkg@1.0.0"],
					removed: [],
					changed: [],
				},
			}),
		);
		const runSpy = vi.spyOn(PiSyncCommands.prototype, "run");
		try {
			const api = new FakeExtensionApi();
			register(api);
			const ctx = new FakeCommandContext("rpc");
			ctx.ui.confirmResponses = [true];
			ctx.ui.selectResponses = ["取消同步"];

			await api.commands.get("pisync")!.handler(undefined, ctx);

			expect(runSpy).not.toHaveBeenCalled();
			expect(notificationsOf(ctx)).toContain(
				"已在改动前取消同步。",
			);
		} finally {
			planSpy.mockRestore();
			runSpy.mockRestore();
		}
	});

	it("cancels when an extension choice is dismissed", async () => {
		const planSpy = vi.spyOn(PiSyncCommands.prototype, "plan").mockResolvedValue(
			readyPlan({
				changes: [{ relativePath: "settings.json", changeType: "remote_only" }],
				packages: {
					added: ["npm:new-pkg@1.0.0"],
					removed: [],
					changed: [],
				},
			}),
		);
		const runSpy = vi.spyOn(PiSyncCommands.prototype, "run");
		try {
			const api = new FakeExtensionApi();
			register(api);
			const ctx = new FakeCommandContext("rpc");
			ctx.ui.confirmResponses = [true];
			ctx.ui.selectResponses = [undefined];

			await api.commands.get("pisync")!.handler(undefined, ctx);

			expect(runSpy).not.toHaveBeenCalled();
			expect(notificationsOf(ctx)).toContain(
				"已在改动前取消同步。",
			);
		} finally {
			planSpy.mockRestore();
			runSpy.mockRestore();
		}
	});

	it("cancels when the extension decision summary is rejected", async () => {
		const planSpy = vi.spyOn(PiSyncCommands.prototype, "plan").mockResolvedValue(
			readyPlan({
				changes: [{ relativePath: "settings.json", changeType: "remote_only" }],
				packages: {
					added: ["npm:new-pkg@1.0.0"],
					removed: [],
					changed: [],
				},
			}),
		);
		const runSpy = vi.spyOn(PiSyncCommands.prototype, "run");
		try {
			const api = new FakeExtensionApi();
			register(api);
			const ctx = new FakeCommandContext("rpc");
			ctx.ui.confirmResponses = [true, false];
			ctx.ui.selectResponses = ["安装「npm:new-pkg@1.0.0」"];

			await api.commands.get("pisync")!.handler(undefined, ctx);

			expect(runSpy).not.toHaveBeenCalled();
			expect(notificationsOf(ctx)).toContain(
				"已在改动前取消同步。",
			);
		} finally {
			planSpy.mockRestore();
			runSpy.mockRestore();
		}
	});

	it("resolves pulled extension choices through selection_required", async () => {
		const planSpy = vi
			.spyOn(PiSyncCommands.prototype, "plan")
			.mockResolvedValue({ kind: "setup", message: "Mocked setup plan" });
		const runSpy = vi
			.spyOn(PiSyncCommands.prototype, "run")
			.mockResolvedValueOnce({
				ok: false,
				code: "selection_required",
				message: "Need extension choices",
				reload: false,
				mode: "sync",
				phase: "pull",
				details: {
					extensionSelection: {
						changes: [
							{ relativePath: "settings.json", changeType: "remote_only" },
						],
						packages: {
							added: ["npm:pulled-pkg@1.0.0"],
							changed: [],
							removed: [],
						},
					},
				},
			} satisfies RunResult)
			.mockResolvedValueOnce(okResult());
		try {
			const api = new FakeExtensionApi();
			register(api);
			const ctx = new FakeCommandContext("rpc");
			ctx.ui.confirmResponses = [true];
			ctx.ui.selectResponses = ["安装「npm:pulled-pkg@1.0.0」"];

			await api.commands.get("pisync")!.handler(undefined, ctx);

			expect(runSpy).toHaveBeenCalledTimes(2);
			const secondOptions = runSpy.mock.calls[1]?.[0] as
				| { selections?: Record<string, unknown> }
				| undefined;
			expect(secondOptions?.selections).toMatchObject({
				installPackages: ["npm:pulled-pkg@1.0.0"],
			});
		} finally {
			planSpy.mockRestore();
			runSpy.mockRestore();
		}
	});

	it("merges initial and pulled selections instead of replacing them", async () => {
		const planSpy = vi.spyOn(PiSyncCommands.prototype, "plan").mockResolvedValue(
			readyPlan({
				changes: [{ relativePath: "settings.json", changeType: "remote_only" }],
				packages: {
					added: ["npm:first-pkg@1.0.0"],
					removed: [],
					changed: [],
				},
			}),
		);
		const runSpy = vi
			.spyOn(PiSyncCommands.prototype, "run")
			.mockResolvedValueOnce({
				ok: false,
				code: "selection_required",
				message: "Need more choices",
				reload: false,
				mode: "sync",
				phase: "pull",
				details: {
					extensionSelection: {
						changes: [
							{ relativePath: "settings.json", changeType: "remote_only" },
						],
						packages: {
							added: ["npm:second-pkg@1.0.0", 42],
							changed: [],
							removed: [],
						},
					},
				},
			} satisfies RunResult)
			.mockResolvedValueOnce(okResult());
		try {
			const api = new FakeExtensionApi();
			register(api);
			const ctx = new FakeCommandContext("rpc");
			ctx.ui.confirmResponses = [true, true, true];
			ctx.ui.selectResponses = [
				"安装「npm:first-pkg@1.0.0」",
				"安装「npm:second-pkg@1.0.0」",
			];

			await api.commands.get("pisync")!.handler(undefined, ctx);

			expect(runSpy).toHaveBeenCalledTimes(2);
			const secondOptions = runSpy.mock.calls[1]?.[0] as
				| { selections?: Record<string, unknown> }
				| undefined;
			expect(secondOptions?.selections).toMatchObject({
				installPackages: ["npm:first-pkg@1.0.0", "npm:second-pkg@1.0.0"],
			});
		} finally {
			planSpy.mockRestore();
			runSpy.mockRestore();
		}
	});

	it("reports an unreadable pulled selection request", async () => {
		const planSpy = vi
			.spyOn(PiSyncCommands.prototype, "plan")
			.mockResolvedValue({ kind: "setup", message: "Mocked setup plan" });
		const runSpy = vi
			.spyOn(PiSyncCommands.prototype, "run")
			.mockResolvedValue({
				ok: false,
				code: "selection_required",
				message: "Need extension choices",
				reload: false,
				mode: "sync",
				phase: "pull",
				details: { extensionSelection: "not-an-object" },
			} satisfies RunResult);
		try {
			const api = new FakeExtensionApi();
			register(api);
			const ctx = new FakeCommandContext("rpc");

			await api.commands.get("pisync")!.handler(undefined, ctx);

			expect(runSpy).toHaveBeenCalledTimes(1);
			expect(notificationsOf(ctx)).toContain(
				"无法读取拉取到的配置所需的扩展选择项",
			);
		} finally {
			planSpy.mockRestore();
			runSpy.mockRestore();
		}
	});

	it("reports a pulled selection request with malformed package lists", async () => {
		const planSpy = vi
			.spyOn(PiSyncCommands.prototype, "plan")
			.mockResolvedValue({ kind: "setup", message: "Mocked setup plan" });
		const runSpy = vi
			.spyOn(PiSyncCommands.prototype, "run")
			.mockResolvedValue({
				ok: false,
				code: "selection_required",
				message: "Need extension choices",
				reload: false,
				mode: "sync",
				phase: "pull",
				details: {
					extensionSelection: {
						changes: "not-an-array",
						packages: { added: "nope", changed: [], removed: [] },
					},
				},
			} satisfies RunResult);
		try {
			const api = new FakeExtensionApi();
			register(api);
			const ctx = new FakeCommandContext("rpc");

			await api.commands.get("pisync")!.handler(undefined, ctx);

			expect(runSpy).toHaveBeenCalledTimes(1);
			expect(notificationsOf(ctx)).toContain(
				"无法读取拉取到的配置所需的扩展选择项",
			);
		} finally {
			planSpy.mockRestore();
			runSpy.mockRestore();
		}
	});

	it("cancels pulled selections when the user dismisses them", async () => {
		const planSpy = vi
			.spyOn(PiSyncCommands.prototype, "plan")
			.mockResolvedValue({ kind: "setup", message: "Mocked setup plan" });
		const runSpy = vi
			.spyOn(PiSyncCommands.prototype, "run")
			.mockResolvedValue({
				ok: false,
				code: "selection_required",
				message: "Need extension choices",
				reload: false,
				mode: "sync",
				phase: "pull",
				details: {
					extensionSelection: {
						changes: [
							{ relativePath: "settings.json", changeType: "remote_only" },
						],
						packages: {
							added: ["npm:pulled-pkg@1.0.0"],
							changed: [],
							removed: [],
						},
					},
				},
			} satisfies RunResult);
		try {
			const api = new FakeExtensionApi();
			register(api);
			const ctx = new FakeCommandContext("rpc");
			ctx.ui.selectResponses = ["取消同步"];

			await api.commands.get("pisync")!.handler(undefined, ctx);

			expect(runSpy).toHaveBeenCalledTimes(1);
			expect(notificationsOf(ctx)).toContain(
				"已在改动前取消同步。",
			);
		} finally {
			planSpy.mockRestore();
			runSpy.mockRestore();
		}
	});
});
