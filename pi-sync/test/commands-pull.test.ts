import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiSyncCommands } from "../src/orchestration/commands.ts";
import { getHeadCommit } from "../src/system/git.ts";
import { sha256 } from "../src/sync/inventory.ts";
import { settingsAdapter } from "../src/sync/settings-adapter.ts";
import { loadState, saveState } from "../src/system/state.ts";
import { createSyncState } from "./helpers/factories.ts";
import { createGitFixture, runGit } from "./helpers/git-fixture.ts";
import { withTestEnvironment } from "./helpers/temp-env.ts";

const config = {
	schemaVersion: 2,
	branch: "main",
	root: "sync",
	include: ["prompts/**"],
	exclude: [],
	delete: "tracked",
} as const;

async function seedConfigRepo(
	repoPath: string,
	configOverride: Record<string, unknown> = config,
): Promise<void> {
	await mkdir(join(repoPath, "sync/prompts"), { recursive: true });
	await writeFile(
		join(repoPath, "pi-sync.json"),
		JSON.stringify(configOverride),
		"utf-8",
	);
	await writeFile(join(repoPath, "sync/prompts/welcome.md"), "base\n", "utf-8");
	await runGit(repoPath, ["add", "pi-sync.json", "sync/prompts/welcome.md"]);
	await runGit(repoPath, ["commit", "-m", "Add sync configuration"]);
	await runGit(repoPath, ["push", "origin", "main"]);
}

