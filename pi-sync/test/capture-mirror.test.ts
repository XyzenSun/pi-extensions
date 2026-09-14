import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { captureChanges } from "../src/sync/capture.ts";
import { sha256 } from "../src/sync/inventory.ts";
import { createSyncState } from "./helpers/factories.ts";
import { createGitFixture, runGit } from "./helpers/git-fixture.ts";
import { withTestEnvironment } from "./helpers/temp-env.ts";

const baseConfig = {
	schemaVersion: 2,
	branch: "main",
	root: "sync",
	include: ["prompts/**", "settings.json"],
	exclude: [],
	delete: "tracked",
	autoSync: { enabled: false, intervalMinutes: 30 },
	pullTimeoutMs: 60_000,
	special: {},
} as const;

/**
 * 建一个"本机与远端各有差异"的局面：
 * - shared.md     两端都改 → 双边冲突
 * - local-new.md  仅本机新建
 * - repo-new.md   仅仓库新建（本机从没有过）
 * - repo-edit.md  仅仓库改过，本机那份仍是基线内容
 */
async function seedDivergence(
	environment: Parameters<Parameters<typeof withTestEnvironment>[0]>[0],
	config: Record<string, unknown> = baseConfig,
): Promise<{ repoPath: string; state: ReturnType<typeof createSyncState> }> {
	const fixture = await createGitFixture(environment.rootDir);
	const repoPath = fixture.deviceAPath;
	await mkdir(join(repoPath, "sync/prompts"), { recursive: true });
	await writeFile(join(repoPath, "pi-sync.json"), JSON.stringify(config));
	await writeFile(join(repoPath, "sync/prompts/shared.md"), "remote\n");
	await writeFile(join(repoPath, "sync/prompts/repo-new.md"), "from repo\n");
	await writeFile(join(repoPath, "sync/prompts/repo-edit.md"), "repo edited\n");
	await runGit(repoPath, ["add", "--all"]);
	await runGit(repoPath, ["commit", "--no-gpg-sign", "-m", "seed"]);

	await environment.writeAgentFile("prompts/shared.md", "local\n");
	await environment.writeAgentFile("prompts/local-new.md", "only mine\n");
	await environment.writeAgentFile("prompts/repo-edit.md", "baseline\n");

	const state = createSyncState({
		repoPath,
		files: {
			"prompts/shared.md": { sha256: sha256("base\n"), mode: 0o644 },
			"prompts/repo-edit.md": { sha256: sha256("baseline\n"), mode: 0o644 },
		},
	});
	return { repoPath, state };
}

function repoFile(repoPath: string, relativePath: string): string {
	return join(repoPath, "sync", relativePath);
}

