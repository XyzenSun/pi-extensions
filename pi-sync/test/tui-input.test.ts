import { describe, expect, it } from "vitest";
import {
	beginAction,
	createTuiState,
	finishAction,
	markBusy,
	moveMenuSelection,
	raiseConflict,
	setConfirmChoice,
	setConflictExit,
	type TuiActionId,
	type TuiState,
	type TuiStatusSummary,
} from "../src/extension/tui-state.ts";
import {
	mapKeyToIntent,
	needsConfirmation,
} from "../src/extension/tui-input.ts";

/** 真实终端会发出的转义序列，避免用键名冒充输入。 */
const KEYS = {
	up: "\x1b[A",
	down: "\x1b[B",
	enter: "\r",
	escape: "\x1b",
	tab: "\t",
	shiftTab: "\x1b[Z",
	letter: "q",
} as const;

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

function menuOn(action: TuiActionId): TuiState {
	let state = createTuiState(statusSummary());
	// 靠移动到达目标项，顺便覆盖遍历顺序本身。
	for (let i = 0; i < 12 && state.page.kind === "menu"; i++) {
		if (state.page.selectedAction === action) return state;
		state = moveMenuSelection(state, 1);
	}
	return state;
}

describe("tui input mapping", () => {
	it("navigates the menu with arrows and tab", () => {
		const state = createTuiState(statusSummary());
		expect(mapKeyToIntent(state, KEYS.down)).toEqual({ kind: "move", delta: 1 });
		expect(mapKeyToIntent(state, KEYS.tab)).toEqual({ kind: "move", delta: 1 });
		expect(mapKeyToIntent(state, KEYS.up)).toEqual({ kind: "move", delta: -1 });
		expect(mapKeyToIntent(state, KEYS.shiftTab)).toEqual({
			kind: "move",
			delta: -1,
		});
	});

	it("activates the selected menu entry on enter", () => {
		expect(mapKeyToIntent(menuOn("push-smart"), KEYS.enter)).toEqual({
			kind: "activate",
			action: "push-smart",
		});
	});

	it("treats the exit entry and escape identically", () => {
		expect(mapKeyToIntent(menuOn("exit"), KEYS.enter)).toEqual({ kind: "exit" });
		expect(mapKeyToIntent(createTuiState(statusSummary()), KEYS.escape)).toEqual(
			{ kind: "exit" },
		);
	});

	it("ignores unrelated keys", () => {
		expect(mapKeyToIntent(createTuiState(statusSummary()), KEYS.letter)).toEqual(
			{ kind: "ignore" },
		);
	});

	it("blocks all input while an action is running", () => {
		const busy = markBusy(createTuiState(statusSummary()), "pull-smart");
		for (const key of Object.values(KEYS)) {
			expect(mapKeyToIntent(busy, key)).toEqual({ kind: "ignore" });
		}
	});

	describe("confirm page", () => {
		const confirming = beginAction(
			createTuiState(statusSummary()),
			"pull-overwrite-local",
			{ paths: ["prompts/a.md"] },
		);

		it("toggles between the two options with either arrow", () => {
			expect(mapKeyToIntent(confirming, KEYS.up)).toEqual({ kind: "toggle" });
			expect(mapKeyToIntent(confirming, KEYS.down)).toEqual({ kind: "toggle" });
		});

		it("applies enter to the selected option, not unconditionally", () => {
			// 默认选中取消，所以误触 Enter 是安全的。
			expect(mapKeyToIntent(confirming, KEYS.enter)).toEqual({
				kind: "cancel-confirm",
			});
			expect(
				mapKeyToIntent(setConfirmChoice(confirming, "confirm"), KEYS.enter),
			).toEqual({
				kind: "confirm-destructive",
				action: "pull-overwrite-local",
			});
		});

		it("cancels on escape", () => {
			expect(mapKeyToIntent(confirming, KEYS.escape)).toEqual({
				kind: "cancel-confirm",
			});
		});
	});

	describe("conflict page", () => {
		const conflicted = raiseConflict(createTuiState(statusSummary()), {
			conflictPaths: ["prompts/welcome.md"],
			deviceBranch: "pisync-device/host-abc",
		});

		it("picks the selected exit on enter", () => {
			// 默认停在"我自己处理"。
			expect(mapKeyToIntent(conflicted, KEYS.enter)).toEqual({
				kind: "resolve-conflict",
				exit: "manual",
			});
			expect(
				mapKeyToIntent(setConflictExit(conflicted, "ask-agent"), KEYS.enter),
			).toEqual({ kind: "resolve-conflict", exit: "ask-agent" });
		});

		it("returns to the menu on escape rather than exiting", () => {
			expect(mapKeyToIntent(conflicted, KEYS.escape)).toEqual({
				kind: "back-to-menu",
			});
		});
	});

	describe("result page", () => {
		const finished = finishAction(
			markBusy(createTuiState(statusSummary()), "pull-smart"),
			{ action: "pull-smart", ok: true, message: "done", reload: false },
		);

		it("returns to the menu on enter and exits on escape", () => {
			expect(mapKeyToIntent(finished, KEYS.enter)).toEqual({
				kind: "back-to-menu",
			});
			expect(mapKeyToIntent(finished, KEYS.escape)).toEqual({ kind: "exit" });
		});
	});

	it("ignores input once closed", () => {
		const closed: TuiState = {
			...createTuiState(statusSummary()),
			page: { kind: "closed", pending: null },
		};
		expect(mapKeyToIntent(closed, KEYS.enter)).toEqual({ kind: "ignore" });
	});

	it("requires confirmation for exactly the two overwrite actions", () => {
		expect(needsConfirmation("pull-overwrite-local")).toBe(true);
		expect(needsConfirmation("push-overwrite-remote")).toBe(true);
		expect(needsConfirmation("pull-smart")).toBe(false);
		expect(needsConfirmation("push-smart")).toBe(false);
		expect(needsConfirmation("view-diff")).toBe(false);
	});
});