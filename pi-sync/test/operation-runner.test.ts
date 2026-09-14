import { describe, expect, it, vi } from "vitest";
import { runOperation } from "../src/extension/operation-runner.ts";
import type { RunResult } from "../src/orchestration/operation-result.ts";

const completedResult: RunResult = {
	ok: true,
	code: "ok",
	message: "Sync complete.",
	reload: false,
	mode: "sync",
	phase: "complete",
};

function createOptions(
	overrides: Partial<Parameters<typeof runOperation>[0]> = {},
): Parameters<typeof runOperation>[0] {
	return {
		execute: async () => completedResult,
		host: {
			formatProgress: (_elapsedMs, message) => message,
			publishProgress: () => undefined,
		},
		runTimeoutMs: 60_000,
		commandSettleGraceMs: 100,
		elapsedRefreshMs: 100,
		cancellationNoticeDelayMs: 0,
		...overrides,
	};
}

describe("runOperation lifecycle", () => {
	it("does not start execution when cancellation occurs during listener registration", async () => {
		vi.useFakeTimers();
		try {
			const execute = vi.fn(async () => completedResult);
			const removeCancelListener = vi.fn();
			const onStopping = vi.fn();
			const onCancelled = vi.fn();

			const operation = runOperation(
				createOptions({
					execute,
					host: {
						formatProgress: (_elapsedMs, message) => message,
						publishProgress: () => undefined,
						onCancel: (cancel) => {
							cancel();
							return removeCancelListener;
						},
						onStopping,
						onCancelled,
					},
				}),
			);

			await vi.advanceTimersByTimeAsync(0);
			await expect(operation).resolves.toBeNull();

			expect(execute).not.toHaveBeenCalled();
			expect(onStopping).toHaveBeenCalledOnce();
			expect(onCancelled).toHaveBeenCalledOnce();
			expect(removeCancelListener).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("cleans progress resources when cancellation registration throws", async () => {
		vi.useFakeTimers();
		try {
			const publishProgress = vi.fn();
			const failure = new Error("Unable to register cancellation listener");

			await expect(
				runOperation(
					createOptions({
						host: {
							formatProgress: (_elapsedMs, message) => message,
							publishProgress,
							onCancel: () => {
								throw failure;
							},
						},
					}),
				),
			).rejects.toBe(failure);

			await vi.advanceTimersByTimeAsync(500);
			expect(publishProgress).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});
});
