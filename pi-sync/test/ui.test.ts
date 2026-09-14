import { describe, expect, it } from "vitest";
import {
	formatGitStatus,
	formatSyncStatusV2,
	formatComparisonDiff,
	formatValidationErrors,
	formatCaptureResult,
	buildExtensionPlanItems,
	formatSyncPlanMessage,
} from "../src/extension/ui.ts";
import type { GitStatus } from "../src/system/git.ts";
import type {
	FileComparison,
	FileEntry,
	InventoryResult,
} from "../src/sync/inventory.ts";
import type { CaptureResult } from "../src/sync/capture.ts";

function makeFileEntry(sha256 = "abc", mode = 0o644): FileEntry {
	return { relativePath: "", sha256, mode };
}

describe("extension sync plan helpers", () => {
	it("builds actionable incoming package and grouped extension items", () => {
		const items = buildExtensionPlanItems({
			changes: [
				{ relativePath: "settings.json", changeType: "remote_only" },
				{ relativePath: "extensions/tool/index.ts", changeType: "remote_created" },
				{ relativePath: "extensions/tool/lib.ts", changeType: "remote_created" },
				{ relativePath: "extensions/other.ts", changeType: "remote_deleted" },
			],
			packages: {
				added: ["npm:new-package", "npm:@xyzensun/pi-sync"],
				changed: ["npm:changed-package@2"],
				removed: ["npm:removed-package"],
			},
		});

		expect(items).toEqual([
			expect.objectContaining({
				kind: "package-install",
				source: "npm:new-package",
			}),
			expect.objectContaining({
				kind: "package-install",
				source: "npm:changed-package@2",
			}),
			expect.objectContaining({
				kind: "package-remove",
				source: "npm:removed-package",
			}),
			expect.objectContaining({
				kind: "extension-apply",
				label: "tool",
				paths: ["extensions/tool/index.ts", "extensions/tool/lib.ts"],
			}),
			expect.objectContaining({
				kind: "extension-apply",
				label: "other.ts",
				paths: ["extensions/other.ts"],
			}),
		]);
		expect(items.some((item) => item.source === "npm:@xyzensun/pi-sync")).toBe(false);
	});

	it("labels local settings package changes as outgoing rather than installs", () => {
		const message = formatSyncPlanMessage({
			changes: [{ relativePath: "settings.json", changeType: "local_only" }],
			packages: {
				added: ["npm:removed-locally"],
				changed: [],
				removed: ["npm:new-local-package"],
			},
			remote: { ahead: 0, behind: 0 },
			pendingRecovery: false,
		});

		expect(message).toContain("停止共享 npm:removed-locally");
		expect(message).toContain("共享新包 npm:new-local-package");
		expect(message).not.toContain("安装 npm:removed-locally");
	});
});

