import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiSyncCommands } from "../src/orchestration/commands.ts";
import { sha256 } from "../src/sync/inventory.ts";
import { loadState, saveState } from "../src/system/state.ts";
import { createSyncState } from "./helpers/factories.ts";
import {
	configureGitRepository,
	createGitFixture,
	runGit,
} from "./helpers/git-fixture.ts";
import { withTestEnvironment } from "./helpers/temp-env.ts";

const config = {
	schemaVersion: 2,
	branch: "main",
	root: "sync",
	include: ["prompts/**", "settings.json"],
	exclude: [],
	delete: "tracked",
} as const;

async function seedConfigRepo(repoPath: string): Promise<void> {
	await mkdir(join(repoPath, "sync/prompts"), { recursive: true });
	await writeFile(join(repoPath, "pi-sync.json"), JSON.stringify(config));
	await writeFile(join(repoPath, "sync/settings.json"), "{}\n");
	await writeFile(join(repoPath, "sync/prompts/welcome.md"), "baseline\n");
	await runGit(repoPath, ["add", "--all"]);
	await runGit(repoPath, [
		"commit",
		"--no-gpg-sign",
		"-m",
		"Initialize sync config",
	]);
	await runGit(repoPath, ["push", "--set-upstream", "origin", "main"]);
}

type RunResultLike = {
	ok: boolean;
	code?: string;
	message: string;
	mode: "setup" | "sync" | "recovery";
	phase: string;
	reload: boolean;
	details?: { needsGitUrl?: boolean };
};

function runOf(
	commands: PiSyncCommands,
	options?: unknown,
): Promise<RunResultLike> {
	return (
		commands as unknown as {
			run(options?: unknown): Promise<RunResultLike>;
		}
	).run(options);
}

const brokenLifecycleCases = [
	{
		name: "the configured repository is missing .git",
		prepare: async (_repoPath: string) => {},
	},
	{
		name: "the configured repository is missing pi-sync.json",
		prepare: async (repoPath: string) => {
			await mkdir(join(repoPath, ".git"), { recursive: true });
		},
	},
	{
		name: "the configured repository has invalid pi-sync.json",
		prepare: async (repoPath: string) => {
			await mkdir(join(repoPath, ".git"), { recursive: true });
			await writeFile(join(repoPath, "pi-sync.json"), "{}", "utf-8");
		},
	},
] as const;

