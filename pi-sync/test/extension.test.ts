import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { SyncStatus } from "../src/extension/status-manager.ts";
import { PiSyncCommands } from "../src/orchestration/commands.ts";
import type { RunResult } from "../src/orchestration/operation-result.ts";
import {
	FakeExtensionApi,
	FakeCommandContext,
	FakeUi,
} from "./helpers/fake-pi.ts";
import { saveState } from "../src/system/state.ts";
import { createPiSyncConfig, createSyncState } from "./helpers/factories.ts";
import { createGitFixture, runGit } from "./helpers/git-fixture.ts";
import {
	createTestEnvironment,
	type TestEnvironment,
	withTestEnvironment,
} from "./helpers/temp-env.ts";

let isolatedEnvironment: TestEnvironment;

beforeAll(async () => {
	isolatedEnvironment = await createTestEnvironment("pi-git-sync-extension-");
});

afterAll(async () => {
	await isolatedEnvironment.cleanup();
});

/** Cast the fake API to the real type for testing the extension entry point. */
function register(api: FakeExtensionApi): void {
	extension(api as unknown as ExtensionAPI);
}

/**
 * A FakeUi that intercepts `custom()` used by `showOutput` and converts
 * it into a notification so we can assert on the rendered content.
 */
class RpcFakeUi extends FakeUi {
	private _showOutputText = "";

	async custom<T>(_renderer: unknown): Promise<T | undefined> {
		try {
			const fn = _renderer as (
				tui: unknown,
				theme: { fg: (role: string, text: string) => string },
				kb: unknown,
				done: (val?: T) => void,
			) => { render: (w: number) => string[] };
			const done = () => {};
			const theme = { fg: (_role: string, text: string) => text };
			const result = fn(undefined, theme, undefined, done);
			const lines = result.render(80);
			this._showOutputText = lines.join("\n");
		} catch {
			// Ignore
		}
		return undefined;
	}

	get showOutputText(): string {
		return this._showOutputText;
	}
}

function createRpcContext(): FakeCommandContext {
	const ctx = new FakeCommandContext("rpc");
	const rpcUi = new RpcFakeUi();
	rpcUi.confirmResponses = ctx.ui.confirmResponses;
	rpcUi.inputResponses = ctx.ui.inputResponses;
	rpcUi.selectResponses = ctx.ui.selectResponses;
	ctx.ui = rpcUi;
	return ctx;
}

function showOutputOf(ctx: FakeCommandContext): string {
	return (ctx.ui as RpcFakeUi).showOutputText;
}

function notificationTextOf(ctx: FakeCommandContext): string {
	return ctx.ui.notifications
		.map((notification) => notification.message)
		.join("\n");
}

const config = {
	schemaVersion: 2,
	branch: "main",
	root: "sync",
	include: ["prompts/**", "settings.json"],
	exclude: [],
	delete: "tracked",
} as const;

const noStatusUpdates: never[] = [];

async function seedConfigRepo(
	repoPath: string,
	configOverride: Record<string, unknown> = config,
): Promise<void> {
	await mkdir(join(repoPath, "sync/prompts"), { recursive: true });
	await writeFile(
		join(repoPath, "pi-sync.json"),
		JSON.stringify(configOverride),
		"utf-8",
	);
	await writeFile(join(repoPath, "sync/prompts/welcome.md"), "base\n", "utf-8");
	await writeFile(
		join(repoPath, "sync/settings.json"),
		JSON.stringify({ packages: ["npm:@xyzensun/pi-sync"] }),
		"utf-8",
	);
	await runGit(repoPath, ["add", "--all"]);
	await runGit(repoPath, [
		"commit",
		"--no-gpg-sign",
		"-m",
		"Initialize sync config",
	]);
}

