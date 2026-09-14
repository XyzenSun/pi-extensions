import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiSyncCommands } from "../src/orchestration/commands.ts";
import { gitStatus } from "../src/system/git.ts";
import { loadState, saveState } from "../src/system/state.ts";
import { createSyncState } from "./helpers/factories.ts";
import { createGitFixture, runGit } from "./helpers/git-fixture.ts";
import { withTestEnvironment } from "./helpers/temp-env.ts";

const customConfig = {
	schemaVersion: 2,
	branch: "sync-config",
	root: "sync",
	include: ["prompts/**"],
	exclude: [],
	delete: "tracked",
} as const;

async function seedMainBranch(fixture: {
	deviceAPath: string;
	deviceBPath: string;
}): Promise<void> {
	const mainConfig = { ...customConfig, branch: "main" };
	await mkdir(join(fixture.deviceAPath, "sync/prompts"), { recursive: true });
	await writeFile(
		join(fixture.deviceAPath, "pi-sync.json"),
		JSON.stringify(mainConfig),
		"utf-8",
	);
	await writeFile(
		join(fixture.deviceAPath, "sync/prompts/main.md"),
		"main branch\n",
		"utf-8",
	);
	await runGit(fixture.deviceAPath, ["add", "."]);
	await runGit(fixture.deviceAPath, [
		"commit",
		"-m",
		"Create main sync configuration",
	]);
	await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
	await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);
}

async function seedCustomBranch(fixture: {
	deviceAPath: string;
	deviceBPath: string;
}): Promise<void> {
	await runGit(fixture.deviceAPath, ["switch", "-c", "sync-config"]);
	await mkdir(join(fixture.deviceAPath, "sync/prompts"), { recursive: true });
	await writeFile(
		join(fixture.deviceAPath, "pi-sync.json"),
		JSON.stringify(customConfig),
		"utf-8",
	);
	await writeFile(
		join(fixture.deviceAPath, "sync/prompts/custom.md"),
		"custom branch\n",
		"utf-8",
	);
	await runGit(fixture.deviceAPath, ["add", "."]);
	await runGit(fixture.deviceAPath, [
		"commit",
		"-m",
		"Create custom sync branch",
	]);
	await runGit(fixture.deviceAPath, [
		"push",
		"--set-upstream",
		"origin",
		"sync-config",
	]);

	// Keep the config visible on the clone's current main branch. The pull
	// command must then fetch and switch to the configured branch explicitly.
	await runGit(fixture.deviceAPath, ["switch", "main"]);
	await writeFile(
		join(fixture.deviceAPath, "pi-sync.json"),
		JSON.stringify(customConfig),
		"utf-8",
	);
	await runGit(fixture.deviceAPath, ["add", "pi-sync.json"]);
	await runGit(fixture.deviceAPath, [
		"commit",
		"-m",
		"Declare custom sync branch",
	]);
	await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
	await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);
}

describe.sequential("config.branch semantics", () => {
	it("switches a dirty device branch back to main and commits its changes", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedMainBranch(fixture);
			await runGit(fixture.deviceBPath, ["switch", "-c", "pisync-device/test"]);
			await writeFile(
				join(fixture.deviceBPath, ".gitkeep"),
				"dirty\n",
				"utf-8",
			);
			await saveState(
				environment.agentDir,
				createSyncState({ repoPath: fixture.deviceBPath }),
			);
			const progress: string[] = [];

			const result = await new PiSyncCommands(environment.agentDir).pull(
				fixture.deviceBPath,
				undefined,
				(_phase, message) => progress.push(message),
			);

			expect(result).toMatchObject({ ok: true, reload: true });
			expect((await gitStatus(fixture.deviceBPath)).branch).toBe("main");
			expect(
				(await runGit(fixture.deviceBPath, ["log", "-1", "--format=%s"]))
					.stdout,
			).toBe("pi-sync: pull 前保留仓库改动");
			const switchIndex = progress.indexOf("正在切换到 branch main……");
			const commitIndex = progress.findIndex((message) =>
				message.startsWith("正在执行：git commit"),
			);
			const fetchIndex = progress.findIndex((message) =>
				message.startsWith("正在执行：git fetch"),
			);
			expect(switchIndex).toBeGreaterThanOrEqual(0);
			expect(commitIndex).toBeGreaterThan(switchIndex);
			expect(fetchIndex).toBeGreaterThan(commitIndex);
		});
	});

	it("pulls and materializes from a configured non-main branch", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedCustomBranch(fixture);
			await saveState(
				environment.agentDir,
				createSyncState({ repoPath: fixture.deviceBPath }),
			);

			const result = await new PiSyncCommands(environment.agentDir).pull(
				fixture.deviceBPath,
			);

			expect(result).toMatchObject({ ok: true, reload: true });
			expect(
				await readFile(
					join(environment.agentDir, "prompts/custom.md"),
					"utf-8",
				),
			).toBe("custom branch\n");
			expect((await gitStatus(fixture.deviceBPath)).branch).toBe("sync-config");
			expect((await loadState(environment.agentDir)).branch).toBe(
				"sync-config",
			);
		});
	});

	it("switches branches before committing remaining local changes", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedCustomBranch(fixture);
			await writeFile(
				join(fixture.deviceBPath, ".gitkeep"),
				"dirty\n",
				"utf-8",
			);
			await saveState(
				environment.agentDir,
				createSyncState({ repoPath: fixture.deviceBPath }),
			);

			const result = await new PiSyncCommands(environment.agentDir).pull(
				fixture.deviceBPath,
			);

			expect(result).toMatchObject({ ok: true, reload: true });
			expect((await gitStatus(fixture.deviceBPath)).branch).toBe("sync-config");
			expect(
				(await runGit(fixture.deviceBPath, ["log", "-1", "--format=%s"]))
					.stdout,
			).toBe("pi-sync: pull 前保留仓库改动");
		});
	});

	it("reports an error only when committing repository changes fails", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedMainBranch(fixture);
			await writeFile(
				join(fixture.deviceBPath, ".gitkeep"),
				"dirty\n",
				"utf-8",
			);
			const preCommitHook = join(fixture.deviceBPath, ".git/hooks/pre-commit");
			await writeFile(preCommitHook, "#!/bin/sh\nexit 1\n", "utf-8");
			await chmod(preCommitHook, 0o755);
			await saveState(
				environment.agentDir,
				createSyncState({ repoPath: fixture.deviceBPath }),
			);

			const result = await new PiSyncCommands(environment.agentDir).pull(
				fixture.deviceBPath,
			);

			expect(result).toMatchObject({
				ok: false,
				code: "git_failed",
				reload: false,
			});
			expect(result.message).toContain(
				"pull 前无法提交仓库改动",
			);
		});
	});

	it("reports an error when Git cannot switch a dirty repository", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedCustomBranch(fixture);
			await mkdir(join(fixture.deviceBPath, "sync/prompts"), {
				recursive: true,
			});
			await writeFile(
				join(fixture.deviceBPath, "sync/prompts/custom.md"),
				"local untracked file\n",
				"utf-8",
			);
			await saveState(
				environment.agentDir,
				createSyncState({ repoPath: fixture.deviceBPath }),
			);

			const result = await new PiSyncCommands(environment.agentDir).pull(
				fixture.deviceBPath,
			);

			expect(result).toMatchObject({
				ok: false,
				code: "blocked_conflict",
				reload: false,
			});
			expect(result.message).toContain("would be overwritten");
			expect((await gitStatus(fixture.deviceBPath)).branch).toBe("main");
		});
	});
});
