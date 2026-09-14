/**
 * autoSync（design.md §6）单测：单向 git 权威 + baseline 三方比较。
 *
 * 核心行为：
 * - 未初始化 / autoSync 关闭 → skipped
 * - 本机有未推送漂移（L≠B）→ skipped（绝不吞本机改动）
 * - 远端有更新（R≠B）且本机干净（L≈B）→ applied
 * - 仓库处于冲突/脏状态 → skipped
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiSyncCommands } from "../src/orchestration/commands.ts";
import { sha256 } from "../src/sync/inventory.ts";
import { saveState } from "../src/system/state.ts";
import { createPiSyncConfig, createSyncState } from "./helpers/factories.ts";
import { createGitFixture, runGit } from "./helpers/git-fixture.ts";
import { withTestEnvironment } from "./helpers/temp-env.ts";

async function seedRemote(
	repoPath: string,
	configOverride: object,
	files: Record<string, string>,
): Promise<void> {
	await mkdir(join(repoPath, "sync/prompts"), { recursive: true });
	await writeFile(
		join(repoPath, "pi-sync.json"),
		JSON.stringify(configOverride),
		"utf-8",
	);
	for (const [path, content] of Object.entries(files)) {
		await writeFile(join(repoPath, "sync", path), content, "utf-8");
	}
	await runGit(repoPath, ["add", "--all"]);
	await runGit(repoPath, ["commit", "--no-gpg-sign", "-m", "Seed"]);
	await runGit(repoPath, ["push", "--set-upstream", "origin", "main"]);
}

describe.sequential("autoSync (design.md §6)", () => {
	it("skips when autoSync is disabled", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedRemote(fixture.deviceAPath, createPiSyncConfig(), {
				"prompts/welcome.md": "base\n",
			});
			await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);
			await environment.writeAgentFile("prompts/welcome.md", "base\n");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"prompts/welcome.md": {
							sha256: sha256("base\n"),
							mode: 0o644,
						},
					},
				}),
			);

			const result = await new PiSyncCommands(environment.agentDir).autoSyncOnce(
				fixture.deviceBPath,
			);
			expect(result).toMatchObject({ status: "skipped", reason: "disabled" });
		});
	});

	it("applies remote updates silently when the local side is clean (R≠B, L≈B)", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedRemote(
				fixture.deviceAPath,
				createPiSyncConfig({
					autoSync: { enabled: true, intervalMinutes: 30 },
				}),
				{ "prompts/welcome.md": "base\n" },
			);
			await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);
			await environment.writeAgentFile("prompts/welcome.md", "base\n");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"prompts/welcome.md": {
							sha256: sha256("base\n"),
							mode: 0o644,
						},
					},
				}),
			);

			// 远端更新
			await writeFile(
				join(fixture.deviceAPath, "sync/prompts/welcome.md"),
				"remote v2\n",
				"utf-8",
			);
			await runGit(fixture.deviceAPath, ["add", "sync/prompts/welcome.md"]);
			await runGit(fixture.deviceAPath, ["commit", "-m", "Remote update"]);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);

			const result = await new PiSyncCommands(environment.agentDir).autoSyncOnce(
				fixture.deviceBPath,
			);

			expect(result).toMatchObject({ status: "applied", reload: true });
			const { readFile } = await import("node:fs/promises");
			expect(
				await readFile(
					join(environment.agentDir, "prompts/welcome.md"),
					"utf-8",
				),
			).toBe("remote v2\n");
		});
	});

	it("skips when the local side has un-pushed drift (L≠B)", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedRemote(
				fixture.deviceAPath,
				createPiSyncConfig({
					autoSync: { enabled: true, intervalMinutes: 30 },
				}),
				{ "prompts/welcome.md": "base\n" },
			);
			await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);
			await environment.writeAgentFile("prompts/welcome.md", "base\n");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"prompts/welcome.md": {
							sha256: sha256("base\n"),
							mode: 0o644,
						},
					},
				}),
			);

			// 本机漂移（未推送）与远端更新同时存在
			await environment.writeAgentFile("prompts/welcome.md", "local drift\n");
			await writeFile(
				join(fixture.deviceAPath, "sync/prompts/welcome.md"),
				"remote v2\n",
				"utf-8",
			);
			await runGit(fixture.deviceAPath, ["add", "sync/prompts/welcome.md"]);
			await runGit(fixture.deviceAPath, ["commit", "-m", "Remote update"]);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);

			const result = await new PiSyncCommands(environment.agentDir).autoSyncOnce(
				fixture.deviceBPath,
			);

			expect(result).toMatchObject({ status: "skipped", reason: "drift" });
			// 本机漂移必须保留，绝不自动覆盖或推送
			const { readFile } = await import("node:fs/promises");
			expect(
				await readFile(
					join(environment.agentDir, "prompts/welcome.md"),
					"utf-8",
				),
			).toBe("local drift\n");
		});
	});

	it("skips while a manual sync holds the orchestration lock in the same process", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedRemote(
				fixture.deviceAPath,
				createPiSyncConfig({
					autoSync: { enabled: true, intervalMinutes: 30 },
				}),
				{ "prompts/welcome.md": "base\n" },
			);
			await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);
			await environment.writeAgentFile("prompts/welcome.md", "base\n");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"prompts/welcome.md": {
							sha256: sha256("base\n"),
							mode: 0o644,
						},
					},
				}),
			);

			// 远端有更新——若无重入自查，autoSync 会真的落地它。
			await writeFile(
				join(fixture.deviceAPath, "sync/prompts/welcome.md"),
				"remote v2\n",
				"utf-8",
			);
			await runGit(fixture.deviceAPath, ["add", "sync/prompts/welcome.md"]);
			await runGit(fixture.deviceAPath, ["commit", "-m", "Remote update"]);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);

			// 模拟手动 run() 正在执行：定时器与命令共用同一个实例，此时
			// withCommandLock 会对本实例重入短路，文件锁挡不住。
			const commands = new PiSyncCommands(environment.agentDir);
			const withLockHeld = commands as unknown as {
				orchestrationLockHeld: boolean;
			};
			withLockHeld.orchestrationLockHeld = true;
			try {
				const result = await commands.autoSyncOnce(fixture.deviceBPath);
				expect(result).toMatchObject({ status: "skipped", reason: "busy" });
			} finally {
				withLockHeld.orchestrationLockHeld = false;
			}

			// 本机文件未被 autoSync 改动——远端更新留待手动同步。
			const { readFile } = await import("node:fs/promises");
			expect(
				await readFile(
					join(environment.agentDir, "prompts/welcome.md"),
					"utf-8",
				),
			).toBe("base\n");
		});
	});

	it("returns no_update when repository is already up to date", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedRemote(
				fixture.deviceAPath,
				createPiSyncConfig({
					autoSync: { enabled: true, intervalMinutes: 30 },
				}),
				{ "prompts/welcome.md": "base\n" },
			);
			await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);
			await environment.writeAgentFile("prompts/welcome.md", "base\n");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"prompts/welcome.md": {
							sha256: sha256("base\n"),
							mode: 0o644,
						},
					},
				}),
			);

			const result = await new PiSyncCommands(environment.agentDir).autoSyncOnce(
				fixture.deviceBPath,
			);

			expect(result).toMatchObject({ status: "skipped", reason: "no_update" });
		});
	});
});