describe("Extension registration", () => {
	it("registers pisync command with description and handler", () => {
		const api = new FakeExtensionApi();
		register(api);

		const cmd = api.commands.get("pisync");
		expect(cmd).toBeDefined();
		expect(cmd!.description).toBeDefined();
		expect(cmd!.description).not.toMatch(/init|pull|push/);
		expect(typeof cmd!.handler).toBe("function");
	});

	it("completes the pull, push, status and diff arguments", () => {
		const api = new FakeExtensionApi();
		register(api);

		const completions = api.commands
			.get("pisync")!
			.getArgumentCompletions?.("");

		expect(completions).toEqual([
			{
				value: "pull",
				label: "pull",
				description: "智能化拉取：零询问，冲突自动远端优先",
			},
			{
				value: "push",
				label: "push",
				description: "智能化推送：除冲突外零询问",
			},
			{
				value: "status",
				label: "status",
				description: "显示详细同步状态",
			},
			{
				value: "diff",
				label: "diff",
				description: "显示同步前的待处理变更",
			},
		]);
		// 前缀过滤：输入 pull 只提示 pull；未注册的命令名无补全。
		expect(
			api.commands.get("pisync")!.getArgumentCompletions?.("pull"),
		).toEqual([
			{
				value: "pull",
				label: "pull",
				description: "智能化拉取：零询问，冲突自动远端优先",
			},
		]);
		expect(
			api.commands.get("pisync")!.getArgumentCompletions?.("init"),
		).toBeNull();
	});

	it("registers session_start and session_shutdown event handlers", () => {
		const api = new FakeExtensionApi();
		register(api);

		expect(api.eventHandlers.has("session_start")).toBe(true);
		expect(api.eventHandlers.has("session_shutdown")).toBe(true);
	});

	it("checks sync in the background before updating its status", async () => {
		let resolveCheck!: (needsSync: boolean) => void;
		const checkPromise = new Promise<boolean>((resolve) => {
			resolveCheck = resolve;
		});
		const check = vi
			.spyOn(PiSyncCommands.prototype, "needsSync")
			.mockReturnValue(checkPromise);
		const api = new FakeExtensionApi();
		register(api);
		const ctx = new FakeCommandContext();

		await api.emit("session_start", {}, ctx);
		expect(ctx.ui.statusUpdates).toEqual([]);
		expect(ctx.ui.notifications).toEqual([]);

		resolveCheck(true);
		await checkPromise;
		await Promise.resolve();
		expect(ctx.ui.statusUpdates).toEqual([
			{ key: "pi-sync", value: SyncStatus.SyncNeeded },
		]);
		expect(ctx.ui.notifications).toEqual([]);
		check.mockRestore();
	});

	it("clears Sync needed after a successful sync", async () => {
		const check = vi
			.spyOn(PiSyncCommands.prototype, "needsSync")
			.mockResolvedValue(true);
		const run = vi.spyOn(PiSyncCommands.prototype, "run").mockResolvedValue({
			ok: true,
			code: "ok",
			message: "Sync completed.",
			reload: false,
			mode: "sync",
			phase: "complete",
		});
		try {
			const api = new FakeExtensionApi();
			register(api);
			const ctx = new FakeCommandContext();

			await api.emit("session_start", {}, ctx);
			await Promise.resolve();
			await api.commands.get("pisync")!.handler(undefined, ctx);

			expect(ctx.ui.statusUpdates).toEqual([
				{ key: "pi-sync", value: SyncStatus.SyncNeeded },
				{ key: "pi-sync", value: undefined },
			]);
		} finally {
			check.mockRestore();
			run.mockRestore();
		}
	});

	it("ignores a completed background check after session shutdown", async () => {
		let resolveCheck!: (needsSync: boolean) => void;
		const checkPromise = new Promise<boolean>((resolve) => {
			resolveCheck = resolve;
		});
		const check = vi
			.spyOn(PiSyncCommands.prototype, "needsSync")
			.mockReturnValue(checkPromise);
		const api = new FakeExtensionApi();
		register(api);
		const ctx = new FakeCommandContext();

		await api.emit("session_start", {}, ctx);
		await api.emit("session_shutdown", {}, ctx);
		resolveCheck(true);
		await checkPromise;
		await Promise.resolve();

		expect(ctx.ui.statusUpdates).toEqual([
			{ key: "pi-sync", value: undefined },
		]);
		expect(ctx.ui.notifications).toEqual([]);
		check.mockRestore();
	});
});

describe("pisync command routing", () => {
	it("dispatches no arguments to setup or sync instead of opening a menu", async () => {
		const api = new FakeExtensionApi();
		register(api);
		const ctx = createRpcContext();

		const cmd = api.commands.get("pisync")!;
		await cmd.handler(undefined, ctx);

		expect(ctx.ui.selectCalls).toHaveLength(0);
		expect(ctx.ui.inputCalls).toHaveLength(1);
		expect(notificationTextOf(ctx)).toContain("已取消初始化。");
		expect(ctx.ui.statusUpdates).toEqual(noStatusUpdates);
	});

	it("rejects unknown arguments and lists supported commands", async () => {
		const api = new FakeExtensionApi();
		register(api);
		const ctx = createRpcContext();

		await api.commands.get("pisync")!.handler("unknown", ctx);

		expect(ctx.ui.selectCalls).toHaveLength(0);
		expect(ctx.ui.inputCalls).toHaveLength(0);
		expect(notificationTextOf(ctx)).toContain(
			"支持的命令：/pisync、/pisync pull、/pisync push、/pisync status 和 /pisync diff。",
		);
	});

	it.each(["init", "push --continue"])(
		"rejects the removed %s command without side effects",
		async (removedCommand) => {
			const api = new FakeExtensionApi();
			register(api);
			const ctx = createRpcContext();

			await api.commands.get("pisync")!.handler(removedCommand, ctx);

			expect(ctx.ui.selectCalls).toHaveLength(0);
			expect(ctx.ui.inputCalls).toHaveLength(0);
			expect(notificationTextOf(ctx)).toContain(
				"支持的命令：/pisync、/pisync pull、/pisync push、/pisync status 和 /pisync diff。",
			);
		},
	);

	it("routes to status subcommand", async () => {
		const api = new FakeExtensionApi();
		register(api);
		const ctx = createRpcContext();

		const cmd = api.commands.get("pisync")!;
		await cmd.handler("status", ctx);

		// Status is a non-blocking notification, not a focused custom component.
		expect(notificationTextOf(ctx)).toContain("尚未配置配置仓库");
		expect(showOutputOf(ctx)).toBe("");
	});

	it("routes to diff subcommand", async () => {
		const api = new FakeExtensionApi();
		register(api);
		const ctx = createRpcContext();

		const cmd = api.commands.get("pisync")!;
		await cmd.handler("diff", ctx);

		expect(showOutputOf(ctx)).toContain("尚未配置配置仓库");
	});

	it("rejects arbitrary unknown arguments without side effects", async () => {
		const api = new FakeExtensionApi();
		register(api);
		const ctx = createRpcContext();

		await api.commands.get("pisync")!.handler("doctor", ctx);

		expect(ctx.ui.selectCalls).toHaveLength(0);
		expect(ctx.ui.inputCalls).toHaveLength(0);
		expect(notificationTextOf(ctx)).toContain(
			"支持的命令：/pisync、/pisync pull、/pisync push、/pisync status 和 /pisync diff。",
		);
	});

	it("uses setup terminology when the initial URL input is cancelled", async () => {
		const api = new FakeExtensionApi();
		register(api);
		const ctx = createRpcContext();

		await api.commands.get("pisync")!.handler(undefined, ctx);

		expect(ctx.ui.notifications).toContainEqual(
			expect.objectContaining({ message: "已取消初始化。" }),
		);
	});

	it("does not reload when setup input is cancelled", async () => {
		const api = new FakeExtensionApi();
		register(api);
		const ctx = createRpcContext();

		await api.commands.get("pisync")!.handler(undefined, ctx);

		expect(ctx.reloadCalls).toBe(0);
	});

	it("trims extra whitespace from args", async () => {
		const api = new FakeExtensionApi();
		register(api);
		const ctx = createRpcContext();

		const cmd = api.commands.get("pisync")!;
		await cmd.handler("  status  ", ctx);

		expect(notificationTextOf(ctx)).toContain("尚未配置配置仓库");
		expect(showOutputOf(ctx)).toBe("");
	});
});

