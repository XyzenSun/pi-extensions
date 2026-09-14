import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiSyncCommands } from "../../src/orchestration/commands.ts";
import { sha256 } from "../../src/sync/inventory.ts";
import { settingsAdapter } from "../../src/sync/settings-adapter.ts";
import { saveState } from "../../src/system/state.ts";
import { createSyncState } from "../helpers/factories.ts";
import {
	configureGitRepository,
	createGitFixture,
	runGit,
} from "../helpers/git-fixture.ts";
import { withTestEnvironment } from "../helpers/temp-env.ts";

const config = {
	schemaVersion: 2,
	branch: "main",
	root: "sync",
	include: ["prompts/**", "settings.json", "themes/**", "extensions/**"],
	exclude: [],
	delete: "tracked",
} as const;

async function seedAndPush(
	repoPath: string,
	initialFiles: Record<string, string>,
): Promise<void> {
	await mkdir(join(repoPath, "sync/prompts"), { recursive: true });
	await mkdir(join(repoPath, "sync/themes"), { recursive: true });
	await mkdir(join(repoPath, "sync/extensions"), { recursive: true });
	await writeFile(
		join(repoPath, "pi-sync.json"),
		JSON.stringify(config),
		"utf-8",
	);
	await writeFile(
		join(repoPath, "sync/settings.json"),
		JSON.stringify({ packages: ["npm:@xyzensun/pi-sync"] }),
		"utf-8",
	);
	for (const [path, content] of Object.entries(initialFiles)) {
		await writeFile(join(repoPath, "sync", path), content, "utf-8");
	}
	await runGit(repoPath, ["add", "--all"]);
	await runGit(repoPath, [
		"commit",
		"--no-gpg-sign",
		"-m",
		"Initialize sync config",
	]);
	await runGit(repoPath, ["push", "--set-upstream", "origin", "main"]);
}

