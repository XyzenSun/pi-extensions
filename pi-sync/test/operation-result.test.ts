import { describe, expect, it } from "vitest";
import {
	conflictResult,
	failureResult,
	noopResult,
	notificationLevelForResult,
	successResult,
} from "../src/orchestration/operation-result.ts";

describe("structured operation results", () => {
	it("constructs success, noop, failure, and conflict results with stable defaults", () => {
		expect(successResult("done", true, { source: "test" })).toEqual({
			ok: true,
			code: "ok",
			message: "done",
			reload: true,
			details: { source: "test" },
		});
		expect(noopResult("unchanged")).toEqual({
			ok: true,
			code: "noop",
			message: "unchanged",
			reload: false,
		});
		expect(failureResult("git_failed", "fetch failed")).toMatchObject({
			ok: false,
			code: "git_failed",
			reload: false,
		});
		expect(conflictResult("needs merge")).toMatchObject({
			ok: false,
			code: "blocked_conflict",
			reload: false,
		});
	});

	it.each([
		["ok", "info"],
		["noop", "info"],
		["blocked_conflict", "warning"],
		["blocked_validation", "warning"],
		["approval_required", "warning"],
		["git_failed", "error"],
		["partial_failure", "error"],
	] as const)("maps %s to a %s notification", (code, level) => {
		expect(notificationLevelForResult(code)).toBe(level);
	});
});