describe.sequential("Extension push command interaction flow", () => {
	it("push flow asks before reloading after sync completes", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceBPath);
			await runGit(fixture.deviceBPath, ["push", "origin", "main"]);
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
				}),
			);

			const api = new FakeExtensionApi();
			register(api);
			const ctx = createRpcContext();
			ctx.ui.confirmResponses = [true];

			const cmd = api.commands.get("pisync")!;
			await cmd.handler(undefined, ctx);

			expect(ctx.ui.confirmCalls).toHaveLength(2);
			expect(ctx.ui.confirmCalls[0]?.title).toBe("同步计划");
			expect(ctx.ui.confirmCalls[1]?.title).toBe("是否 reload Pi？");
			expect(ctx.reloadCalls).toBe(0);
			expect(ctx.ui.notifications.length).toBeGreaterThan(0);
		});
	});

	it("push flow omits the diff and pushes immediately", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
			await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);

			const { sha256 } = await import("../src/sync/inventory.ts");
			await environment.writeAgentFile("prompts/welcome.md", "base\n");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"prompts/welcome.md": { sha256: sha256("base\n"), mode: 0o644 },
					},
				}),
			);

			await environment.writeAgentFile(
				"prompts/welcome.md",
				"changed for push\n",
			);

			const api = new FakeExtensionApi();
			register(api);
			const ctx = createRpcContext();
			ctx.ui.confirmResponses = [true];

			const cmd = api.commands.get("pisync")!;
			await cmd.handler(undefined, ctx);

			expect(ctx.ui.confirmCalls).toEqual([
				expect.objectContaining({ title: "同步计划" }),
				{
					title: "是否 reload Pi？",
					message:
						"同步已更新你的配置。现在 reload Pi 以应用这些改动吗？",
				},
			]);
			expect(notificationTextOf(ctx)).toContain(
				"Push：工作区无改动；已把领先的提交同步到共享 branch 与设备分支",
			);
			expect(notificationTextOf(ctx)).not.toContain("diff --git");
			expect(ctx.ui.notifications.at(-1)).toMatchObject({
				message: expect.stringContaining("◆ pi-sync: 同步完成。"),
				level: "info",
			});
			expect(ctx.reloadCalls).toBe(0);
		});
	});

	it("reloads after the user confirms a successful sync that requires it", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
			await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);

			const { sha256 } = await import("../src/sync/inventory.ts");
			await environment.writeAgentFile("prompts/welcome.md", "base\n");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"prompts/welcome.md": { sha256: sha256("base\n"), mode: 0o644 },
					},
				}),
			);

			await environment.writeAgentFile(
				"prompts/welcome.md",
				"changed for push test\n",
			);

			const api = new FakeExtensionApi();
			register(api);
			const ctx = createRpcContext();
			ctx.ui.confirmResponses = [true, true];

			const cmd = api.commands.get("pisync")!;
			await cmd.handler(undefined, ctx);

			expect(ctx.ui.confirmCalls).toEqual([
				expect.objectContaining({ title: "同步计划" }),
				{
					title: "是否 reload Pi？",
					message:
						"同步已更新你的配置。现在 reload Pi 以应用这些改动吗？",
				},
			]);
			expect(ctx.reloadCalls).toBe(1);
		});
	});

	it("cancels before running when the sync plan is rejected", async () => {
		const planSpy = vi
			.spyOn(PiSyncCommands.prototype, "plan")
			.mockResolvedValue({
				kind: "ready",
				fingerprint: "planned-state",
				changes: [
					{ relativePath: "prompts/welcome.md", changeType: "local_only" },
				],
				packages: {
					added: ["npm:example@1.0.0"],
					removed: [],
					changed: [],
				},
				remote: { ahead: 1, behind: 2 },
				pendingRecovery: true,
				message: "Review this plan",
			});
		const runSpy = vi.spyOn(PiSyncCommands.prototype, "run");
		try {
			const api = new FakeExtensionApi();
			register(api);
			const ctx = createRpcContext();

			await api.commands.get("pisync")!.handler(undefined, ctx);

			expect(runSpy).not.toHaveBeenCalled();
			expect(ctx.ui.confirmCalls).toEqual([
				expect.objectContaining({
					title: "同步计划",
					message: expect.stringContaining("npm:example@1.0.0"),
				}),
			]);
			expect(notificationTextOf(ctx)).toContain(
				"已在改动前取消同步。",
			);
		} finally {
			planSpy.mockRestore();
			runSpy.mockRestore();
		}
	});

	it("does not request a reload when result.reload is false", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceBPath);
			const settings = JSON.stringify({ packages: ["npm:@xyzensun/pi-sync"] });
			await environment.writeAgentFile("prompts/welcome.md", "base\n");
			await environment.writeAgentFile("settings.json", settings);
			const { sha256 } = await import("../src/sync/inventory.ts");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"prompts/welcome.md": { sha256: sha256("base\n"), mode: 0o644 },
						"settings.json": { sha256: sha256(settings), mode: 0o644 },
					},
				}),
			);

			const api = new FakeExtensionApi();
			register(api);
			const ctx = createRpcContext();
			ctx.ui.confirmResponses = [true];

			const cmd = api.commands.get("pisync")!;
			await cmd.handler(undefined, ctx);

			// The plan reports an unsynced repository setting, but the completed run does not reload.
			expect(ctx.ui.confirmCalls).toEqual([
				expect.objectContaining({ title: "同步计划" }),
			]);
			expect(ctx.reloadCalls).toBe(0);
		});
	});
});