describe("v0.3 unified command domain contract", () => {
	it("returns needsGitUrl without performing setup when uninitialized", async () => {
		await withTestEnvironment(async (environment) => {
			const result = await runOf(new PiSyncCommands(environment.agentDir));

			expect(result.ok).toBe(false);
			expect(result.mode).toBe("setup");
			expect(result.details?.needsGitUrl).toBe(true);
		});
	});

	it("builds a fingerprinted plan and rejects execution after the plan becomes stale", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			await environment.writeAgentFile("prompts/welcome.md", "baseline\n");
			await environment.writeAgentFile("settings.json", "{}\n");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceAPath,
					files: {
						"prompts/welcome.md": {
							sha256: sha256("baseline\n"),
							mode: 0o644,
						},
						"settings.json": { sha256: sha256("{}\n"), mode: 0o644 },
					},
				}),
			);
			const commands = new PiSyncCommands(environment.agentDir);
			const plan = await commands.plan();

			expect(plan).toMatchObject({ kind: "ready", changes: [] });
			if (plan.kind !== "ready") throw new Error("Expected ready plan");

			await environment.writeAgentFile("prompts/welcome.md", "changed\n");
			const result = await runOf(commands, {
				expectedPlanFingerprint: plan.fingerprint,
			});

			expect(result).toMatchObject({
				ok: false,
				code: "blocked_validation",
				phase: "preflight",
			});
			expect(
				await readFile(
					join(fixture.deviceAPath, "sync/prompts/welcome.md"),
					"utf-8",
				),
			).toBe("baseline\n");
		});
	});

	it("resumes an interrupted first setup from the default repository", async () => {
		await withTestEnvironment(async (environment) => {
			const remotePath = join(environment.rootDir, "empty-remote.git");
			const defaultPath = join(environment.agentDir, "..", "config-repo");
			await runGit(environment.rootDir, [
				"init",
				"--bare",
				"--initial-branch=main",
				remotePath,
			]);
			await runGit(environment.rootDir, ["clone", remotePath, defaultPath]);
			await configureGitRepository(defaultPath);

			// Simulate the point reported in #1: clone and scaffold exist, but the
			// operation timed out before repoPath was persisted to local state.
			await mkdir(join(defaultPath, "sync"), { recursive: true });
			await writeFile(
				join(defaultPath, "pi-sync.json"),
				JSON.stringify(config),
			);
			await writeFile(join(defaultPath, "sync/settings.json"), "{}\n");
			await environment.writeAgentFile(
				"settings.json",
				JSON.stringify({ packages: ["npm:@xyzensun/pi-sync"] }),
			);

			const progress: string[] = [];
			const result = await runOf(new PiSyncCommands(environment.agentDir), {
				onProgress: (_phase: string, message: string) => progress.push(message),
			});

			expect(result.ok).toBe(true);
			expect(result.mode).toBe("setup");
			expect(progress).toContain("正在继续被中断的初始化……");
			expect(result.message).not.toContain("Sync state is damaged");
			expect((await loadState(environment.agentDir)).repoPath).toBe(
				defaultPath,
			);
			expect(
				(await runGit(defaultPath, ["rev-list", "--count", "HEAD"])).stdout,
			).toBe("1");
		});
	});

	it("does not adopt a non-empty default repository without pi-sync.json", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			const defaultPath = join(environment.agentDir, "..", "config-repo");
			await runGit(environment.rootDir, [
				"clone",
				fixture.remotePath,
				defaultPath,
			]);

			const result = await runOf(new PiSyncCommands(environment.agentDir));

			expect(result).toMatchObject({
				ok: false,
				mode: "sync",
				phase: "preflight",
			});
			expect(result.message).toContain(
				"配置仓库已有提交，但缺少 pi-sync.json",
			);
		});
	});

	it("fails closed for a partially initialized repository", async () => {
		await withTestEnvironment(async (environment) => {
			await mkdir(join(environment.agentDir, ".pi-sync"), { recursive: true });
			await writeFile(
				join(environment.agentDir, ".pi-sync/state.json"),
				JSON.stringify(
					createSyncState({
						repoPath: join(environment.rootDir, "missing-repo"),
					}),
				),
			);

			const result = await runOf(new PiSyncCommands(environment.agentDir));

			expect(result.ok).toBe(false);
			expect(result.details).not.toMatchObject({ needsGitUrl: true });
		});
	});

	for (const testCase of brokenLifecycleCases) {
		it(`fails closed when ${testCase.name}`, async () => {
			await withTestEnvironment(async (environment) => {
				const repoPath = join(environment.rootDir, "damaged-repo");
				await mkdir(repoPath, { recursive: true });
				await testCase.prepare(repoPath);
				await saveState(environment.agentDir, createSyncState({ repoPath }));

				const result = await runOf(new PiSyncCommands(environment.agentDir));

				expect(result).toMatchObject({
					ok: false,
					mode: "sync",
					phase: "preflight",
					reload: false,
				});
			});
		});
	}

	it("fails closed when the top-level run lock is busy", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			await saveState(
				environment.agentDir,
				createSyncState({ repoPath: fixture.deviceAPath }),
			);
			const commands = new PiSyncCommands(environment.agentDir);
			(
				commands as unknown as {
					lock: { acquire: () => Promise<boolean> };
				}
			).lock = { acquire: async () => false };

			const result = await runOf(commands);

			expect(result).toMatchObject({
				ok: false,
				mode: "sync",
				phase: "preflight",
				reload: false,
			});
			expect(result.message).toContain("已有同步操作");
		});
	});

	it("fails closed when the standalone apply lock is busy", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			await saveState(
				environment.agentDir,
				createSyncState({ repoPath: fixture.deviceAPath }),
			);
			const commands = new PiSyncCommands(environment.agentDir);
			(
				commands as unknown as {
					lock: { acquire: () => Promise<boolean> };
				}
			).lock = { acquire: async () => false };

			const result = await commands.apply(fixture.deviceAPath);

			expect(result).toMatchObject({
				ok: false,
				code: "partial_failure",
				reload: false,
			});
			expect(result.message).toContain("已有同步操作");
		});
	});

	it("runs pull before push, including when pull has no file changes", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			const baseline = "baseline\n";
			await environment.writeAgentFile("prompts/welcome.md", baseline);
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceAPath,
					files: {
						"prompts/welcome.md": { sha256: sha256(baseline), mode: 0o644 },
					},
				}),
			);

			const phases: string[] = [];
			const result = await runOf(new PiSyncCommands(environment.agentDir), {
				onProgress: (phase: string) => phases.push(phase),
			});

			expect(result.ok).toBe(true);
			expect(phases.indexOf("pull")).toBeGreaterThanOrEqual(0);
			expect(phases.indexOf("push")).toBeGreaterThan(phases.indexOf("pull"));
		});
	});

	it("does not enter push after a fetch failure", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			await environment.writeAgentFile("prompts/welcome.md", "baseline\n");
			await saveState(
				environment.agentDir,
				createSyncState({ repoPath: fixture.deviceAPath }),
			);
			await runGit(fixture.deviceAPath, [
				"remote",
				"set-url",
				"origin",
				join(environment.rootDir, "missing-remote.git"),
			]);

			const phases: string[] = [];
			const result = await runOf(new PiSyncCommands(environment.agentDir), {
				onProgress: (phase: string) => phases.push(phase),
			});

			expect(result.ok).toBe(false);
			expect(phases).not.toContain("push");
		});
	});

	it.skipIf(process.platform === "win32")(
		"does not enter push after committing repository changes before pull fails",
		async () => {
			await withTestEnvironment(async (environment) => {
				const fixture = await createGitFixture(environment.rootDir);
				await seedConfigRepo(fixture.deviceAPath);
				await environment.writeAgentFile("prompts/welcome.md", "baseline\n");
				await saveState(
					environment.agentDir,
					createSyncState({ repoPath: fixture.deviceAPath }),
				);
				await writeFile(
					join(fixture.deviceAPath, "sync/prompts/welcome.md"),
					"repository edit\n",
				);
				const hookPath = join(fixture.deviceAPath, ".git/hooks/pre-commit");
				await writeFile(hookPath, "#!/bin/sh\nexit 1\n", "utf-8");
				await chmod(hookPath, 0o755);

				const phases: string[] = [];
				const result = await runOf(new PiSyncCommands(environment.agentDir), {
					onProgress: (phase: string) => phases.push(phase),
				});

				expect(result.ok).toBe(false);
				expect(result.message).toContain(
					"pull 前无法提交仓库改动",
				);
				expect(phases).not.toContain("push");
			});
		},
	);

	// 该用例用 chmod 0o500 制造"目录不可写"来触发 apply 失败回滚。
	// root 不受目录写权限位约束（CAP_DAC_OVERRIDE），写入会照常成功，
	// 断言必然不成立，因此在 root 下跳过——这是环境能力差异，不是行为差异。
	it.skipIf(
		process.platform === "win32" || process.getuid?.() === 0,
	)(
		"rolls back a partially written apply and retries safely through run",
		async () => {
			await withTestEnvironment(async (environment) => {
				const fixture = await createGitFixture(environment.rootDir);
				await seedConfigRepo(fixture.deviceAPath);
				await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
				await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);
				const initialSettings = JSON.stringify({
					packages: ["npm:@xyzensun/pi-sync"],
				});
				await environment.writeAgentFile("settings.json", initialSettings);
				await environment.writeAgentFile("prompts/welcome.md", "baseline\n");
				await saveState(
					environment.agentDir,
					createSyncState({
						repoPath: fixture.deviceBPath,
						files: {
							"settings.json": { sha256: sha256(initialSettings), mode: 0o644 },
							"prompts/welcome.md": {
								sha256: sha256("baseline\n"),
								mode: 0o644,
							},
						},
					}),
				);
				await writeFile(
					join(fixture.deviceAPath, "sync/prompts/welcome.md"),
					"remote update\n",
				);
				await mkdir(join(fixture.deviceAPath, "sync/prompts/z-blocked"), {
					recursive: true,
				});
				await writeFile(
					join(fixture.deviceAPath, "sync/prompts/z-blocked/new.md"),
					"new remote file\n",
				);
				await runGit(fixture.deviceAPath, ["add", "--all"]);
				await runGit(fixture.deviceAPath, [
					"commit",
					"--no-gpg-sign",
					"-m",
					"Remote apply update",
				]);
				await runGit(fixture.deviceAPath, ["push", "origin", "main"]);

				const blockedDir = join(environment.agentDir, "prompts/z-blocked");
				await mkdir(blockedDir, { recursive: true });
				await chmod(blockedDir, 0o500);
				try {
					const commands = new PiSyncCommands(environment.agentDir);
					const failed = await runOf(commands);

					expect(failed).toMatchObject({
						ok: false,
						mode: "sync",
						phase: "pull",
						reload: false,
					});
					expect(failed.message).toContain("已回滚到应用前的状态");
					expect(
						await readFile(
							join(environment.agentDir, "prompts/welcome.md"),
							"utf-8",
						),
					).toBe("baseline\n");

					await chmod(blockedDir, 0o700);
					const retried = await runOf(commands);

					expect(retried).toMatchObject({
						ok: true,
						mode: "sync",
						phase: "complete",
					});
					expect(
						await readFile(
							join(environment.agentDir, "prompts/welcome.md"),
							"utf-8",
						),
					).toBe("remote update\n");
				} finally {
					await chmod(blockedDir, 0o700);
				}
			});
		},
	);

	it("recovers a failed package apply through the normal run entry point", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
			await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);
			const initialSettings = JSON.stringify({
				packages: ["npm:@xyzensun/pi-sync"],
			});
			const updatedSettings = JSON.stringify({
				packages: ["npm:recovery-target@1.0.0"],
			});
			await environment.writeAgentFile("settings.json", initialSettings);
			await environment.writeAgentFile("prompts/welcome.md", "baseline\n");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"settings.json": { sha256: sha256(initialSettings), mode: 0o644 },
						"prompts/welcome.md": {
							sha256: sha256("baseline\n"),
							mode: 0o644,
						},
					},
				}),
			);
			await writeFile(
				join(fixture.deviceAPath, "sync/settings.json"),
				updatedSettings,
			);
			await runGit(fixture.deviceAPath, ["add", "sync/settings.json"]);
			await runGit(fixture.deviceAPath, [
				"commit",
				"--no-gpg-sign",
				"-m",
				"Remote package update",
			]);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);

			const failOncePath = join(environment.rootDir, "fail-package-once");
			await writeFile(failOncePath, "", "utf-8");
			await environment.writeExecutable(
				"pi",
				[
					"#!/bin/sh",
					'if [ "$1" = "--version" ]; then echo pi-test; exit 0; fi',
					'if [ "$1" = "install" ] && [ -f "$PI_TEST_FAIL_ONCE" ]; then rm "$PI_TEST_FAIL_ONCE"; exit 7; fi',
					"exit 0",
				].join("\n"),
			);
			process.env.PI_TEST_FAIL_ONCE = failOncePath;
			try {
				const commands = new PiSyncCommands(environment.agentDir);
				const first = await runOf(commands, {
					packageApproval: {
						approvedSources: ["npm:recovery-target@1.0.0"],
					},
				});
				expect(first).toMatchObject({
					ok: false,
					mode: "sync",
					phase: "pull",
					reload: false,
				});
				expect(
					(await loadState(environment.agentDir)).pendingOperation,
				).toMatchObject({
					type: "apply-failed",
				});

				const recovered = await runOf(commands, {
					packageApproval: {
						approvedSources: ["npm:recovery-target@1.0.0"],
					},
				});
				expect(recovered).toMatchObject({
					ok: true,
					mode: "sync",
					phase: "complete",
					reload: true,
				});
				expect(
					(await loadState(environment.agentDir)).pendingOperation,
				).toBeNull();
				expect(
					await readFile(join(environment.agentDir, "settings.json"), "utf-8"),
				).toBe(updatedSettings);
			} finally {
				delete process.env.PI_TEST_FAIL_ONCE;
			}
		});
	});

	it("pushes an ahead commit even when pull leaves no worktree changes", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			await environment.writeAgentFile("prompts/welcome.md", "baseline\n");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceAPath,
					files: {
						"prompts/welcome.md": { sha256: sha256("baseline\n"), mode: 0o644 },
					},
				}),
			);
			await writeFile(
				join(fixture.deviceAPath, "sync/prompts/welcome.md"),
				"ahead commit\n",
			);
			await runGit(fixture.deviceAPath, ["add", "--all"]);
			await runGit(fixture.deviceAPath, [
				"commit",
				"--no-gpg-sign",
				"-m",
				"Create ahead commit",
			]);
			const localHead = (
				await runGit(fixture.deviceAPath, ["rev-parse", "HEAD"])
			).stdout;

			const result = await runOf(new PiSyncCommands(environment.agentDir));
			const remoteHead = (
				await runGit(fixture.remotePath, ["rev-parse", "refs/heads/main"])
			).stdout;

			expect(result.ok).toBe(true);
			expect(remoteHead).toBe(localHead);
		});
	});

	it("aggregates reload when pull applies before a later phase", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			await environment.writeAgentFile("prompts/welcome.md", "baseline\n");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceAPath,
					files: {
						"prompts/welcome.md": { sha256: sha256("baseline\n"), mode: 0o644 },
					},
				}),
			);
			await runGit(fixture.deviceBPath, [
				"pull",
				"--ff-only",
				"origin",
				"main",
			]);
			await writeFile(
				join(fixture.deviceBPath, "sync/prompts/welcome.md"),
				"remote update\n",
			);
			await runGit(fixture.deviceBPath, ["add", "--all"]);
			await runGit(fixture.deviceBPath, [
				"commit",
				"--no-gpg-sign",
				"-m",
				"Remote update",
			]);
			await runGit(fixture.deviceBPath, ["push", "origin", "main"]);

			const result = await runOf(new PiSyncCommands(environment.agentDir));

			expect(result.reload).toBe(true);
		});
	});

	it("automatically considers a legacy push conflict pending operation", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			await environment.writeAgentFile("prompts/welcome.md", "baseline\n");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceAPath,
					pendingOperation: {
						type: "push-rebase-conflict",
						startedAt: new Date().toISOString(),
					},
				}),
			);

			const result = await runOf(new PiSyncCommands(environment.agentDir));

			expect(["recovery", "sync"]).toContain(result.mode);
		});
	});
});
