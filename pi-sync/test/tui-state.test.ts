import { describe, expect, it } from "vitest";
import {
	beginAction,
	cancelConfirm,
	closeTui,
	createTuiState,
	finishAction,
	isClosed,
	isDestructiveAction,
	markBusy,
	moveMenuSelection,
	raiseConflict,
	setAutoSyncEnabled,
	setConfirmChoice,
	setConflictExit,
	setProgress,
	toggleConfirmChoice,
	toggleConflictExit,
	returnToMenu,
	TUI_MENU_ENTRIES,
	type TuiStatusSummary,
} from "../src/extension/tui-state.ts";

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

describe("tui state machine", () => {
	it("starts on the menu with the first entry selected", () => {
		const state = createTuiState(statusSummary());
		expect(state.page).toEqual({
			kind: "menu",
			selectedAction: TUI_MENU_ENTRIES[0]!.action,
		});
		expect(state.busyAction).toBeNull();
	});

	it("moves the menu selection cyclically", () => {
		const state = createTuiState(statusSummary());
		const last = moveMenuSelection(state, -1);
		expect(last.page).toEqual({
			kind: "menu",
			selectedAction: "exit",
		});
		const wrapped = moveMenuSelection(last, 1);
		expect(wrapped.page).toEqual({
			kind: "menu",
			selectedAction: TUI_MENU_ENTRIES[0]!.action,
		});
	});

	it("keeps the selection in place when moving from a non-menu page", () => {
		const state = createTuiState(statusSummary());
		const untouched = moveMenuSelection(
			{ ...state, page: { kind: "result", action: "pull-smart", ok: true, message: "", reload: false } },
			1,
		);
		expect(untouched.page).toMatchObject({ kind: "result" });
	});

	it("routes destructive actions through a confirm page defaulting to cancel", () => {
		const state = createTuiState(statusSummary());
		const confirming = beginAction(state, "pull-overwrite-local", {
			paths: ["prompts/a.md", "prompts/b.md"],
		});
		expect(confirming.page).toMatchObject({
			kind: "confirm",
			action: "pull-overwrite-local",
			choice: "cancel",
			totalLosingPaths: 2,
		});
		// 非破坏性动作不经过确认页。
		const direct = beginAction(state, "pull-smart");
		expect(direct).toBe(state);
	});

	it("ignores new actions while another one is busy", () => {
		const state = markBusy(createTuiState(statusSummary()), "pull-smart");
		const confirming = beginAction(state, "push-overwrite-remote", {
			paths: ["x"],
		});
		expect(confirming).toBe(state);
	});

	it("truncates the losing-path list but reports the true total", () => {
		const state = createTuiState(statusSummary());
		const paths = Array.from({ length: 20 }, (_v, i) => `prompts/${i}.md`);
		const confirming = beginAction(state, "push-overwrite-remote", {
			paths,
			limit: 5,
		});
		expect(confirming.page).toMatchObject({
			losingPaths: paths.slice(0, 5),
			totalLosingPaths: 20,
		});
	});

	it("toggles the confirm choice and cancels back to the same entry", () => {
		const state = createTuiState(statusSummary());
		const confirming = beginAction(state, "pull-overwrite-local", {
			paths: ["a"],
		});
		const toggled = toggleConfirmChoice(confirming);
		expect(toggled.page).toMatchObject({ choice: "confirm" });
		const cancelled = cancelConfirm(toggled);
		expect(cancelled.page).toEqual({
			kind: "menu",
			selectedAction: "pull-overwrite-local",
		});
		// setConfirmChoice 只在确认页生效。
		expect(setConfirmChoice(createTuiState(statusSummary()), "confirm").page).toMatchObject(
			{ kind: "menu" },
		);
	});

	it("tracks progress only while an action is busy", () => {
		const idle = createTuiState(statusSummary());
		expect(setProgress(idle, "正在拉取……")).toBe(idle);
		const busy = markBusy(idle, "pull-smart");
		expect(setProgress(busy, "正在拉取……").progress).toBe("正在拉取……");
	});

	it("finishes an action onto a result page with refreshed status", () => {
		const state = createTuiState(statusSummary());
		const finished = finishAction(
			markBusy(state, "pull-smart"),
			{ action: "pull-smart", ok: true, message: "已拉取。", reload: true },
			statusSummary({ behind: 0, pendingChanges: 3 }),
		);
		expect(finished.busyAction).toBeNull();
		expect(finished.page).toMatchObject({
			kind: "result",
			action: "pull-smart",
			ok: true,
			reload: true,
		});
		expect(finished.status.pendingChanges).toBe(3);
	});

	it("raises a Git conflict page defaulting to the manual exit", () => {
		const state = createTuiState(statusSummary());
		const conflicted = raiseConflict(state, {
			conflictPaths: ["prompts/a.md"],
			deviceBranch: "pisync-device/host-abc",
		});
		expect(conflicted.page).toMatchObject({
			kind: "conflict",
			exit: "manual",
			deviceBranch: "pisync-device/host-abc",
		});
		const agent = toggleConflictExit(conflicted);
		expect(agent.page).toMatchObject({ exit: "ask-agent" });
		// setConflictExit 只在冲突页生效。
		expect(
			setConflictExit(createTuiState(statusSummary()), "ask-agent").page,
		).toMatchObject({ kind: "menu" });
	});

	it("returns to the menu from result and confirm pages keeping the entry", () => {
		const state = createTuiState(statusSummary());
		const fromResult = returnToMenu({
			...state,
			page: { kind: "result", action: "push-smart", ok: false, message: "x", reload: false },
		});
		expect(fromResult.page).toEqual({
			kind: "menu",
			selectedAction: "push-smart",
		});
		const fromConflict = returnToMenu({
			...state,
			page: { kind: "conflict", conflictPaths: [], deviceBranch: "d", exit: "manual" },
		});
		expect(fromConflict.page).toEqual({
			kind: "menu",
			selectedAction: TUI_MENU_ENTRIES[0]!.action,
		});
	});

	it("closes with a pending intent and clears busy state", () => {
		const state = markBusy(createTuiState(statusSummary()), "pull-smart");
		const closed = closeTui(state, { kind: "reload" });
		expect(isClosed(closed)).toBe(true);
		expect(closed.busyAction).toBeNull();
		expect(closed.page).toEqual({
			kind: "closed",
			pending: { kind: "reload" },
		});
	});

	it("reflects the autoSync toggle in the status summary", () => {
		const state = createTuiState(statusSummary());
		expect(setAutoSyncEnabled(state, true).status.autoSyncEnabled).toBe(true);
	});

	it("marks exactly the two overwrite actions as destructive", () => {
		expect(isDestructiveAction("pull-overwrite-local")).toBe(true);
		expect(isDestructiveAction("push-overwrite-remote")).toBe(true);
		for (const entry of TUI_MENU_ENTRIES) {
			if (entry.action.startsWith("pull-overwrite")) continue;
			if (entry.action.startsWith("push-overwrite")) continue;
			expect(isDestructiveAction(entry.action)).toBe(false);
		}
	});
});