describe.sequential("pisync running UI", () => {
	it("prints elapsed time in conversation messages while a command is running", async () => {
		vi.useFakeTimers();
		let finishRun!: (result: RunResult) => void;
		const runSpy = vi
			.spyOn(PiSyncCommands.prototype, "run")
			.mockImplementation(async (options) => {
				options?.onProgress?.("pull", "Waiting for Git...");
				return await new Promise<RunResult>((resolve) => {
					finishRun = resolve;
				});
			});
		const planSpy = vi
			.spyOn(PiSyncCommands.prototype, "plan")
			.mockResolvedValue({ kind: "setup", message: "Mocked setup plan" });
		try {
			const api = new FakeExtensionApi();
			register(api);
			const ctx = createRpcContext();
			const pending = api.commands.get("pisync")!.handler(undefined, ctx);

			await vi.advanceTimersByTimeAsync(2_100);
			finishRun({
				ok: true,
				code: "noop",
				message: "Done",
				reload: false,
				mode: "sync",
				phase: "complete",
			});
			await pending;

			expect(notificationTextOf(ctx)).toContain(
				"pi-sync [00:02] Waiting for Git...",
			);
			expect(ctx.ui.statusUpdates).toEqual([
				{ key: "pi-sync", value: undefined },
			]);
		} finally {
			runSpy.mockRestore();
			planSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it("skips the autoSync tick while a /pisync command is in flight", async () => {
		vi.useFakeTimers();
		// autoSync 启用、间隔取下限 5 分钟（index.ts 会 clamp 到 >= 5）。
		const lifecycleSpy = vi
			.spyOn(PiSyncCommands.prototype, "inspectLifecycleState")
			.mockResolvedValue({
				kind: "initialized",
				repoPath: "/tmp/pi-sync-autosync-guard",
				state: createSyncState({ repoPath: "/tmp/pi-sync-autosync-guard" }),
			});
		const configSpy = vi
			.spyOn(await import("../src/sync/config.ts"), "loadPiSyncConfig")
			.mockResolvedValue(
				createPiSyncConfig({
					autoSync: { enabled: true, intervalMinutes: 5 },
				}) as never,
			);
		const autoSyncSpy = vi
			.spyOn(PiSyncCommands.prototype, "autoSyncOnce")
			.mockResolvedValue({
				status: "skipped",
				reason: "no_update",
				message: "仓库已是最新。",
			});
		// 用 /pisync status 撑住处理器：它是只读命令但同样置位守卫标志，
		// 因为 status/diff 的输出会长时间停在屏幕上，autoSync 落地会让它变成陈旧信息。
		let finishStatus!: (output: string) => void;
		const statusSpy = vi
			.spyOn(PiSyncCommands.prototype, "status")
			.mockImplementation(
				() =>
					new Promise<string>((resolve) => {
						finishStatus = resolve;
					}),
			);
		try {
			const api = new FakeExtensionApi();
			register(api);
			const ctx = createRpcContext();

			await api.emit("session_start", {}, ctx);
			// 让 session_start 里那个异步 IIFE 走完，定时器才装上。
			await vi.advanceTimersByTimeAsync(0);

			const pending = api.commands.get("pisync")!.handler("status", ctx);
			await vi.advanceTimersByTimeAsync(0);

			// 命令执行中：跨过两个 tick 周期都不应触发 autoSync。
			await vi.advanceTimersByTimeAsync(10 * 60_000);
			expect(autoSyncSpy).not.toHaveBeenCalled();

			finishStatus("Mocked status output");
			await pending;

			// 命令结束后恢复：下一个周期正常执行。
			await vi.advanceTimersByTimeAsync(5 * 60_000);
			expect(autoSyncSpy).toHaveBeenCalledTimes(1);
		} finally {
			lifecycleSpy.mockRestore();
			configSpy.mockRestore();
			autoSyncSpy.mockRestore();
			statusSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it("prints each phase and Git command in conversation messages", async () => {
		const runSpy = vi
			.spyOn(PiSyncCommands.prototype, "run")
			.mockImplementation(async (options) => {
				options?.onProgress?.("preflight", "Checking sync state...");
				options?.onProgress?.("pull", "Pulling remote changes...");
				options?.onGitCommandStart?.("pull", "git fetch origin", 10_000);
				return {
					ok: true,
					code: "noop",
					message: "Done",
					reload: false,
					mode: "sync",
					phase: "complete",
				};
			});
		try {
			const api = new FakeExtensionApi();
			register(api);
			const ctx = createRpcContext();
			await api.commands.get("pisync")!.handler(undefined, ctx);

			const messages = notificationTextOf(ctx);
			expect(messages).toContain("Checking sync state...");
			expect(
				ctx.ui.notifications.filter((notification) =>
					notification.message.includes("Checking sync state..."),
				),
			).toHaveLength(1);
			expect(messages).toContain("Pulling remote changes...");
			expect(messages).toContain("正在执行：git fetch origin（超时：10s）……");
			expect(ctx.ui.statusUpdates).toEqual([
				{ key: "pi-sync", value: undefined },
			]);
		} finally {
			runSpy.mockRestore();
		}
	});

	it("uses the structured result code instead of message text for notifications", async () => {
		const scenarios: Array<{
			result: RunResult;
			level: "info" | "warning" | "error";
		}> = [
			{
				result: {
					ok: true,
					code: "ok",
					message: "fatal: this successful message must remain informational",
					reload: false,
					mode: "sync",
					phase: "complete",
				},
				level: "info",
			},
			{
				result: {
					ok: false,
					code: "blocked_validation",
					message: "Setup complete, but validation requires attention",
					reload: false,
					mode: "setup",
					phase: "preflight",
				},
				level: "warning",
			},
		];

		for (const scenario of scenarios) {
			const runSpy = vi
				.spyOn(PiSyncCommands.prototype, "run")
				.mockResolvedValue(scenario.result);
			try {
				const api = new FakeExtensionApi();
				register(api);
				const ctx = createRpcContext();
				await api.commands.get("pisync")!.handler(undefined, ctx);

				expect(ctx.ui.notifications.at(-1)).toMatchObject({
					message: expect.stringContaining(scenario.result.message),
					level: scenario.level,
				});
			} finally {
				runSpy.mockRestore();
			}
		}
	});

	it("hard-stops a run at 60 seconds", async () => {
		vi.useFakeTimers();
		let observedSignal: AbortSignal | undefined;
		let handlerSettled = false;
		const runSpy = vi
			.spyOn(PiSyncCommands.prototype, "run")
			.mockImplementation(async (options) => {
				const signal = options?.signal;
				observedSignal = signal;
				return await new Promise<RunResult>((resolve) => {
					signal?.addEventListener(
						"abort",
						() =>
							resolve({
								ok: false,
								code: "partial_failure",
								message: "underlying command aborted",
								reload: false,
								mode: "sync",
								phase: "preflight",
							}),
						{ once: true },
					);
				});
			});
		const planSpy = vi
			.spyOn(PiSyncCommands.prototype, "plan")
			.mockResolvedValue({ kind: "setup", message: "Mocked setup plan" });
		try {
			const api = new FakeExtensionApi();
			register(api);
			const ctx = createRpcContext();
			const pending = Promise.resolve(
				api.commands.get("pisync")!.handler(undefined, ctx),
			).then(() => {
				handlerSettled = true;
			});

			await vi.advanceTimersByTimeAsync(59_999);
			expect(handlerSettled).toBe(false);
			expect(observedSignal?.aborted).toBe(false);

			await vi.advanceTimersByTimeAsync(1);
			await pending;

			expect(observedSignal?.aborted).toBe(true);
			expect(notificationTextOf(ctx)).toContain(
				"pi-sync 超过 60 秒，已在 preflight 阶段停止。",
			);
			expect(ctx.ui.statusUpdates).toEqual(noStatusUpdates);
		} finally {
			runSpy.mockRestore();
			planSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it("shows stopping before confirming terminal Escape cancellation", async () => {
		vi.useFakeTimers();
		let observedSignal: AbortSignal | undefined;
		let started!: () => void;
		const runStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const runSpy = vi
			.spyOn(PiSyncCommands.prototype, "run")
			.mockImplementation(async (options) => {
				const signal = options?.signal;
				observedSignal = signal;
				started();
				return await new Promise<RunResult>((resolve) => {
					signal?.addEventListener(
						"abort",
						() =>
							resolve({
								ok: false,
								code: "partial_failure",
								message: "aborted",
								reload: false,
								mode: "sync",
								phase: "pull",
							}),
						{ once: true },
					);
				});
			});
		const planSpy = vi
			.spyOn(PiSyncCommands.prototype, "plan")
			.mockResolvedValue({ kind: "setup", message: "Mocked setup plan" });
		try {
			const api = new FakeExtensionApi();
			register(api);
			const ctx = new FakeCommandContext("tui");
			const pending = api.commands.get("pisync")!.handler(undefined, ctx);
			await runStarted;
			// Kitty keyboard protocol represents Escape as CSI 27;1u rather than ESC.
			ctx.ui.emitTerminalInput("\u001b[27;1u");

			expect(observedSignal?.aborted).toBe(true);
			expect(notificationTextOf(ctx)).toContain("pi-sync: 正在停止……");
			await vi.advanceTimersByTimeAsync(999);
			expect(notificationTextOf(ctx)).not.toContain(
				"pi-sync: 已被用户取消。",
			);
			await vi.advanceTimersByTimeAsync(1);
			await pending;

			expect(notificationTextOf(ctx)).toContain("pi-sync: 已被用户取消。");
			expect(ctx.ui.statusUpdates).toEqual(noStatusUpdates);
		} finally {
			runSpy.mockRestore();
			planSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it("confirms cancellation after one second when the command ignores abort", async () => {
		vi.useFakeTimers();
		let observedSignal: AbortSignal | undefined;
		let reportProgress:
			| ((phase: RunResult["phase"], message: string) => void)
			| undefined;
		let reportGitCommandStart:
			| ((
					phase: RunResult["phase"],
					command: string,
					timeoutMs: number,
			  ) => void)
			| undefined;
		let started!: () => void;
		const runStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const runSpy = vi
			.spyOn(PiSyncCommands.prototype, "run")
			.mockImplementation(async (options) => {
				observedSignal = options?.signal;
				reportProgress = options?.onProgress;
				reportGitCommandStart = options?.onGitCommandStart;
				started();
				return await new Promise<RunResult>(() => {});
			});
		const planSpy = vi
			.spyOn(PiSyncCommands.prototype, "plan")
			.mockResolvedValue({ kind: "setup", message: "Mocked setup plan" });
		try {
			const api = new FakeExtensionApi();
			register(api);
			const ctx = new FakeCommandContext("tui");
			const pending = api.commands.get("pisync")!.handler(undefined, ctx);
			await runStarted;

			ctx.ui.emitTerminalInput("\u001b");
			reportProgress?.("pull", "Comparing local and remote changes...");
			reportGitCommandStart?.(
				"pull",
				"git commit -m pi-sync: capture local changes before pull",
				10_000,
			);

			expect(observedSignal?.aborted).toBe(true);
			expect(notificationTextOf(ctx)).not.toContain(
				"Comparing local and remote changes...",
			);
			expect(notificationTextOf(ctx)).not.toContain(
				"Running: git commit -m pi-sync: capture local changes before pull",
			);
			expect(notificationTextOf(ctx)).toContain("pi-sync: 正在停止……");
			await vi.advanceTimersByTimeAsync(999);
			expect(notificationTextOf(ctx)).not.toContain(
				"pi-sync: 已被用户取消。",
			);
			await vi.advanceTimersByTimeAsync(1);
			await pending;

			expect(notificationTextOf(ctx)).toContain("pi-sync: 已被用户取消。");
			expect(ctx.ui.statusUpdates).toEqual(noStatusUpdates);
		} finally {
			runSpy.mockRestore();
			planSpy.mockRestore();
			vi.useRealTimers();
		}
	});
});

describe.sequential("Extension pull command interaction flow", () => {
	it.skipIf(process.platform === "win32")(
		"returns control to Pi and accepts the next command after pull timeout",
		async () => {
			await withTestEnvironment(async (environment) => {
				const fixture = await createGitFixture(environment.rootDir);
				await seedConfigRepo(fixture.deviceAPath, {
					...config,
					pullTimeoutMs: 75,
				});
				await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
				await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);
				const { sha256 } = await import("../src/sync/inventory.ts");
				await environment.writeAgentFile("prompts/welcome.md", "base\n");
				const settings = JSON.stringify({
					packages: ["npm:@xyzensun/pi-sync"],
				});
				await environment.writeAgentFile("settings.json", settings);
				await saveState(
					environment.agentDir,
					createSyncState({
						repoPath: fixture.deviceBPath,
						files: {
							"prompts/welcome.md": {
								sha256: sha256("base\n"),
								mode: 0o644,
							},
							"settings.json": {
								sha256: sha256(settings),
								mode: 0o644,
							},
						},
					}),
				);

				const realGit = execFileSync("which", ["git"], {
					encoding: "utf-8",
				}).trim();
				await environment.writeExecutable(
					"git",
					`#!/bin/sh\nif [ "$1" = "merge" ]; then\n  sh -c 'sleep 30 & wait'\n  exit 0\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`,
				);

				const api = new FakeExtensionApi();
				register(api);
				const ctx = createRpcContext();
				const command = api.commands.get("pisync")!;
				const nativeSetTimeout = globalThis.setTimeout;
				// Simulate a broken child-process timeout. The independent command
				// watchdog must still abort Git and return control to Pi.
				const timeoutSpy = vi
					.spyOn(globalThis, "setTimeout")
					.mockImplementation(((
						...parameters: Parameters<typeof setTimeout>
					) => {
						const [callback, delay, ...args] = parameters;
						return nativeSetTimeout(
							callback,
							delay === 75 ? 30_000 : delay,
							...args,
						);
					}) as typeof setTimeout);
				const startedAt = Date.now();
				try {
					await command.handler(undefined, ctx);
				} finally {
					timeoutSpy.mockRestore();
				}

				// This uses real Git processes and can run alongside the other test files.
				// Keep the bound well below the simulated 30-second child timeout while
				// allowing normal CI scheduler and process-startup variance.
				expect(Date.now() - startedAt).toBeLessThan(5_000);
				expect(notificationTextOf(ctx)).toContain(
					"在 75 ms 后超时。同步已停止。",
				);
				expect(ctx.ui.statusUpdates).toEqual(noStatusUpdates);

				// This second command represents the next message submitted in Pi.
				await expect(command.handler("status", ctx)).resolves.toBeUndefined();
				expect(notificationTextOf(ctx)).toContain("=== pi-sync 状态 ===");
			});
		},
	);

	it("pull flow: notifies result", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
			await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);

			const { sha256 } = await import("../src/sync/inventory.ts");
			await environment.writeAgentFile("prompts/welcome.md", "base\n");
			const settings = JSON.stringify({ packages: ["npm:@xyzensun/pi-sync"] });
			await environment.writeAgentFile("settings.json", settings);
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"prompts/welcome.md": { sha256: sha256("base\n"), mode: 0o644 },
						"settings.json": { sha256: sha256(settings), mode: 0o644 },
					},
				}),
			);

			const api = new FakeExtensionApi();
			register(api);
			const ctx = createRpcContext();

			const cmd = api.commands.get("pisync")!;
			await cmd.handler(undefined, ctx);

			expect(ctx.ui.notifications.at(-1)?.message).toContain(
				"Pull：pi-sync: 已是最新。",
			);
		});
	});

	it("pull flow lets the user approve a pulled package in the extension plan", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
			await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);
			await environment.writeAgentFile("prompts/welcome.md", "base\n");
			const { sha256 } = await import("../src/sync/inventory.ts");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"prompts/welcome.md": { sha256: sha256("base\n"), mode: 0o644 },
					},
				}),
			);

			await writeFile(
				join(fixture.deviceAPath, "sync/settings.json"),
				JSON.stringify({ packages: ["npm:extension-approved-package@1.0.0"] }),
				"utf-8",
			);
			await runGit(fixture.deviceAPath, ["add", "sync/settings.json"]);
			await runGit(fixture.deviceAPath, ["commit", "-m", "Request package"]);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
			await environment.writeExecutable(
				"pi",
				[
					"#!/bin/sh",
					'if [ "$1" = "--version" ]; then echo pi-test; exit 0; fi',
					"exit 0",
				].join("\n"),
			);

			const api = new FakeExtensionApi();
			register(api);
			const ctx = createRpcContext();
			ctx.ui.confirmResponses = [true, true, true];
			ctx.ui.selectResponses = [
				"安装「npm:extension-approved-package@1.0.0」",
			];

			await api.commands.get("pisync")!.handler(undefined, ctx);

			expect(ctx.ui.confirmCalls[0]?.title).toBe("同步计划");
			expect(ctx.ui.selectCalls[0]?.title).toContain(
				"extension-approved-package",
			);
			expect(ctx.ui.confirmCalls[1]?.title).toBe(
				"是否应用这些扩展决定？",
			);
			expect(ctx.ui.confirmCalls[2]?.title).toBe("是否 reload Pi？");
			expect(ctx.ui.notifications.at(-1)?.message).toContain("已写入文件");
			expect(ctx.reloadCalls).toBe(1);
		});
	});

	it("pull flow defers a pulled package when the user selects defer", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
			await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);
			await environment.writeAgentFile("prompts/welcome.md", "base\n");
			const { sha256 } = await import("../src/sync/inventory.ts");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"prompts/welcome.md": { sha256: sha256("base\n"), mode: 0o644 },
					},
				}),
			);

			await writeFile(
				join(fixture.deviceAPath, "sync/settings.json"),
				JSON.stringify({ packages: ["npm:extension-cancelled-package@1.0.0"] }),
				"utf-8",
			);
			await runGit(fixture.deviceAPath, ["add", "sync/settings.json"]);
			await runGit(fixture.deviceAPath, ["commit", "-m", "Request package"]);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);

			const api = new FakeExtensionApi();
			register(api);
			const ctx = createRpcContext();
			ctx.ui.confirmResponses = [true, true];
			ctx.ui.selectResponses = ["推迟 —— 暂时保持当前设置"];

			await api.commands.get("pisync")!.handler(undefined, ctx);

			await expect(
				readFile(join(environment.agentDir, "settings.json"), "utf-8"),
			).rejects.toThrow();
			expect(ctx.reloadCalls).toBe(0);
			expect(ctx.ui.notifications.at(-1)?.message).toContain("已按你的选择推迟");
		});
	});
});