describe.sequential("PiSyncCommands.pull", () => {
	it("captures and commits agent-only changes before pulling remote updates", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);
			await environment.writeAgentFile("prompts/welcome.md", "base\n");
			await environment.writeAgentFile("prompts/local.md", "local\n");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"prompts/welcome.md": { sha256: sha256("base\n"), mode: 0o644 },
					},
				}),
			);
			await writeFile(
				join(fixture.deviceAPath, "sync/prompts/welcome.md"),
				"remote\n",
				"utf-8",
			);
			await runGit(fixture.deviceAPath, ["add", "sync/prompts/welcome.md"]);
			await runGit(fixture.deviceAPath, ["commit", "-m", "Remote change"]);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);

			const result = await new PiSyncCommands(environment.agentDir).pull(
				fixture.deviceBPath,
			);
			const state = await loadState(environment.agentDir);

			expect(result.ok, result.message).toBe(true);
			expect(result.reload).toBe(true);
			expect(
				await readFile(
					join(fixture.deviceBPath, "sync/prompts/welcome.md"),
					"utf-8",
				),
			).toBe("remote\n");
			expect(
				await readFile(
					join(fixture.deviceBPath, "sync/prompts/local.md"),
					"utf-8",
				),
			).toBe("local\n");
			expect(
				await readFile(
					join(environment.agentDir, "prompts/welcome.md"),
					"utf-8",
				),
			).toBe("remote\n");
			expect(
				await readFile(join(environment.agentDir, "prompts/local.md"), "utf-8"),
			).toBe("local\n");
			expect(
				(
					await runGit(fixture.deviceBPath, [
						"log",
						"--format=%s",
						"origin/main..HEAD",
					])
				).stdout,
			).toContain("pi-sync: pull 前捕获本机改动");
			expect(state.files["prompts/local.md"]?.sha256).toBe(sha256("local\n"));
			expect(
				(await runGit(fixture.deviceBPath, ["status", "--porcelain"])).stdout,
			).toBe("");
		});
	});

	it.skipIf(process.platform === "win32")(
		"stops the whole fast-forward promptly after Git times out and remains usable",
		async () => {
			await withTestEnvironment(async (environment) => {
				const fixture = await createGitFixture(environment.rootDir);
				await seedConfigRepo(fixture.deviceAPath, {
					...config,
					pullTimeoutMs: 75,
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

				const realGit = execFileSync("which", ["git"], {
					encoding: "utf-8",
				}).trim();
				const fakeBin = join(environment.rootDir, "fake-bin");
				const fakeGit = join(fakeBin, "git");
				await mkdir(fakeBin, { recursive: true });
				await writeFile(
					fakeGit,
					`#!/bin/sh\nif [ "$1" = "merge" ]; then\n  sh -c 'sleep 30 & wait'\n  exit 0\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`,
					"utf-8",
				);
				await chmod(fakeGit, 0o755);

				const previousPath = process.env.PATH;
				process.env.PATH = `${fakeBin}${delimiter}${previousPath ?? ""}`;
				try {
					const commands = new PiSyncCommands(environment.agentDir);
					const startedAt = Date.now();
					const result = await commands.pull(fixture.deviceBPath);

					expect(Date.now() - startedAt).toBeLessThan(1_500);
					expect(result).toMatchObject({ ok: false, code: "git_failed" });
					expect(result.message).toContain("timed out after 75 ms");

					// A timed-out pull must release its lock and process handles so the
					// next command can run immediately in the same Pi session.
					await expect(commands.status(fixture.deviceBPath)).resolves.toContain(
						"=== pi-sync 状态 ===",
					);
				} finally {
					process.env.PATH = previousPath;
				}
			});
		},
	);

	it("fast-forwards and materializes a remote-only change before updating state", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);
			await environment.writeAgentFile("prompts/welcome.md", "base\n");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"prompts/welcome.md": { sha256: sha256("base\n"), mode: 0o644 },
					},
				}),
			);
			await writeFile(
				join(fixture.deviceAPath, "sync/prompts/welcome.md"),
				"remote\n",
				"utf-8",
			);
			await runGit(fixture.deviceAPath, ["add", "sync/prompts/welcome.md"]);
			await runGit(fixture.deviceAPath, ["commit", "-m", "Remote change"]);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);

			const progress: string[] = [];
			const result = await new PiSyncCommands(environment.agentDir).pull(
				fixture.deviceBPath,
				undefined,
				(_phase, message) => progress.push(message),
			);
			const state = await loadState(environment.agentDir);

			expect(result).toMatchObject({
				reload: true,
				message: expect.stringContaining("已写入文件：1"),
			});
			expect(progress).toEqual(
				expect.arrayContaining([
					"正在检查仓库状态……",
					"正在比较本机与远端的变更……",
					"正在执行：git fetch origin（超时：10s）……",
					"正在执行：git merge --ff-only origin/main（超时：10s）……",
					"正在应用拉取到的变更……",
				]),
			);
			expect(progress.some((message) => message.includes("git pull"))).toBe(
				false,
			);
			expect(
				await readFile(
					join(environment.agentDir, "prompts/welcome.md"),
					"utf-8",
				),
			).toBe("remote\n");
			expect(state.lastSyncedCommit).toBe(
				await getHeadCommit(fixture.deviceBPath),
			);
			expect(state.files["prompts/welcome.md"]?.sha256).toBe(
				sha256("remote\n"),
			);
		});
	});

	it("applies remote whitelist keys over local settings (packages 属白名单，随仓库同步)", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			// 白名单合并只对 special 中声明了 settings adapter 的文件生效；
			// 仅放在 include 的文件是字节直覆盖（design.md §0）。
			await seedConfigRepo(fixture.deviceAPath, {
				...config,
				include: ["settings.json"],
				special: { "settings.json": "settings" },
			});
			const oldRemoteSettings = `${JSON.stringify(
				{
					packages: ["npm:@xyzensun/pi-sync"],
					theme: "old",
				},
				null,
				2,
			)}\n`;
			await writeFile(
				join(fixture.deviceAPath, "sync/settings.json"),
				oldRemoteSettings,
				"utf-8",
			);
			await runGit(fixture.deviceAPath, ["add", "sync/settings.json"]);
			await runGit(fixture.deviceAPath, ["commit", "-m", "Add settings"]);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
			await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);

			await environment.writeAgentFile(
				"settings.json",
				`${JSON.stringify(
					{
						packages: ["npm:@xyzensun/pi-sync", "./local-extension"],
						theme: "old",
					},
					null,
					2,
				)}\n`,
			);
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"settings.json": {
							// Legacy states stored a raw-byte hash. Pull must migrate it
							// before fetching the next remote settings revision.
							sha256: sha256(oldRemoteSettings),
							mode: 0o644,
						},
					},
				}),
			);

			const newRemoteSettings = `${JSON.stringify(
				{
					packages: ["npm:@xyzensun/pi-sync"],
					theme: "new",
				},
				null,
				2,
			)}\n`;
			await writeFile(
				join(fixture.deviceAPath, "sync/settings.json"),
				newRemoteSettings,
				"utf-8",
			);
			await runGit(fixture.deviceAPath, ["add", "sync/settings.json"]);
			await runGit(fixture.deviceAPath, ["commit", "-m", "Update settings"]);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);

			const startedAt = Date.now();
			const result = await new PiSyncCommands(environment.agentDir).pull(
				fixture.deviceBPath,
			);
			const applied = JSON.parse(
				await readFile(join(environment.agentDir, "settings.json"), "utf-8"),
			) as { packages: string[]; theme: string };
			const state = await loadState(environment.agentDir);

			expect(result.ok, result.message).toBe(true);
			expect(Date.now() - startedAt).toBeLessThan(10_000);
			expect(applied.theme).toBe("new");
			// 本机非便携包源（./local-extension）在 pull 后回填保留，不丢本地开发插件
			expect(applied.packages).toEqual([
				"npm:@xyzensun/pi-sync",
				"./local-extension",
			]);
			expect(state.files["settings.json"]?.sha256).toBe(
				sha256(
					await settingsAdapter.normalizeForComparison!(
						Buffer.from(newRemoteSettings),
						{
							agentDir: environment.agentDir,
							repoPath: fixture.deviceBPath,
							filePath: "settings.json",
						},
					),
				),
			);
		});
	});

	// P2（design.md §5）：pull 遇双向冲突时默认远端优先——本机未推送漂移被丢弃，
	// 远端版本直接覆盖，不再创建设备分支或等待用户手动。
	it("adopts remote and discards local un-pushed changes on a bidirectional conflict", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
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

			// 远端修改同一文件并推送
			await writeFile(
				join(fixture.deviceAPath, "sync/prompts/welcome.md"),
				"remote\n",
				"utf-8",
			);
			await runGit(fixture.deviceAPath, ["add", "sync/prompts/welcome.md"]);
			await runGit(fixture.deviceAPath, ["commit", "-m", "Remote change"]);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);

			// 本机在远端推送后也修改同一文件（未推送漂移）
			await environment.writeAgentFile("prompts/welcome.md", "local drift\n");

			const result = await new PiSyncCommands(environment.agentDir).pull(
				fixture.deviceBPath,
			);
			const state = await loadState(environment.agentDir);

			expect(result.ok, result.message).toBe(true);
			expect(result.code).toBe("ok");
			expect(result.reload).toBe(true);
			// 远端版本胜出，本机未推送漂移被丢弃
			expect(
				await readFile(
					join(environment.agentDir, "prompts/welcome.md"),
					"utf-8",
				),
			).toBe("remote\n");
			expect(state.files["prompts/welcome.md"]?.sha256).toBe(
				sha256("remote\n"),
			);
		});
	});
});