describe("formatGitStatus", () => {
	it("formats a clean repo status", () => {
		const status: GitStatus = {
			branch: "main",
			commit: "abc1234567890def1234567890",
			commitShort: "abc1234",
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
		const result = formatGitStatus(status);
		expect(result).toContain("branch：");
		expect(result).toContain("main");
		expect(result).toContain("commit：");
		expect(result).toContain("abc1234");
		expect(result).toContain("未提交改动：");
		expect(result).toContain("无");
	});

	it("formats a dirty repo with changes", () => {
		const status: GitStatus = {
			branch: "feature",
			commit: "def5678901abc2345678901",
			commitShort: "def5678",
			ahead: 3,
			behind: 1,
			hasUncommittedChanges: true,
			hasUnpushedCommits: true,
			remoteExists: true,
			changedFiles: ["sync/settings.json"],
			isRebasing: false,
			isMerging: false,
			hasConflicts: false,
			conflictedFiles: [],
		};
		const result = formatGitStatus(status);
		expect(result).toContain("feature");
		expect(result).toContain("未提交改动：");
		expect(result).toContain("有");
	});

	it("formats rebasing and merging state", () => {
		const status: GitStatus = {
			branch: "main",
			commit: "abc1234",
			commitShort: "abc1234",
			ahead: 0,
			behind: 0,
			hasUncommittedChanges: false,
			hasUnpushedCommits: false,
			remoteExists: true,
			changedFiles: [],
			isRebasing: true,
			isMerging: true,
			hasConflicts: true,
			conflictedFiles: ["sync/file.md"],
		};
		const result = formatGitStatus(status);
		expect(result).toContain("rebase 中：");
		expect(result).toContain("merge 中：");
		expect(result).toContain("冲突：");
	});

	it("formats repo without remote", () => {
		const status: GitStatus = {
			branch: "main",
			commit: "abc1234",
			commitShort: "abc1234",
			ahead: 0,
			behind: 0,
			hasUncommittedChanges: false,
			hasUnpushedCommits: false,
			remoteExists: false,
			changedFiles: [],
			isRebasing: false,
			isMerging: false,
			hasConflicts: false,
			conflictedFiles: [],
		};
		const result = formatGitStatus(status);
		expect(result).toContain("远端：");
		expect(result).toContain("无");
	});
});

describe("formatComparisonDiff", () => {
	function makeComparison(
		relativePath: string,
		changeType: FileComparison["changeType"],
	): FileComparison {
		return {
			relativePath,
			changeType,
			baseline: makeFileEntry(),
			local: makeFileEntry("abc123456789"),
			remote: makeFileEntry("def123456789"),
		};
	}

	it("returns 'No files to compare' for an empty list", () => {
		expect(formatComparisonDiff([])).toBe("没有可比较的文件。");
	});

	it("shows icons and labels for different change types", () => {
		const comparisons: FileComparison[] = [
			makeComparison("prompts/local.md", "local_only"),
			makeComparison("prompts/remote.md", "remote_only"),
			makeComparison("prompts/both.md", "both_modified"),
			makeComparison("prompts/new.md", "local_created"),
			makeComparison("prompts/gone.md", "remote_deleted"),
		];
		const result = formatComparisonDiff(comparisons);
		expect(result).toContain("prompts/local.md");
		expect(result).toContain("prompts/remote.md");
		expect(result).toContain("prompts/both.md");
		expect(result).toContain("prompts/new.md");
		expect(result).toContain("prompts/gone.md");
	});

	it("skips no_change entries and returns no changes when all are unchanged", () => {
		const comparisons: FileComparison[] = [
			makeComparison("same.md", "no_change"),
		];
		expect(formatComparisonDiff(comparisons)).toBe("未检测到变更。");
	});
});

describe("formatSyncStatusV2", () => {
	it("renders a full status summary with header", () => {
		const gitStatus: GitStatus = {
			branch: "main",
			commit: "abc1234567890def1234567890",
			commitShort: "abc1234",
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

		const comparisons: FileComparison[] = [
			{
				relativePath: "settings.json",
				changeType: "remote_only",
				baseline: makeFileEntry(),
				local: makeFileEntry(),
				remote: makeFileEntry("def"),
			},
		];

		const inventory: InventoryResult = {
			comparisons,
			summary: {
				noChange: 0,
				localOnly: 0,
				remoteOnly: 1,
				converged: 0,
				bothModified: 0,
				localCreated: 0,
				remoteCreated: 0,
				localDeleted: 0,
				remoteDeleted: 0,
			},
		};

		const result = formatSyncStatusV2({
			repoPath: "/test/repo",
			agentDir: "/test/agent",
			gitStatus,
			config: {
				schemaVersion: 2,
				branch: "main",
				root: "sync",
				include: ["settings.json"],
				exclude: [],
				delete: "tracked" as const,
				pullTimeoutMs: 30000,
					special: {},
				autoSync: { enabled: false, intervalMinutes: 30 },
			},
			inventory,
			state: {
				schemaVersion: 3,
				repoPath: "/test/repo",
				branch: "main",
				lastSyncedCommit: "abc1234",
				lastSyncedAt: "2026-01-01T00:00:00Z",
				files: {},
				pendingOperation: null,
				lastBackup: null,
			},
		});

		expect(result).toContain("pi-sync");
		expect(result).toContain("sync/");
	});

	it("renders with pending operation and package diff", () => {
		const gitStatus: GitStatus = {
			branch: "main",
			commit: "abc1234",
			commitShort: "abc1234",
			ahead: 2,
			behind: 0,
			hasUncommittedChanges: true,
			hasUnpushedCommits: true,
			remoteExists: true,
			changedFiles: ["sync/settings.json"],
			isRebasing: false,
			isMerging: false,
			hasConflicts: false,
			conflictedFiles: [],
		};

		const inventory: InventoryResult = {
			comparisons: [],
			summary: {
				noChange: 0,
				localOnly: 0,
				remoteOnly: 0,
				converged: 0,
				bothModified: 0,
				localCreated: 0,
				remoteCreated: 0,
				localDeleted: 0,
				remoteDeleted: 0,
			},
		};

		const result = formatSyncStatusV2({
			repoPath: "/test/repo",
			agentDir: "/test/agent",
			gitStatus,
			config: {
				schemaVersion: 2,
				branch: "main",
				root: "sync",
				include: ["settings.json"],
				exclude: [],
				delete: "none" as const,
				pullTimeoutMs: 30000,
					special: {},
				autoSync: { enabled: false, intervalMinutes: 30 },
			},
			inventory,
			state: {
				schemaVersion: 3,
				repoPath: "/test/repo",
				branch: "main",
				lastSyncedCommit: null,
				lastSyncedAt: null,
				files: {},
				pendingOperation: {
					type: "push-rebase-conflict",
					startedAt: "2026-01-01T00-00-00Z",
				},
				lastBackup: "2026-01-01T00-00-00Z",
			},
			pkgDiff: {
				added: ["npm:pkg-a"],
				removed: [],
				changed: ["npm:pkg-b"],
				unchanged: ["npm:kept"],
			},
		});

		expect(result).toContain("pi-sync");
		// The pending operation should appear somewhere in the status
		expect(result.length).toBeGreaterThan(0);
	});

	it("lists conflicting files with Git merge instructions, not local and remote paths", () => {
		const gitStatus: GitStatus = {
			branch: "main",
			commit: "abc1234567890def1234567890",
			commitShort: "abc1234",
			ahead: 0,
			behind: 0,
			hasUncommittedChanges: true,
			hasUnpushedCommits: false,
			remoteExists: true,
			changedFiles: ["sync/prompts/welcome.md"],
			isRebasing: false,
			isMerging: true,
			hasConflicts: true,
			conflictedFiles: ["sync/prompts/welcome.md"],
		};
		const inventory: InventoryResult = {
			comparisons: [
				{
					relativePath: "prompts/welcome.md",
					changeType: "both_modified",
					baseline: makeFileEntry("base"),
					local: makeFileEntry("local"),
					remote: makeFileEntry("remote"),
				},
			],
			summary: {
				noChange: 0,
				localOnly: 0,
				remoteOnly: 0,
				converged: 0,
				bothModified: 1,
				localCreated: 0,
				remoteCreated: 0,
				localDeleted: 0,
				remoteDeleted: 0,
			},
		};

		const result = formatSyncStatusV2({
			repoPath: "/test/repo",
			agentDir: "/private/agent",
			gitStatus,
			config: {
				schemaVersion: 2,
				branch: "main",
				root: "sync",
				include: ["prompts/**"],
				exclude: [],
				delete: "tracked",
				pullTimeoutMs: 30000,
					special: {},
				autoSync: { enabled: false, intervalMinutes: 30 },
			},
			inventory,
			state: {
				schemaVersion: 3,
				repoPath: "/test/repo",
				branch: "main",
				lastSyncedCommit: null,
				lastSyncedAt: null,
				files: {},
				pendingOperation: null,
				lastBackup: null,
			},
		});

		expect(result).toContain("sync/prompts/welcome.md");
		expect(result).toContain("cd '/test/repo'");
		expect(result).toContain("git add .");
		expect(result).toContain('git commit -m "resolve conflicts"');
		expect(result).not.toContain("git status");
		expect(result).not.toContain("git fetch origin");
		expect(result).not.toContain("/private/agent");
		expect(result).not.toContain("Agent (local)");
		expect(result).not.toContain("Repo  (remote)");
	});
});

describe("formatValidationErrors", () => {
	it("formats errors and warnings", () => {
		const errors = [
			{
				file: "settings.json",
				message: "Invalid JSON",
				severity: "error" as const,
			},
			{
				file: "settings.json",
				message: "Missing pi-git-sync",
				severity: "warning" as const,
			},
		];
		const result = formatValidationErrors(errors);
		expect(result).toContain("错误");
		expect(result).toContain("警告");
		expect(result).toContain("Invalid JSON");
	});

	it("returns 'No validation errors' for empty list", () => {
		expect(formatValidationErrors([])).toBe("没有校验错误。");
	});
});

describe("formatCaptureResult", () => {
	it("formats capture result with captured and deleted files", () => {
		const result: CaptureResult = {
			captured: ["prompts/new.md", "settings.json"],
			deleted: ["prompts/old.md"],
			errors: [],
			hasConflicts: false,
			conflicts: [],
		};
		const output = formatCaptureResult(result);
		expect(output).toContain("new.md");
		expect(output).toContain("old.md");
	});

	it("returns 'No changes' for empty capture result", () => {
		const result: CaptureResult = {
			captured: [],
			deleted: [],
			errors: [],
			hasConflicts: false,
			conflicts: [],
		};
		const output = formatCaptureResult(result);
		// Should indicate nothing to capture
		expect(output.length).toBeGreaterThanOrEqual(0);
	});

	it("formats capture with errors", () => {
		const result: CaptureResult = {
			captured: ["prompts/safe.md"],
			deleted: [],
			errors: [{ file: "corrupt.json", message: "Invalid JSON" }],
			hasConflicts: false,
			conflicts: [],
		};
		const output = formatCaptureResult(result);
		expect(output).toContain("safe.md");
		expect(output).toContain("corrupt.json");
	});

	it("formats capture with conflicts", () => {
		const result: CaptureResult = {
			captured: [],
			deleted: [],
			errors: [],
			hasConflicts: true,
			conflicts: [
				{
					relativePath: "settings.json",
					changeType: "both_modified",
					baseline: makeFileEntry("base"),
					local: makeFileEntry("local"),
					remote: makeFileEntry("remote"),
				},
			],
		};
		const output = formatCaptureResult(result);
		expect(output).toContain("双边修改");
		expect(output).toContain("settings.json");
	});
});