describe("status updates are cleared on completion", () => {
	it("status command does not crash and produces output", async () => {
		const api = new FakeExtensionApi();
		register(api);
		const ctx = createRpcContext();

		const cmd = api.commands.get("pisync")!;
		await cmd.handler("status", ctx);

		expect(notificationTextOf(ctx)).toContain("尚未配置配置仓库");
		expect(showOutputOf(ctx)).toBe("");
	});
});

describe.sequential("direct pull and push commands (tui-prd §3)", () => {
	it("pull and push tell the user to initialize instead of throwing when unconfigured", async () => {
		const api = new FakeExtensionApi();
		register(api);
		const pullCtx = createRpcContext();
		const pushCtx = createRpcContext();

		await api.commands.get("pisync")!.handler("pull", pullCtx);
		await api.commands.get("pisync")!.handler("push", pushCtx);

		// 不弹任何对话框，也把异常换成了可操作的提示。
		expect(pullCtx.ui.selectCalls).toHaveLength(0);
		expect(pullCtx.ui.inputCalls).toHaveLength(0);
		expect(pushCtx.ui.selectCalls).toHaveLength(0);
		expect(pushCtx.ui.inputCalls).toHaveLength(0);
		expect(notificationTextOf(pullCtx)).toContain(
			"尚未初始化同步，请先运行 /pisync",
		);
		expect(notificationTextOf(pushCtx)).toContain(
			"尚未初始化同步，请先运行 /pisync",
		);
	});

	it("pull installs a pulled package without asking (zero-prompt contract)", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			// 远端 settings 引入一个新包：直达 pull 必须静默安装它。
			const configWithPackage = {
				...config,
				special: { "settings.json": "settings" },
			};
			await seedConfigRepo(fixture.deviceAPath, configWithPackage);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
			await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);
			await fixture.writeAndCommit(
				fixture.deviceAPath,
				"sync/settings.json",
				JSON.stringify({
					packages: ["npm:@xyzensun/pi-sync", "npm:fake-pulled-package"],
				}),
			);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
			// 假 pi：记录 install 调用，绝不触网（测试不得依赖 npm registry）。
			const piLogPath = join(environment.rootDir, "pi-install.log");
			await environment.writeExecutable(
				"pi",
				[
					"#!/bin/sh",
					'if [ "$1" = "--version" ]; then echo pi-test; exit 0; fi',
					'if [ "$1" = "install" ]; then printf \'%s\\n\' "$2" >> '
					+ JSON.stringify(piLogPath)
					+ "; exit 0; fi",
					"exit 0",
				].join("\n"),
			);

			const { sha256 } = await import("../src/sync/inventory.ts");
			await environment.writeAgentFile("prompts/welcome.md", "base\n");
			const settings = JSON.stringify({
				packages: ["npm:@xyzensun/pi-sync"],
			});
			await environment.writeAgentFile("settings.json", settings);
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"prompts/welcome.md": { sha256: sha256("base\n"), mode: 0o644 },
						"settings.json": { sha256: sha256(settings), mode: 0o644 },
					},
				}),
			);

			const api = new FakeExtensionApi();
			register(api);
			const ctx = createRpcContext();
			ctx.ui.confirmResponses = [true];

			await api.commands.get("pisync")!.handler("pull", ctx);

			// 零询问契约：没有计划确认、没有扩展选择、没有包审批弹窗。
			expect(ctx.ui.selectCalls).toHaveLength(0);
			expect(ctx.ui.inputCalls).toHaveLength(0);
			// 唯一的 confirm 是 reload 询问（必要信息而非审批）。
			expect(ctx.ui.confirmCalls).toHaveLength(1);
			expect(ctx.ui.confirmCalls[0]?.title).toBe("是否 reload Pi？");

			// settings 已被远端覆盖（含新包声明）。
			await expect(
				readFile(join(environment.agentDir, "settings.json"), "utf-8"),
			).resolves.toContain("fake-pulled-package");
			// 假 pi 收到了安装指令——审批被自动批准，而不是被跳过。
			const installLog = await readFile(piLogPath, "utf-8");
			expect(installLog).toContain("npm:fake-pulled-package");
		});
	});

	it("push publishes local changes without a plan confirmation and reports the result", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
			await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);

			const { sha256 } = await import("../src/sync/inventory.ts");
			await environment.writeAgentFile("prompts/welcome.md", "base\n");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"prompts/welcome.md": { sha256: sha256("base\n"), mode: 0o644 },
					},
				}),
			);
			await environment.writeAgentFile("prompts/welcome.md", "changed\n");

			const api = new FakeExtensionApi();
			register(api);
			const ctx = createRpcContext();

			await api.commands.get("pisync")!.handler("push", ctx);

			// 零询问契约：没有计划确认、没有扩展选择；唯一的 confirm 是
			// reload 询问（远端 settings.json 随收口落地本机，属必要信息）。
			expect(ctx.ui.selectCalls).toHaveLength(0);
			expect(ctx.ui.inputCalls).toHaveLength(0);
			expect(ctx.ui.confirmCalls).toHaveLength(1);
			expect(ctx.ui.confirmCalls[0]?.title).toBe("是否 reload Pi？");
			expect(notificationTextOf(ctx)).toContain("pi-sync:");
			// 远端与设备分支上都能看到新内容。
			await runGit(fixture.deviceBPath, ["fetch", "origin"]);
			const remoteMain = execFileSync(
				"git",
				[
					"--git-dir",
					join(fixture.deviceBPath, ".git"),
					"show",
					"origin/main:sync/prompts/welcome.md",
				],
				{ encoding: "utf-8" },
			);
			expect(remoteMain).toBe("changed\n");
			// 本机文件保持原样（push 不改写本机内容）。
			await expect(
				readFile(join(environment.agentDir, "prompts/welcome.md"), "utf-8"),
			).resolves.toBe("changed\n");
		});
	});
});
