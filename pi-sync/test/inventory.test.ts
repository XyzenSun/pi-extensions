import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runOperation } from "../src/extension/operation-runner.ts";
import type { FileChangeType, FileComparison } from "../src/sync/inventory.ts";
import {
	compareFiles,
	getApplicableFiles,
	getCapturableFiles,
	hasBilateralConflicts,
	hasLocalChanges,
	sha256,
} from "../src/sync/inventory.ts";
import { withOperationSignal } from "../src/system/operation-context.ts";
import { createPiSyncConfig, createSyncState } from "./helpers/factories.ts";
import { withTestEnvironment } from "./helpers/temp-env.ts";

type Scenario = {
	name: string;
	baseline?: string;
	local?: string;
	remote?: string;
	expected: FileChangeType;
};

const scenarios: Scenario[] = [
	{
		name: "no change",
		baseline: "base",
		local: "base",
		remote: "base",
		expected: "no_change",
	},
	{
		name: "local-only update",
		baseline: "base",
		local: "local",
		remote: "base",
		expected: "local_only",
	},
	{
		name: "remote-only update",
		baseline: "base",
		local: "base",
		remote: "remote",
		expected: "remote_only",
	},
	{
		name: "identical bilateral update",
		baseline: "base",
		local: "same",
		remote: "same",
		expected: "converged",
	},
	{
		name: "different bilateral update",
		baseline: "base",
		local: "local",
		remote: "remote",
		expected: "both_modified",
	},
	{ name: "local create", local: "local", expected: "local_created" },
	{ name: "remote create", remote: "remote", expected: "remote_created" },
	{
		name: "local delete",
		baseline: "base",
		remote: "base",
		expected: "local_deleted",
	},
	{
		name: "remote delete",
		baseline: "base",
		local: "base",
		expected: "remote_deleted",
	},
	{ name: "both delete", baseline: "base", expected: "both_deleted" },
	{
		name: "local update and remote delete",
		baseline: "base",
		local: "local",
		expected: "local_modified_remote_deleted",
	},
	{
		name: "local delete and remote update",
		baseline: "base",
		remote: "remote",
		expected: "local_deleted_remote_modified",
	},
	{
		name: "identical concurrent create",
		local: "same",
		remote: "same",
		expected: "converged",
	},
	{
		name: "different concurrent create",
		local: "local",
		remote: "remote",
		expected: "both_modified",
	},
];