describe.sequential("Two-device sync E2E", () => {
	it("full round-trip: A pushes, B pulls, A modifies, B pulls again", async () => {
		await withTestEnvironment(async (envA) => {
			const fixture = await createGitFixture(envA.rootDir);

			// === Step 1: Device A initializes with baseline content ===
			const baselineContent = "hello from device A\n";
			await seedAndPush(fixture.deviceAPath, {
				"prompts/welcome.md": baselineContent,
			});

			// Setup A's agent state to match the repo
			await envA.writeAgentFile("prompts/welcome.md", baselineContent);
			await saveState(
				envA.agentDir,
				createSyncState({
					repoPath: fixture.deviceAPath,
					files: {
						"prompts/welcome.md": {
							sha256: sha256(baselineContent),
							mode: 0o644,
						},
					},
				}),
			);

			// === Step 2: A modifies and pushes ===
			await envA.writeAgentFile(
				"prompts/welcome.md",
				"hello from device A — updated\n",
			);
			await envA.writeAgentFile(
				"themes/custom.json",
				JSON.stringify({ name: "custom" }),
			);

			const aCmds = new PiSyncCommands(envA.agentDir);
			const pushResult = await aCmds.run();
			expect(pushResult.reload).toBe(true);
			expect(pushResult.message).toContain("同步完成");

			// === Step 3: Device B clones and applies ===
			const { createTestEnvironment: createEnv } = await import(
				"../helpers/temp-env.ts"
			);
			const envB = await createEnv("pi-git-sync-b-");

			try {
				// Clone the remote (B's repo)
				await runGit(envA.rootDir, ["clone", fixture.remotePath, envB.repoDir]);
				await configureGitRepository(envB.repoDir);

				// Set B's baseline to the original (before A's push)
				await envB.writeAgentFile("prompts/welcome.md", baselineContent);
				await saveState(
					envB.agentDir,
					createSyncState({
						repoPath: envB.repoDir,
						files: {
							"prompts/welcome.md": {
								sha256: sha256(baselineContent),
								mode: 0o644,
							},
						},
					}),
				);

				const bCmds = new PiSyncCommands(envB.agentDir);

				// B uses the unified command: pull first, then push.
				const pullResult = await bCmds.run();
				expect(pullResult.ok).toBe(true);
				expect(pullResult.reload).toBe(true);
				expect(pullResult.message).toContain("Pull：");

				// Verify B has the updated content
				const bWelcome = await readFile(
					join(envB.agentDir, "prompts/welcome.md"),
					"utf-8",
				);
				expect(bWelcome).toBe("hello from device A — updated\n");

				const bTheme = await readFile(
					join(envB.agentDir, "themes/custom.json"),
					"utf-8",
				);
				expect(JSON.parse(bTheme)).toEqual({ name: "custom" });

				// A repeated unified run is idempotent.
				const syncAgain = await bCmds.run();
				expect(syncAgain.ok).toBe(true);
				expect(syncAgain.code).toBe("noop");
			} finally {
				await envB.cleanup();
			}
		});
	});

	it("bilateral conflict: B syncs, pull adopts remote (P2 远端优先)", async () => {
		await withTestEnvironment(async (envA) => {
			const fixture = await createGitFixture(envA.rootDir);

			// Setup shared baseline in the remote
			const baselineContent = "baseline\n";
			await seedAndPush(fixture.deviceAPath, {
				"prompts/welcome.md": baselineContent,
			});

			// Setup A with baseline state
			await envA.writeAgentFile("prompts/welcome.md", baselineContent);
			await saveState(
				envA.agentDir,
				createSyncState({
					repoPath: fixture.deviceAPath,
					files: {
						"prompts/welcome.md": {
							sha256: sha256(baselineContent),
							mode: 0o644,
						},
					},
				}),
			);

			// Setup B with its own clone and baseline
			const { createTestEnvironment: createEnv } = await import(
				"../helpers/temp-env.ts"
			);
			const envB = await createEnv("pi-git-sync-b-");
			try {
				await runGit(envA.rootDir, ["clone", fixture.remotePath, envB.repoDir]);
				await configureGitRepository(envB.repoDir);
				await envB.writeAgentFile("prompts/welcome.md", baselineContent);
				await saveState(
					envB.agentDir,
					createSyncState({
						repoPath: envB.repoDir,
						files: {
							"prompts/welcome.md": {
								sha256: sha256(baselineContent),
								mode: 0o644,
							},
						},
					}),
				);

				// A changes and pushes first
				await envA.writeAgentFile("prompts/welcome.md", "change from A\n");
				const aCmds = new PiSyncCommands(envA.agentDir);
				const pushA = await aCmds.run();
				expect(pushA.reload).toBe(true);
				expect(pushA.ok).toBe(true);

				// B also changes and synchronizes — P2: pull adopts remote without blocking.
				await envB.writeAgentFile("prompts/welcome.md", "change from B\n");
				const bCmds = new PiSyncCommands(envB.agentDir);
				const syncB = await bCmds.run();

				// P2: sync succeeds; B's local un-pushed change is discarded and the
				// remote version (A's) wins.
				expect(syncB.ok, syncB.message).toBe(true);
				expect(syncB.code).toBe("ok");
				expect(
					await readFile(join(envB.agentDir, "prompts/welcome.md"), "utf-8"),
				).toBe("change from A\n");
				// 远端优先落地后基线已收口，重跑应无事可做。
				expect((await bCmds.run()).code).toBe("noop");
			} finally {
				await envB.cleanup();
			}
		});
	});

	// EXECUTION-PROMPT §4 双机验证：settings 白名单跨机同步 + models.json 全量 +
	// 无 deny 时 auth.json 可被 include（用户显式配置即放行）。
	it("settings whitelist + models full sync + auth include", async () => {
		await withTestEnvironment(async (envA) => {
			const fixture = await createGitFixture(envA.rootDir);
			const wideConfig = {
				schemaVersion: 2,
				branch: "main",
				root: "sync",
				include: ["settings.json", "models.json", "auth.json", "prompts/**"],
				exclude: [],
				delete: "tracked",
				special: { "settings.json": "settings" },
			};
			const baselineSettings = JSON.stringify(
				{
					theme: "default",
					packages: ["npm:@xyzensun/pi-sync"],
					trackingId: "device-A-tracking",
					lastChangelogVersion: 9,
				},
				null,
				2,
			);
			const baselineModels = JSON.stringify(
				{ enabledModels: [{ id: "m1", apiKey: "sk-a" }] },
				null,
				2,
			);

			// 种子远端（device-a 仓库，sync/ 镜像内含 settings/models）
			await mkdir(join(fixture.deviceAPath, "sync/prompts"), {
				recursive: true,
			});
			await writeFile(
				join(fixture.deviceAPath, "pi-sync.json"),
				JSON.stringify(wideConfig),
				"utf-8",
			);
			await writeFile(
				join(fixture.deviceAPath, "sync/settings.json"),
				baselineSettings,
				"utf-8",
			);
			await writeFile(
				join(fixture.deviceAPath, "sync/models.json"),
				baselineModels,
				"utf-8",
			);
			await writeFile(
				join(fixture.deviceAPath, "sync/prompts/welcome.md"),
				"base\n",
				"utf-8",
			);
			await runGit(fixture.deviceAPath, ["add", "--all"]);
			await runGit(fixture.deviceAPath, ["commit", "-m", "seed wide config"]);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);

			// 设备 A 基线：settings/models 与仓库一致（含设备键 trackingId 等）
			await envA.writeAgentFile("settings.json", baselineSettings);
			await envA.writeAgentFile("models.json", baselineModels);
			await saveState(
				envA.agentDir,
				createSyncState({
					repoPath: fixture.deviceAPath,
					files: {
						"settings.json": { sha256: sha256(baselineSettings), mode: 0o644 },
						"models.json": { sha256: sha256(baselineModels), mode: 0o644 },
						"prompts/welcome.md": { sha256: sha256("base\n"), mode: 0o644 },
					},
				}),
			);

			// A 修改白名单字段 + models + 新增 auth.json，push 到远端
			const aSettingsV2 = JSON.stringify(
				{
					theme: "dark",
					packages: ["npm:@xyzensun/pi-sync"],
					trackingId: "device-A-tracking",
					lastChangelogVersion: 9,
				},
				null,
				2,
			);
			const aModelsV2 = JSON.stringify(
				{
					enabledModels: [
						{ id: "m1", apiKey: "sk-a" },
						{ id: "m2", apiKey: "sk-b" },
					],
				},
				null,
				2,
			);
			await envA.writeAgentFile("settings.json", aSettingsV2);
			await envA.writeAgentFile("models.json", aModelsV2);
			await envA.writeAgentFile("auth.json", JSON.stringify({ token: "ghp_secret" }, null, 2));
			const pushA = await new PiSyncCommands(envA.agentDir).run();
			expect(pushA.ok, pushA.message).toBe(true);

			// 设备 B：独立 agent 环境，clone 远端后 pull 同步
			const { createTestEnvironment: createEnv } = await import(
				"../helpers/temp-env.ts"
			);
			const envB = await createEnv("pi-git-sync-wide-e2e-");
			try {
				await runGit(envA.rootDir, ["clone", fixture.remotePath, envB.repoDir]);
				await configureGitRepository(envB.repoDir);
				// B 本机设备键与 A 不同（trackingId=device-B）——pull 后应保留本机值
				const bLocalSettings = JSON.stringify(
					{
						theme: "default",
						packages: ["npm:@xyzensun/pi-sync"],
						trackingId: "device-B-tracking",
						lastChangelogVersion: 3,
					},
					null,
					2,
				);
				await envB.writeAgentFile("settings.json", bLocalSettings);
				await envB.writeAgentFile("models.json", baselineModels);
				await envB.writeAgentFile("prompts/welcome.md", "base\n");
				await saveState(
					envB.agentDir,
					createSyncState({
						repoPath: envB.repoDir,
						files: {
							"settings.json": {
								sha256: sha256(
									await settingsAdapter.normalizeForComparison!(
										Buffer.from(bLocalSettings),
										{ agentDir: envB.agentDir, repoPath: envB.repoDir, filePath: "settings.json" },
									),
								),
								mode: 0o644,
							},
							"models.json": { sha256: sha256(baselineModels), mode: 0o644 },
							"prompts/welcome.md": { sha256: sha256("base\n"), mode: 0o644 },
						},
					}),
				);

				const bCmds = new PiSyncCommands(envB.agentDir);
				const pullB = await bCmds.run();
				expect(pullB.ok, pullB.message).toBe(true);

				// settings：白名单字段（theme）同步为远端 dark，设备键 trackingId 保留 B 本机值
				const appliedSettings = JSON.parse(
					await readFile(join(envB.agentDir, "settings.json"), "utf-8"),
				) as Record<string, unknown>;
				expect(appliedSettings.theme).toBe("dark");
				expect(appliedSettings.trackingId).toBe("device-B-tracking");
				expect(appliedSettings.lastChangelogVersion).toBe(3);

				// models.json 全量同步（含 2 个 provider）
				const appliedModels = JSON.parse(
					await readFile(join(envB.agentDir, "models.json"), "utf-8"),
				) as { enabledModels: unknown[] };
				expect(appliedModels.enabledModels).toHaveLength(2);

				// auth.json 随 include 同步（无 deny 兜底，用户显式 include 即放行）
				expect(
					await readFile(join(envB.agentDir, "auth.json"), "utf-8"),
				).toContain("ghp_secret");
			} finally {
				await envB.cleanup();
			}
		});
	});
});
