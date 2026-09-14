import { describe, expect, it, vi } from "vitest";
import {
	createTuiComponent,
	TuiHost,
	type TuiActionResult,
	type TuiHostActions,
} from "../src/extension/tui-host.ts";
import type {
	TuiActionId,
	TuiExitIntent,
	TuiStatusSummary,
} from "../src/extension/tui-state.ts";
import type { ThemeLike } from "../src/extension/tui-view.ts";

const KEYS = {
	up: "\x1b[A",
	down: "\x1b[B",
	enter: "\r",
	escape: "\x1b",
} as const;

const theme: ThemeLike = { fg: (_role, text) => text, bold: (text) => text };

function statusSummary(
	overrides: Partial<TuiStatusSummary> = {},
): TuiStatusSummary {
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

interface Harness {
	host: TuiHost;
	exits: Array<TuiExitIntent | null>;
	renders: number;
	actions: {
		run: ReturnType<typeof vi.fn>;
		losingPaths: ReturnType<typeof vi.fn>;
		refreshStatus: ReturnType<typeof vi.fn>;
		toggleAutoSync: ReturnType<typeof vi.fn>;
	};
	/** 连按若干键，顺序驱动。 */
	press(...keys: string[]): Promise<void>;
	/** 把光标移到指定菜单项上。 */
	selectMenu(action: TuiActionId): Promise<void>;
}

function createHarness(
	overrides: Partial<TuiHostActions> = {},
	initialStatus: TuiStatusSummary = statusSummary(),
): Harness {
	const exits: Array<TuiExitIntent | null> = [];
	const state = { renders: 0 };
	const actions = {
		run: vi.fn(
			async (): Promise<TuiActionResult> => ({
				kind: "outcome",
				outcome: { ok: true, message: "完成", reload: false },
			}),
		),
		losingPaths: vi.fn(async () => [] as string[]),
		refreshStatus: vi.fn(async () => initialStatus),
		toggleAutoSync: vi.fn(async () => true),
		...overrides,
	};
	const host = new TuiHost({
		initialStatus,
		theme,
		actions: actions as unknown as TuiHostActions,
		requestRender: () => {
			state.renders += 1;
		},
		done: (intent) => exits.push(intent),
	});
	const harness: Harness = {
		host,
		exits,
		get renders() {
			return state.renders;
		},
		actions: actions as Harness["actions"],
		async press(...keys: string[]) {
			for (const key of keys) await host.handleInput(key);
		},
		async selectMenu(action: TuiActionId) {
			for (let i = 0; i < 12; i++) {
				const page = host.getState().page;
				if (page.kind !== "menu" || page.selectedAction === action) return;
				await host.handleInput(KEYS.down);
			}
		},
	};
	return harness;
}

describe("tui host", () => {
	it("runs a non-destructive action without a confirm page", async () => {
		const harness = createHarness();
		await harness.press(KEYS.enter);

		expect(harness.actions.run).toHaveBeenCalledWith(
			"pull-smart",
			expect.any(Function),
		);
		expect(harness.actions.losingPaths).not.toHaveBeenCalled();
		expect(harness.host.getState().page).toMatchObject({
			kind: "result",
			action: "pull-smart",
			ok: true,
		});
	});

	it("requires confirmation before a destructive action and cancels by default", async () => {
		const harness = createHarness({
			losingPaths: vi.fn(async () => ["prompts/a.md", "settings.json"]),
		});
		await harness.selectMenu("pull-overwrite-local");
		await harness.press(KEYS.enter);

		expect(harness.actions.losingPaths).toHaveBeenCalledWith(
			"pull-overwrite-local",
		);
		expect(harness.host.getState().page).toMatchObject({
			kind: "confirm",
			losingPaths: ["prompts/a.md", "settings.json"],
			choice: "cancel",
		});

		// 默认停在取消上，误触 Enter 不执行。
		await harness.press(KEYS.enter);
		expect(harness.actions.run).not.toHaveBeenCalled();
		expect(harness.host.getState().page).toMatchObject({ kind: "menu" });
	});

	it("executes a destructive action only after switching to confirm", async () => {
		const harness = createHarness({
			losingPaths: vi.fn(async () => ["prompts/a.md"]),
		});
		await harness.selectMenu("push-overwrite-remote");
		await harness.press(KEYS.enter, KEYS.down, KEYS.enter);

		expect(harness.actions.run).toHaveBeenCalledWith(
			"push-overwrite-remote",
			expect.any(Function),
		);
	});

	it("aborts the destructive flow when the losing-path scan fails", async () => {
		const harness = createHarness({
			losingPaths: vi.fn(async () => {
				throw new Error("git 不可用");
			}),
		});
		await harness.selectMenu("pull-overwrite-local");
		await harness.press(KEYS.enter);

		expect(harness.actions.run).not.toHaveBeenCalled();
		expect(harness.host.getState().page).toMatchObject({
			kind: "result",
			ok: false,
		});
		expect(
			(harness.host.getState().page as { message: string }).message,
		).toContain("git 不可用");
	});

	it("surfaces progress while an action runs and blocks input", async () => {
		let emit!: (message: string) => void;
		let finish!: (result: TuiActionResult) => void;
		const harness = createHarness({
			run: vi.fn(
				(_action: TuiActionId, onProgress: (message: string) => void) => {
					emit = onProgress;
					return new Promise<TuiActionResult>((resolve) => {
						finish = resolve;
					});
				},
			) as unknown as TuiHostActions["run"],
		});

		const pending = harness.press(KEYS.enter);
		emit("正在执行：git fetch origin……");
		expect(harness.host.getState().progress).toBe(
			"正在执行：git fetch origin……",
		);
		expect(harness.host.render().join("\n")).toContain("git fetch origin");

		// 执行中按键一律忽略。
		await harness.press(KEYS.down, KEYS.escape);
		expect(harness.exits).toHaveLength(0);
		expect(harness.host.getState().busyAction).toBe("pull-smart");

		finish({
			kind: "outcome",
			outcome: { ok: true, message: "已完成", reload: false },
		});
		await pending;
		expect(harness.host.getState().busyAction).toBeNull();
	});

	it("refreshes the status summary after an action so the UI reflects reality", async () => {
		const harness = createHarness({
			refreshStatus: vi.fn(async () =>
				statusSummary({ pendingChanges: 0, behind: 0, lastSyncedAt: "2026-09-11T09:00:00Z" }),
			),
		}, statusSummary({ pendingChanges: 5, behind: 2 }));

		await harness.press(KEYS.enter);

		expect(harness.actions.refreshStatus).toHaveBeenCalled();
		expect(harness.host.getState().status).toMatchObject({
			pendingChanges: 0,
			behind: 0,
		});
	});

	it("keeps the old summary when the refresh fails", async () => {
		const harness = createHarness(
			{
				refreshStatus: vi.fn(async () => {
					throw new Error("读取状态失败");
				}),
			},
			statusSummary({ pendingChanges: 3 }),
		);
		await harness.press(KEYS.enter);

		expect(harness.host.getState().page).toMatchObject({ kind: "result" });
		expect(harness.host.getState().status.pendingChanges).toBe(3);
	});

	it("routes a Git conflict to the conflict page instead of merging", async () => {
		const harness = createHarness({
			run: vi.fn(async () => ({
				kind: "conflict" as const,
				conflict: {
					conflictPaths: ["prompts/welcome.md"],
					deviceBranch: "pisync-device/host-abc",
				},
			})) as unknown as TuiHostActions["run"],
		});
		await harness.selectMenu("push-smart");
		await harness.press(KEYS.enter);

		expect(harness.host.getState().page).toMatchObject({
			kind: "conflict",
			deviceBranch: "pisync-device/host-abc",
			exit: "manual",
		});
	});

	it("hands both conflict exits back to the caller rather than resolving them", async () => {
		const conflictRun = vi.fn(async () => ({
			kind: "conflict" as const,
			conflict: { conflictPaths: [], deviceBranch: "d" },
		})) as unknown as TuiHostActions["run"];

		// 默认出路：我自己处理。
		const manual = createHarness({ run: conflictRun });
		await manual.press(KEYS.enter, KEYS.enter);
		expect(manual.exits).toEqual([{ kind: "manual-merge" }]);

		// 切到交给 agent。
		const agent = createHarness({ run: conflictRun });
		await agent.press(KEYS.enter, KEYS.down, KEYS.enter);
		expect(agent.exits).toEqual([{ kind: "ask-agent" }]);
	});

	it("returns to the menu when an action is cancelled mid-flight", async () => {
		const harness = createHarness({
			run: vi.fn(async () => ({ kind: "aborted" as const })) as unknown as
				TuiHostActions["run"],
		});
		await harness.press(KEYS.enter);

		expect(harness.host.getState().page).toMatchObject({ kind: "menu" });
		expect(harness.host.getState().busyAction).toBeNull();
		expect(harness.exits).toHaveLength(0);
	});

	it("recovers onto the result page when an action throws", async () => {
		const harness = createHarness({
			run: vi.fn(async () => {
				throw new Error("git push 失败");
			}) as unknown as TuiHostActions["run"],
		});
		await harness.press(KEYS.enter);

		expect(harness.host.getState().busyAction).toBeNull();
		expect(harness.host.getState().page).toMatchObject({
			kind: "result",
			ok: false,
		});
		expect(
			(harness.host.getState().page as { message: string }).message,
		).toContain("git push 失败");
	});

	it("toggles autoSync in place without leaving the menu", async () => {
		const harness = createHarness();
		await harness.selectMenu("toggle-auto-sync");
		await harness.press(KEYS.enter);

		expect(harness.actions.toggleAutoSync).toHaveBeenCalled();
		expect(harness.host.getState().status.autoSyncEnabled).toBe(true);
		expect(harness.host.getState().page).toMatchObject({ kind: "menu" });
	});

	it("reports a failed autoSync toggle instead of silently ignoring it", async () => {
		const harness = createHarness({
			toggleAutoSync: vi.fn(async () => {
				throw new Error("配置只读");
			}),
		});
		await harness.selectMenu("toggle-auto-sync");
		await harness.press(KEYS.enter);

		expect(harness.host.getState().page).toMatchObject({
			kind: "result",
			ok: false,
		});
	});

	it("defers diff rendering to the caller", async () => {
		const harness = createHarness();
		await harness.selectMenu("view-diff");
		await harness.press(KEYS.enter);

		expect(harness.exits).toEqual([{ kind: "show-diff" }]);
		expect(harness.actions.run).not.toHaveBeenCalled();
	});

	it("exits from the menu via both escape and the exit entry", async () => {
		const viaEscape = createHarness();
		await viaEscape.press(KEYS.escape);
		expect(viaEscape.exits).toEqual([null]);

		const viaEntry = createHarness();
		await viaEntry.selectMenu("exit");
		await viaEntry.press(KEYS.enter);
		expect(viaEntry.exits).toEqual([null]);
	});

	it("navigates back from a result page and can run another action", async () => {
		const harness = createHarness();
		await harness.press(KEYS.enter, KEYS.enter);

		expect(harness.host.getState().page).toMatchObject({
			kind: "menu",
			selectedAction: "pull-smart",
		});
		await harness.press(KEYS.enter);
		expect(harness.actions.run).toHaveBeenCalledTimes(2);
	});

	it("requests a render on every state change", async () => {
		const harness = createHarness();
		const before = harness.renders;
		await harness.press(KEYS.down);
		expect(harness.renders).toBeGreaterThan(before);
	});

	it("exposes a component that never rejects on input", async () => {
		const harness = createHarness({
			run: vi.fn(async () => {
				throw new Error("boom");
			}) as unknown as TuiHostActions["run"],
		});
		const component = createTuiComponent(harness.host);

		expect(() => component.handleInput?.(KEYS.enter)).not.toThrow();
		expect(component.render(80).length).toBeGreaterThan(0);
		expect(() => component.invalidate()).not.toThrow();
	});
});