describe.sequential("three-way inventory", () => {
	it.each(scenarios)(
		"classifies $name",
		async ({ baseline, local, remote, expected }) => {
			await withTestEnvironment(async (environment) => {
				const relativePath = "themes/dark.json";
				if (local !== undefined)
					await environment.writeAgentFile(relativePath, local);
				if (remote !== undefined)
					await environment.writeRepoFile(`sync/${relativePath}`, remote);

				const state = createSyncState({
					repoPath: environment.repoDir,
					files:
						baseline === undefined
							? {}
							: {
									[relativePath]: { sha256: sha256(baseline), mode: 0o644 },
								},
				});
				const inventory = await compareFiles(
					environment.agentDir,
					environment.repoDir,
					createPiSyncConfig({ include: ["**"] }),
					state,
				);

				expect(inventory.comparisons).toHaveLength(1);
				expect(inventory.comparisons[0]).toMatchObject({
					relativePath,
					changeType: expected,
				});
			});
		},
	);

	it("selects capture/apply candidates and identifies bilateral conflicts", () => {
		const comparisons = [
			"local_only",
			"local_created",
			"local_deleted",
			"remote_only",
			"remote_created",
			"remote_deleted",
			"both_deleted",
			"converged",
			"both_modified",
			"local_modified_remote_deleted",
			"local_deleted_remote_modified",
		].map(
			(changeType) =>
				({ relativePath: changeType, changeType }) as FileComparison,
		);

		expect(
			getCapturableFiles(comparisons).map(({ changeType }) => changeType),
		).toEqual(["local_only", "local_created", "local_deleted"]);
		expect(
			getApplicableFiles(comparisons).map(({ changeType }) => changeType),
		).toEqual([
			"remote_only",
			"remote_created",
			"remote_deleted",
			"both_deleted",
			"converged",
		]);
		expect(hasLocalChanges(comparisons)).toBe(true);
		expect(hasBilateralConflicts(comparisons)).toBe(true);
	});

	it("prunes trees outside the include list before inspecting their contents", async () => {
		await withTestEnvironment(async (environment) => {
			const outsideDir = join(environment.rootDir, "outside");
			const ignoredLink = join(environment.agentDir, "npm", "ignored-link");
			await mkdir(join(environment.agentDir, "npm"), { recursive: true });
			await mkdir(outsideDir, { recursive: true });
			await writeFile(join(outsideDir, "outside.txt"), "outside", "utf-8");
			await symlink(
				outsideDir,
				ignoredLink,
				process.platform === "win32" ? "junction" : "dir",
			);
			await environment.writeAgentFile("settings.json", "{}\n");

			const inventory = await compareFiles(
				environment.agentDir,
				environment.repoDir,
				createPiSyncConfig({ include: ["settings.json"] }),
				createSyncState({ repoPath: environment.repoDir }),
			);

			expect(
				inventory.comparisons.map(({ relativePath }) => relativePath),
			).toEqual(["settings.json"]);
		});
	});

	it.each([
		{
			name: "nested node_modules excluded by manifest",
			relativeDir: "extensions/demo/node_modules",
			exclude: ["**/node_modules/**"],
		},
		{
			name: "nested logs from manifest excludes",
			relativeDir: "extensions/demo/logs",
			exclude: ["extensions/**/logs/**"],
		},
	])("prunes $name as a complete tree", async ({ relativeDir, exclude }) => {
		await withTestEnvironment(async (environment) => {
			const outsideDir = join(environment.rootDir, "outside");
			const ignoredLink = join(
				environment.agentDir,
				relativeDir,
				"ignored-link",
			);
			await mkdir(join(environment.agentDir, relativeDir), { recursive: true });
			await mkdir(outsideDir, { recursive: true });
			await writeFile(join(outsideDir, "outside.txt"), "outside", "utf-8");
			await symlink(
				outsideDir,
				ignoredLink,
				process.platform === "win32" ? "junction" : "dir",
			);
			await environment.writeAgentFile(
				"extensions/demo/index.ts",
				"export {};\n",
			);

			const inventory = await compareFiles(
				environment.agentDir,
				environment.repoDir,
				createPiSyncConfig({ include: ["extensions/**"], exclude }),
				createSyncState({ repoPath: environment.repoDir }),
			);

			expect(
				inventory.comparisons.map(({ relativePath }) => relativePath),
			).toEqual(["extensions/demo/index.ts"]);
		});
	});

	it("stops before inventory work when the operation is cancelled", async () => {
		await withTestEnvironment(async (environment) => {
			const controller = new AbortController();
			controller.abort();

			await expect(
				withOperationSignal(controller.signal, () =>
					compareFiles(
						environment.agentDir,
						environment.repoDir,
						createPiSyncConfig({ include: ["**"] }),
						createSyncState({ repoPath: environment.repoDir }),
					),
				),
			).rejects.toMatchObject({ name: "AbortError" });
		});
	});

	it("stops an in-flight inventory when the operation watchdog expires", async () => {
		await withTestEnvironment(async (environment) => {
			const payload = "x".repeat(16 * 1024);
			await Promise.all(
				Array.from({ length: 256 }, (_, index) =>
					environment.writeAgentFile(`themes/generated/${index}.json`, payload),
				),
			);
			let inventoryStarted = false;
			let inventoryCompleted = false;

			const result = await runOperation({
				execute: ({ signal }) =>
					withOperationSignal(signal, async () => {
						inventoryStarted = true;
						await compareFiles(
							environment.agentDir,
							environment.repoDir,
							createPiSyncConfig({ include: ["themes/**"] }),
							createSyncState({ repoPath: environment.repoDir }),
						);
						inventoryCompleted = true;
						return {
							ok: true,
							code: "ok",
							message: "Inventory complete.",
							reload: false,
							mode: "sync",
							phase: "complete",
						};
					}),
				host: {
					formatProgress: (_elapsedMs, message) => message,
					publishProgress: () => undefined,
				},
				runTimeoutMs: 0,
				commandSettleGraceMs: 100,
				elapsedRefreshMs: 1000,
				cancellationNoticeDelayMs: 0,
			});

			expect(inventoryStarted).toBe(true);
			expect(result).toMatchObject({
				ok: false,
				code: "partial_failure",
				phase: "preflight",
			});
			expect(inventoryCompleted).toBe(false);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(inventoryCompleted).toBe(false);
		});
	});

	it("inventories dotfiles when include matches (完全控制, 无隐藏文件黑名单)", async () => {
		await withTestEnvironment(async (environment) => {
			await mkdir(
				join(environment.agentDir, "skills", "pullpage"),
				{ recursive: true },
			);
			await writeFile(
				join(environment.agentDir, "skills", "pullpage", ".env"),
				"KEY=1\n",
				"utf-8",
			);
			await writeFile(join(environment.agentDir, ".secret"), "hidden", "utf-8");

			const inventory = await compareFiles(
				environment.agentDir,
				environment.repoDir,
				createPiSyncConfig({ include: ["**"] }),
				createSyncState({ repoPath: environment.repoDir }),
			);
			const paths = inventory.comparisons.map((c) => c.relativePath);
			expect(paths).toContain(".secret");
			expect(paths).toContain("skills/pullpage/.env");

			// exclude 优先级高于 include, 点文件同样受 exclude 控制
			const excluded = await compareFiles(
				environment.agentDir,
				environment.repoDir,
				createPiSyncConfig({ include: ["**"], exclude: [".secret"] }),
				createSyncState({ repoPath: environment.repoDir }),
			);
			const excludedPaths = excluded.comparisons.map((c) => c.relativePath);
			expect(excludedPaths).not.toContain(".secret");
			expect(excludedPaths).toContain("skills/pullpage/.env");
		});
	});

	it("blocks symbolic links", async () => {
		await withTestEnvironment(async (environment) => {
			const outsidePath = join(environment.rootDir, "outside.txt");
			const linkPath = join(environment.agentDir, "themes", "linked.txt");
			await mkdir(join(environment.agentDir, "themes"), { recursive: true });
			await writeFile(outsidePath, "outside", "utf-8");
			await symlink(outsidePath, linkPath);

			await expect(
				compareFiles(
					environment.agentDir,
					environment.repoDir,
					createPiSyncConfig({ include: ["**"] }),
					createSyncState({ repoPath: environment.repoDir }),
				),
			).rejects.toThrow("拒绝将符号链接纳入清单");
		});
	});
});