describe.sequential("captureChanges mirrorLocal (tui-prd 4.2)", () => {
	it("blocks on a bilateral conflict without mirrorLocal", async () => {
		await withTestEnvironment(async (environment) => {
			const { repoPath, state } = await seedDivergence(environment);
			const result = await captureChanges(
				environment.agentDir,
				repoPath,
				baseConfig as never,
				state,
			);

			expect(result.hasConflicts).toBe(true);
			expect(result.conflicts.map((c) => c.relativePath)).toContain(
				"prompts/shared.md",
			);
		});
	});

	it("mirrors the local side exactly: pushes local content and drops repo-only files", async () => {
		await withTestEnvironment(async (environment) => {
			const { repoPath, state } = await seedDivergence(environment);
			const result = await captureChanges(
				environment.agentDir,
				repoPath,
				baseConfig as never,
				state,
				{ mirrorLocal: true },
			);

			expect(result.hasConflicts).toBe(false);
			// 冲突取本机内容。
			expect(await readFile(repoFile(repoPath, "prompts/shared.md"), "utf-8")).toBe(
				"local\n",
			);
			// 本机新建推上去。
			expect(
				await readFile(repoFile(repoPath, "prompts/local-new.md"), "utf-8"),
			).toBe("only mine\n");
			// 仓库单方面改过的文件，用本机内容盖回去。
			expect(
				await readFile(repoFile(repoPath, "prompts/repo-edit.md"), "utf-8"),
			).toBe("baseline\n");
			// 仓库独有的文件被删除——这正是此前 capture 够不到的缺口。
			expect(result.deleted).toContain("prompts/repo-new.md");
			expect(existsSync(repoFile(repoPath, "prompts/repo-new.md"))).toBe(false);
		});
	});

	it("still deletes repo-only files when delete is none (要删就真删)", async () => {
		await withTestEnvironment(async (environment) => {
			const config = { ...baseConfig, delete: "none" };
			const { repoPath, state } = await seedDivergence(environment, config);
			const result = await captureChanges(
				environment.agentDir,
				repoPath,
				config as never,
				state,
				{ mirrorLocal: true },
			);

			expect(result.deleted).toContain("prompts/repo-new.md");
			expect(existsSync(repoFile(repoPath, "prompts/repo-new.md"))).toBe(false);
		});
	});

	it("never deletes a repo file the local side still has", async () => {
		await withTestEnvironment(async (environment) => {
			const { repoPath, state } = await seedDivergence(environment);
			await captureChanges(
				environment.agentDir,
				repoPath,
				baseConfig as never,
				state,
				{ mirrorLocal: true },
			);

			// repo-edit.md 是 remote_only（本机仍有该文件），必须被覆盖而不是删除。
			expect(existsSync(repoFile(repoPath, "prompts/repo-edit.md"))).toBe(true);
			expect(existsSync(repoFile(repoPath, "prompts/shared.md"))).toBe(true);
		});
	});

	it("leaves whitelist-excluded repo files alone", async () => {
		await withTestEnvironment(async (environment) => {
			const { repoPath, state } = await seedDivergence(environment);
			// 白名单外的仓库文件不进入三方比较，整机对齐也碰不到它。
			await mkdir(join(repoPath, "sync/notes"), { recursive: true });
			await writeFile(repoFile(repoPath, "notes/keep.md"), "not synced\n");

			await captureChanges(
				environment.agentDir,
				repoPath,
				baseConfig as never,
				state,
				{ mirrorLocal: true },
			);

			expect(existsSync(repoFile(repoPath, "notes/keep.md"))).toBe(true);
		});
	});

	it("propagates a local deletion to the repo", async () => {
		await withTestEnvironment(async (environment) => {
			const { repoPath, state } = await seedDivergence(environment);
			// shared.md 本机删掉：整机对齐后仓库里也不该有。
			const { rm } = await import("node:fs/promises");
			await rm(join(environment.agentDir, "prompts/shared.md"));

			const result = await captureChanges(
				environment.agentDir,
				repoPath,
				baseConfig as never,
				state,
				{ mirrorLocal: true },
			);

			expect(result.deleted).toContain("prompts/shared.md");
			expect(existsSync(repoFile(repoPath, "prompts/shared.md"))).toBe(false);
		});
	});

	it("is a no-op when the repo already matches the local side", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			const repoPath = fixture.deviceAPath;
			await mkdir(join(repoPath, "sync/prompts"), { recursive: true });
			await writeFile(join(repoPath, "pi-sync.json"), JSON.stringify(baseConfig));
			await writeFile(repoFile(repoPath, "prompts/shared.md"), "same\n");
			await runGit(repoPath, ["add", "--all"]);
			await runGit(repoPath, ["commit", "--no-gpg-sign", "-m", "seed"]);
			await environment.writeAgentFile("prompts/shared.md", "same\n");

			const state = createSyncState({
				repoPath,
				files: {
					"prompts/shared.md": { sha256: sha256("same\n"), mode: 0o644 },
				},
			});
			const result = await captureChanges(
				environment.agentDir,
				repoPath,
				baseConfig as never,
				state,
				{ mirrorLocal: true },
			);

			expect(result.captured).toHaveLength(0);
			expect(result.deleted).toHaveLength(0);
		});
	});
});