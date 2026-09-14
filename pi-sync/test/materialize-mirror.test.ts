import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { planMaterialize } from "../src/sync/materialize.ts";
import { compareFiles, sha256 } from "../src/sync/inventory.ts";
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
 * - shared.md    两端都改 → 双边冲突
 * - local-new.md 仅本机新建
 * - repo-new.md  仅远端新建
 * - stale.md     远端删除，本机还在（基线有记录）
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
	await runGit(repoPath, ["add", "--all"]);
	await runGit(repoPath, ["commit", "--no-gpg-sign", "-m", "seed"]);

	await environment.writeAgentFile("prompts/shared.md", "local\n");
	await environment.writeAgentFile("prompts/local-new.md", "only mine\n");
	await environment.writeAgentFile("prompts/stale.md", "left over\n");

	const state = createSyncState({
		repoPath,
		files: {
			"prompts/shared.md": { sha256: sha256("base\n"), mode: 0o644 },
			"prompts/stale.md": { sha256: sha256("left over\n"), mode: 0o644 },
		},
	});
	return { repoPath, state };
}

describe.sequential("planMaterialize mirrorRemote (tui-prd 4.2)", () => {
	it("blocks on a bilateral conflict without mirrorRemote", async () => {
		await withTestEnvironment(async (environment) => {
			const { repoPath, state } = await seedDivergence(environment);
			const plan = await planMaterialize(
				environment.agentDir,
				repoPath,
				baseConfig as never,
				state,
			);

			expect(plan.blocked).toBe(true);
			expect(plan.conflicts.map((c) => c.relativePath)).toContain(
				"prompts/shared.md",
			);
		});
	});

	it("mirrors the remote exactly: takes remote content and drops local-only files", async () => {
		await withTestEnvironment(async (environment) => {
			const { repoPath, state } = await seedDivergence(environment);
			const plan = await planMaterialize(
				environment.agentDir,
				repoPath,
				baseConfig as never,
				state,
				{ mirrorRemote: true },
			);

			expect(plan.blocked).toBe(false);
			// 冲突不再阻断，取远端内容。
			const written = Object.fromEntries(
				plan.toWrite.map((item) => [
					item.relativePath,
					item.content.toString("utf-8"),
				]),
			);
			expect(written["prompts/shared.md"]).toBe("remote\n");
			expect(written["prompts/repo-new.md"]).toBe("from repo\n");

			// 本机独有的文件被删除——这正是此前 useRemoteForConflicts 够不到的缺口。
			expect(plan.toDelete).toContain("prompts/local-new.md");
			// 远端已删除的文件同样删掉。
			expect(plan.toDelete).toContain("prompts/stale.md");

			// 基线收口为"远端的样子"：删掉的两个都不该留在基线里。
			const baseline = plan.nextBaseline ?? {};
			expect(Object.keys(baseline).sort()).toEqual([
				"prompts/repo-new.md",
				"prompts/shared.md",
			]);
			expect(baseline["prompts/shared.md"]?.sha256).toBe(sha256("remote\n"));
		});
	});

	it("still deletes local-only files when delete is none (要删就真删)", async () => {
		await withTestEnvironment(async (environment) => {
			const config = { ...baseConfig, delete: "none" };
			const { repoPath, state } = await seedDivergence(environment, config);
			const plan = await planMaterialize(
				environment.agentDir,
				repoPath,
				config as never,
				state,
				{ mirrorRemote: true },
			);

			// delete:"none" 管的是"删除要不要跨机传播"，整机对齐是用户显式
			// 要求的一次性动作，不受它约束，否则本机不等于远端。
			expect(plan.toDelete).toContain("prompts/local-new.md");
			expect(plan.toDelete).toContain("prompts/stale.md");
		});
	});

	it("honours delete:none on a normal apply (未受本次改动影响)", async () => {
		await withTestEnvironment(async (environment) => {
			const config = { ...baseConfig, delete: "none" };
			const fixture = await createGitFixture(environment.rootDir);
			const repoPath = fixture.deviceAPath;
			await mkdir(join(repoPath, "sync/prompts"), { recursive: true });
			await writeFile(join(repoPath, "pi-sync.json"), JSON.stringify(config));
			await runGit(repoPath, ["add", "--all"]);
			await runGit(repoPath, ["commit", "--no-gpg-sign", "-m", "seed"]);

			// 远端删了、本机还在、基线有记录：常规 apply 下 delete:none 应保留。
			await environment.writeAgentFile("prompts/stale.md", "left over\n");
			const state = createSyncState({
				repoPath,
				files: {
					"prompts/stale.md": { sha256: sha256("left over\n"), mode: 0o644 },
				},
			});

			const plan = await planMaterialize(
				environment.agentDir,
				repoPath,
				config as never,
				state,
			);
			expect(plan.toDelete).not.toContain("prompts/stale.md");
		});
	});

	it("leaves whitelist-excluded files alone even when mirroring", async () => {
		await withTestEnvironment(async (environment) => {
			const { repoPath, state } = await seedDivergence(environment);
			// 白名单外的文件从不进入三方比较，整机对齐也碰不到它。
			await environment.writeAgentFile("notes/private.md", "not synced\n");

			const plan = await planMaterialize(
				environment.agentDir,
				repoPath,
				baseConfig as never,
				state,
				{ mirrorRemote: true },
			);

			expect(plan.toDelete).not.toContain("notes/private.md");
			expect(
				plan.toWrite.some((item) => item.relativePath === "notes/private.md"),
			).toBe(false);
		});
	});

	it("is a no-op when the local side already matches the remote", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			const repoPath = fixture.deviceAPath;
			await mkdir(join(repoPath, "sync/prompts"), { recursive: true });
			await writeFile(join(repoPath, "pi-sync.json"), JSON.stringify(baseConfig));
			await writeFile(join(repoPath, "sync/prompts/shared.md"), "same\n");
			await runGit(repoPath, ["add", "--all"]);
			await runGit(repoPath, ["commit", "--no-gpg-sign", "-m", "seed"]);
			await environment.writeAgentFile("prompts/shared.md", "same\n");

			const state = createSyncState({
				repoPath,
				files: {
					"prompts/shared.md": { sha256: sha256("same\n"), mode: 0o644 },
				},
			});
			const plan = await planMaterialize(
				environment.agentDir,
				repoPath,
				baseConfig as never,
				state,
				{ mirrorRemote: true },
			);

			expect(plan.toWrite).toHaveLength(0);
			expect(plan.toDelete).toHaveLength(0);
			expect(plan.blocked).toBe(false);
		});
	});

	it("reports the paths a mirror would discard, for the confirm page", async () => {
		await withTestEnvironment(async (environment) => {
			const { repoPath, state } = await seedDivergence(environment);
			const inventory = await compareFiles(
				environment.agentDir,
				repoPath,
				baseConfig as never,
				state,
			);

			// 确认页要列出"将丢失的具体路径"：本机改动与本机独有文件。
			const losing = inventory.comparisons
				.filter(
					(comparison) =>
						comparison.changeType === "local_only" ||
						comparison.changeType === "local_created" ||
						comparison.changeType === "both_modified",
				)
				.map((comparison) => comparison.relativePath)
				.sort();

			expect(losing).toEqual(["prompts/local-new.md", "prompts/shared.md"]);
		});
	});
});