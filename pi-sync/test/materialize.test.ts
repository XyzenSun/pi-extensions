import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
	atomicWrite,
	planMaterialize,
	executeMaterialize,
	readAgentFile,
} from "../src/sync/materialize.ts";
import { sha256 } from "../src/sync/inventory.ts";
import type { PiSyncConfig } from "../src/sync/config.ts";
import type { SyncState } from "../src/system/state.ts";

function makeV2Config(overrides?: Partial<PiSyncConfig>): PiSyncConfig {
	return {
		schemaVersion: 2,
		branch: "main",
		root: "sync",
		include: ["**"],
		exclude: [],
		delete: "tracked",
		pullTimeoutMs: 30000,
		special: {},
		autoSync: { enabled: false, intervalMinutes: 30 },
		...overrides,
	};
}

function makeEmptyState(repoPath: string): SyncState {
	return {
		schemaVersion: 3,
		repoPath,
		branch: "main",
		lastSyncedCommit: null,
		lastSyncedAt: null,
		files: {},
		pendingOperation: null,
		lastBackup: null,
	};
}

describe("atomicWrite", () => {
	let targetDir: string;

	beforeEach(async () => {
		targetDir = join(
			tmpdir(),
			`pi-sync-atomic-${randomBytes(4).toString("hex")}`,
		);
		await mkdir(targetDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(targetDir, { recursive: true, force: true });
	});

	it("should write a file", async () => {
		const path = join(targetDir, "test.txt");
		await atomicWrite(path, "hello world");

		expect(existsSync(path)).toBe(true);
		const content = await readFile(path, "utf-8");
		expect(content).toBe("hello world");
	});

	it("should overwrite existing file", async () => {
		const path = join(targetDir, "test.txt");
		await writeFile(path, "old content");
		await atomicWrite(path, "new content");

		const content = await readFile(path, "utf-8");
		expect(content).toBe("new content");
	});

	it("should create parent directories", async () => {
		const path = join(targetDir, "sub", "dir", "test.txt");
		await atomicWrite(path, "hello");

		expect(existsSync(path)).toBe(true);
	});
});

describe("planMaterialize + executeMaterialize", () => {
	let repoPath: string;
	let agentDir: string;
	let syncDir: string;

	beforeEach(async () => {
		const base = tmpdir();
		repoPath = join(base, `pi-sync-repo-${randomBytes(4).toString("hex")}`);
		agentDir = join(base, `pi-sync-agent-${randomBytes(4).toString("hex")}`);
		syncDir = join(repoPath, "sync");

		await mkdir(syncDir, { recursive: true });
		await mkdir(agentDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(repoPath, { recursive: true, force: true });
		await rm(agentDir, { recursive: true, force: true });
	});

	it("should apply files from repo sync/ to agent dir", async () => {
		await writeFile(join(syncDir, "AGENTS.md"), "# AGENTS");

		const config = makeV2Config({ include: ["AGENTS.md", "**"] });
		const state = makeEmptyState(repoPath);

		const plan = await planMaterialize(agentDir, repoPath, config, state);

		// Should have a write plan for AGENTS.md
		const writePlan = plan.toWrite.find((w) => w.relativePath === "AGENTS.md");
		expect(writePlan).toBeDefined();

		const result = await executeMaterialize(agentDir, plan);
		expect(result.written).toContain("AGENTS.md");
		expect(existsSync(join(agentDir, "AGENTS.md"))).toBe(true);

		const content = await readFile(join(agentDir, "AGENTS.md"), "utf-8");
		expect(content).toBe("# AGENTS");
	});

	it("keeps a deferred remote extension pending without advancing its baseline", async () => {
		const relativePath = "extensions/remote-tool/index.ts";
		await mkdir(join(syncDir, "extensions/remote-tool"), { recursive: true });
		await writeFile(join(syncDir, relativePath), "export default {}\n");
		const config = makeV2Config({ include: ["extensions/**"] });
		const state = makeEmptyState(repoPath);

		const plan = await planMaterialize(agentDir, repoPath, config, state, {
			deferApplyPaths: new Set([relativePath]),
		});

		expect(plan.toWrite).toEqual([]);
		expect(plan.deferred).toEqual([relativePath]);
		expect(plan.nextBaseline?.[relativePath]).toBeUndefined();
	});

	it("should skip files not in include patterns", async () => {
		await writeFile(join(syncDir, "AGENTS.md"), "# AGENTS");

		const config = makeV2Config({ include: ["settings.json"] }); // AGENTS.md not in include
		const state = makeEmptyState(repoPath);

		const plan = await planMaterialize(agentDir, repoPath, config, state);
		expect(plan.toWrite).toHaveLength(0);
	});

	it("should handle tracked deletion", async () => {
		// Baseline had AGENTS.md, but repo has deleted it
		const state = makeEmptyState(repoPath);
		state.files["AGENTS.md"] = { sha256: "abc123", mode: 0o644 };

		const config = makeV2Config({
			include: ["AGENTS.md"],
			delete: "tracked",
		});

		const plan = await planMaterialize(agentDir, repoPath, config, state);
		// Should plan to delete since it was tracked and repo doesn't have it
		const deletePlan = plan.toDelete.find((d) => d === "AGENTS.md");
		expect(deletePlan).toBeDefined();
	});

	it("should not delete untracked files", async () => {
		// Create agent file not in baseline
		await writeFile(join(agentDir, "untracked.md"), "# untracked");

		const config = makeV2Config({ include: ["untracked.md"] });
		const state = makeEmptyState(repoPath);
		// No baseline entry — untracked

		const plan = await planMaterialize(agentDir, repoPath, config, state);
		// Should not plan to delete untracked files just because repo doesn't have them
		const deletePlan = plan.toDelete.find((d) => d === "untracked.md");
		expect(deletePlan).toBeUndefined();
	});

	// ========== design.md §0：include = 直接覆盖，special = 才走 adapter ==========

	it("does not read the local file for plain include entries (repo is authoritative)", async () => {
		// 本机同名路径是一个目录：普通 include 文件不读本机内容，计划阶段不应因此报错，
		// 让 backup 阶段照常负责"目标无法快照"的失败处理。
		await mkdir(join(syncDir, "prompts"), { recursive: true });
		await writeFile(join(syncDir, "prompts/remote.md"), "remote\n");
		await mkdir(join(agentDir, "prompts/remote.md"), { recursive: true });

		const config = makeV2Config({ include: ["prompts/**"] });
		const plan = await planMaterialize(agentDir, repoPath, config, makeEmptyState(repoPath));

		expect(plan.validationErrors).toEqual([]);
		expect(plan.blocked).toBe(false);
		expect(plan.toWrite.map((w) => w.relativePath)).toEqual(["prompts/remote.md"]);
	});

	it("overwrites settings.json byte-for-byte when it is only in include (no special)", async () => {
		const remoteSettings = `${JSON.stringify({ theme: "new" }, null, 2)}\n`;
		const localSettings = `${JSON.stringify(
			{ theme: "old", trackingId: "device-local" },
			null,
			2,
		)}\n`;
		await writeFile(join(syncDir, "settings.json"), remoteSettings);
		await writeFile(join(agentDir, "settings.json"), localSettings);
		// 基线 = 本机内容，使三方比较判定为 remote_only（仅远端变更）
		const state = makeEmptyState(repoPath);
		state.files["settings.json"] = { sha256: sha256(localSettings), mode: 0o644 };

		const config = makeV2Config({ include: ["settings.json"] });
		const plan = await planMaterialize(agentDir, repoPath, config, state);

		const write = plan.toWrite.find((w) => w.relativePath === "settings.json");
		// 没有 special 声明 → 不做白名单合并，本机 trackingId 不会被保留
		expect(write?.content.toString("utf-8")).toBe(remoteSettings);
	});

	it("merges settings.json through the adapter only when declared in special", async () => {
		const remoteSettings = `${JSON.stringify({ theme: "new" }, null, 2)}\n`;
		const localSettings = `${JSON.stringify(
			{ theme: "old", trackingId: "device-local" },
			null,
			2,
		)}\n`;
		await writeFile(join(syncDir, "settings.json"), remoteSettings);
		await writeFile(join(agentDir, "settings.json"), localSettings);
		const state = makeEmptyState(repoPath);
		state.files["settings.json"] = { sha256: sha256(localSettings), mode: 0o644 };

		const config = makeV2Config({
			include: ["settings.json"],
			special: { "settings.json": "settings" },
		});
		const plan = await planMaterialize(agentDir, repoPath, config, state);

		const write = plan.toWrite.find((w) => w.relativePath === "settings.json");
		expect(JSON.parse(write!.content.toString("utf-8"))).toEqual({
			theme: "new",
			trackingId: "device-local",
			// adapter 无条件注入自身包声明，避免本机 pull 后加载不到本扩展
			packages: ["npm:@xyzensun/pi-sync"],
		});
	});
});

describe("readAgentFile", () => {
	let agentDir: string;

	beforeEach(async () => {
		agentDir = join(tmpdir(), `pi-sync-read-${randomBytes(4).toString("hex")}`);
		await mkdir(agentDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(agentDir, { recursive: true, force: true });
	});

	it("should read a file and compute hash", async () => {
		await writeFile(join(agentDir, "test.txt"), "hello");

		const result = await readAgentFile(agentDir, "test.txt");
		expect(result).not.toBeNull();
		expect(result!.sha256).toBeDefined();
		expect(result!.sha256.length).toBe(64); // SHA-256 hex string
	});

	it("should return null for missing file", async () => {
		const result = await readAgentFile(agentDir, "nonexistent.txt");
		expect(result).toBeNull();
	});
});
