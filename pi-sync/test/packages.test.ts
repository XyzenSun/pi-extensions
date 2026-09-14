import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { getPackageDiff } from "../src/system/packages.ts";
import type { PiSyncConfig } from "../src/sync/config.ts";

function makeV2Config(overrides?: Partial<PiSyncConfig>): PiSyncConfig {
	return {
		schemaVersion: 2,
		branch: "main",
		root: "sync",
		include: ["settings.json"],
		exclude: [],
		delete: "tracked",
		pullTimeoutMs: 30000,
		special: {},
		autoSync: { enabled: false, intervalMinutes: 30 },
		...overrides,
	};
}

describe("getPackageDiff", () => {
	let repoPath: string;
	let agentDir: string;
	const config = makeV2Config();

	beforeEach(async () => {
		const base = tmpdir();
		repoPath = join(base, `pi-sync-pkg-repo-${randomBytes(4).toString("hex")}`);
		agentDir = join(
			base,
			`pi-sync-pkg-agent-${randomBytes(4).toString("hex")}`,
		);

		await mkdir(join(repoPath, "sync"), { recursive: true });
		await mkdir(agentDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(repoPath, { recursive: true, force: true });
		await rm(agentDir, { recursive: true, force: true });
	});

	it("should detect added packages", async () => {
		await writeFile(
			join(repoPath, "sync", "settings.json"),
			JSON.stringify({
				packages: ["npm:test-package@1.0.0", "git:github.com/user/repo"],
			}),
		);
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({}));

		const diff = await getPackageDiff(repoPath, agentDir, config);
		expect(diff.added).toHaveLength(2);
		expect(diff.removed).toHaveLength(0);
		expect(diff.unchanged).toHaveLength(0);
	});

	it("should detect removed packages", async () => {
		await writeFile(
			join(repoPath, "sync", "settings.json"),
			JSON.stringify({}),
		);
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({
				packages: ["npm:test-package@1.0.0"],
			}),
		);

		const diff = await getPackageDiff(repoPath, agentDir, config);
		expect(diff.added).toHaveLength(0);
		expect(diff.removed).toHaveLength(1);
	});

	it("should detect unchanged packages", async () => {
		await writeFile(
			join(repoPath, "sync", "settings.json"),
			JSON.stringify({
				packages: ["npm:test-package@1.0.0"],
			}),
		);
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({
				packages: ["npm:test-package@1.0.0"],
			}),
		);

		const diff = await getPackageDiff(repoPath, agentDir, config);
		expect(diff.added).toHaveLength(0);
		expect(diff.removed).toHaveLength(0);
		expect(diff.unchanged).toHaveLength(1);
	});

	it("should detect changed packages (same name, different source)", async () => {
		await writeFile(
			join(repoPath, "sync", "settings.json"),
			JSON.stringify({
				packages: ["npm:test-package@2.0.0"],
			}),
		);
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({
				packages: ["npm:test-package@1.0.0"],
			}),
		);

		const diff = await getPackageDiff(repoPath, agentDir, config);
		expect(diff.changed).toHaveLength(1);
		expect(diff.added).toHaveLength(0);
		expect(diff.removed).toHaveLength(0);
	});

	it("should handle package objects with source field", async () => {
		await writeFile(
			join(repoPath, "sync", "settings.json"),
			JSON.stringify({
				packages: [
					"npm:simple-pkg",
					{ source: "npm:complex-pkg", extensions: ["extensions/*.ts"] },
				],
			}),
		);
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({
				packages: ["npm:simple-pkg"],
			}),
		);

		const diff = await getPackageDiff(repoPath, agentDir, config);
		expect(diff.added).toHaveLength(1);
		expect(diff.added[0]).toContain("complex-pkg");
		expect(diff.unchanged).toHaveLength(1);
	});

	it("should handle missing files gracefully", async () => {
		const diff = await getPackageDiff(repoPath, agentDir, config);
		expect(diff.added).toHaveLength(0);
		expect(diff.removed).toHaveLength(0);
		expect(diff.unchanged).toHaveLength(0);
	});

	it("should handle git URL formats consistently", async () => {
		await writeFile(
			join(repoPath, "sync", "settings.json"),
			JSON.stringify({
				packages: ["git:github.com/user/repo@v1"],
			}),
		);
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({
				packages: ["https://github.com/user/repo@v1"],
			}),
		);

		const diff = await getPackageDiff(repoPath, agentDir, config);
		// Both normalize to "github.com/user/repo"
		expect(diff.added).toHaveLength(0);
		expect(diff.removed).toHaveLength(0);
		expect(diff.changed).toHaveLength(1);
	});
});
