import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/system/git.ts", () => ({
	gitCommit: vi.fn(),
	gitFetch: vi.fn(),
	gitFastForward: vi.fn(),
	gitRebase: vi.fn(),
	gitRemoteRefExists: vi.fn(),
	gitStatus: vi.fn(),
}));

import {
	gitCommit,
	gitFastForward,
	gitFetch,
	gitRebase,
	gitRemoteRefExists,
	gitStatus,
} from "../src/system/git.ts";
import {
	commitCapturedChangesBeforePull,
	integratePulledHead,
	preparePullWorktree,
} from "../src/orchestration/pull-phase.ts";
import { integrateCommittedPush } from "../src/orchestration/push-phase.ts";

const pullOptions = {
	repoPath: "/repo",
	branch: "main",
	timeoutMs: 10_000,
	capturedLocalChanges: false,
};

const cleanStatus = {
	branch: "main",
	commit: "a".repeat(40),
	commitShort: "aaaaaaa",
	ahead: 0,
	behind: 0,
	hasUncommittedChanges: false,
	hasUnpushedCommits: false,
	remoteExists: true,
	changedFiles: [],
	isRebasing: false,
	isMerging: false,
	hasConflicts: false,
	conflictedFiles: [],
};

beforeEach(() => {
	vi.resetAllMocks();
});

describe("pull integration phase", () => {
	it("returns a structured fetch failure before attempting integration", async () => {
		vi.mocked(gitFetch).mockRejectedValue(new Error("offline"));

		const result = await integratePulledHead(pullOptions);

		expect(result).toEqual({
			kind: "failed",
			message: "git fetch 失败：offline",
		});
		expect(gitRebase).not.toHaveBeenCalled();
		expect(gitFastForward).not.toHaveBeenCalled();
	});

	it("returns a rebase conflict after capturing local changes", async () => {
		vi.mocked(gitFetch).mockResolvedValue(undefined);
		vi.mocked(gitRebase).mockResolvedValue({ rebased: false, conflict: true });

		const result = await integratePulledHead({
			...pullOptions,
			capturedLocalChanges: true,
		});

		expect(result).toEqual({ kind: "rebase_conflict" });
		expect(gitFastForward).not.toHaveBeenCalled();
	});

	it("blocks a rebase or merge worktree before capture", async () => {
		const result = await preparePullWorktree("/repo", {
			...cleanStatus,
			isRebasing: true,
		});

		expect(result).toMatchObject({ kind: "blocked" });
		expect(gitCommit).not.toHaveBeenCalled();
	});

	it("commits a dirty worktree before capture", async () => {
		vi.mocked(gitCommit).mockResolvedValue(undefined);
		vi.mocked(gitStatus).mockResolvedValue(cleanStatus);

		const result = await preparePullWorktree("/repo", {
			...cleanStatus,
			hasUncommittedChanges: true,
		});

		expect(result).toEqual({
			kind: "ready",
			status: cleanStatus,
			committedRepositoryChanges: true,
		});
	});

	it("returns a structured failure when committing captured changes fails", async () => {
		vi.mocked(gitCommit).mockRejectedValue(new Error("hook rejected"));

		const result = await commitCapturedChangesBeforePull("/repo");

		expect(result).toEqual({
			kind: "failed",
			message: "pull 前无法提交本机改动：hook rejected",
		});
	});

	it("fast-forwards remote-only changes without rebasing", async () => {
		vi.mocked(gitFetch).mockResolvedValue(undefined);
		vi.mocked(gitFastForward).mockResolvedValue({ pulled: true });

		const result = await integratePulledHead(pullOptions);

		expect(result).toEqual({ kind: "fast_forwarded", pulled: true });
		expect(gitRebase).not.toHaveBeenCalled();
	});
});

describe("push integration phase", () => {
	it("returns a structured fetch failure while preserving the local commit", async () => {
		vi.mocked(gitFetch).mockRejectedValue(new Error("offline"));

		const result = await integrateCommittedPush({
			repoPath: "/repo",
			branch: "main",
		});

		expect(result).toEqual({
			kind: "failed",
			message:
				"本机提交后 git fetch 失败：offline。本机提交已保留。",
		});
		expect(gitRemoteRefExists).not.toHaveBeenCalled();
	});

	it("skips rebase when the configured remote ref does not exist", async () => {
		vi.mocked(gitFetch).mockResolvedValue(undefined);
		vi.mocked(gitRemoteRefExists).mockResolvedValue(false);

		const result = await integrateCommittedPush({
			repoPath: "/repo",
			branch: "main",
		});

		expect(result).toEqual({ kind: "ready_to_push" });
		expect(gitRebase).not.toHaveBeenCalled();
	});

	it("returns a rebase conflict when the remote branch advances", async () => {
		vi.mocked(gitFetch).mockResolvedValue(undefined);
		vi.mocked(gitRemoteRefExists).mockResolvedValue(true);
		vi.mocked(gitRebase).mockResolvedValue({ rebased: false, conflict: true });

		const result = await integrateCommittedPush({
			repoPath: "/repo",
			branch: "main",
		});

		expect(result).toEqual({ kind: "rebase_conflict" });
	});
});
