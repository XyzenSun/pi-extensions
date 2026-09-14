import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
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

async function seedRemote(repoPath: string): Promise<void> {
	await configureGitRepository(repoPath);
	await mkdir(join(repoPath, "sync/prompts"), { recursive: true });
	await writeFile(join(repoPath, "pi-sync.json"), JSON.stringify(config));
	await writeFile(join(repoPath, "sync/prompts/shared.md"), "base\n");
	await writeFile(
		join(repoPath, "sync/settings.json"),
		JSON.stringify({ packages: [] }),
	);
	await runGit(repoPath, ["add", "--all"]);
	await runGit(repoPath, ["commit", "--no-gpg-sign", "-m", "Seed"]);
	await runGit(repoPath, ["push", "--set-upstream", "origin", "main"]);
}

/**
 * 建立"A 机已推送新内容，B 机本地另有改动"的双机分歧。
 * B 机即被测设备。
 */
async function seedDivergedDevices(
	environment: Parameters<Parameters<typeof withTestEnvironment>[0]>[0],
): Promise<{ deviceB: string; deviceA: string }> {
	const fixture = await createGitFixture(environment.rootDir);
	await seedRemote(fixture.deviceAPath);
	await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);

	const settings = JSON.stringify({ packages: [] });
	await environment.writeAgentFile("prompts/shared.md", "base\n");
	await environment.writeAgentFile("settings.json", settings);
	await saveState(
		environment.agentDir,
		createSyncState({
			repoPath: fixture.deviceBPath,
			files: {
				"prompts/shared.md": { sha256: sha256("base\n"), mode: 0o644 },
				"settings.json": { sha256: sha256(settings), mode: 0o644 },
			},
		}),
	);

	// A 机改了同一个文件并新增一个文件，推送。
	await writeFile(
		join(fixture.deviceAPath, "sync/prompts/shared.md"),
		"from A\n",
	);
	await writeFile(
		join(fixture.deviceAPath, "sync/prompts/from-a.md"),
		"A only\n",
	);
	await runGit(fixture.deviceAPath, ["add", "--all"]);
	await runGit(fixture.deviceAPath, ["commit", "--no-gpg-sign", "-m", "A work"]);
	await runGit(fixture.deviceAPath, ["push", "origin", "main"]);

	// B 机本地也改了同一个文件，另有一个本机独有文件。
	await environment.writeAgentFile("prompts/shared.md", "from B\n");
	await environment.writeAgentFile("prompts/from-b.md", "B only\n");

	return { deviceB: fixture.deviceBPath, deviceA: fixture.deviceAPath };
}

describe.sequential("whole-machine alignment commands (tui-prd 4.2)", () => {
	it("previews exactly what each direction would discard", async () => {
		await withTestEnvironment(async (environment) => {
			const { deviceB } = await seedDivergedDevices(environment);
			const commands = new PiSyncCommands(environment.agentDir);

			// 以远端覆盖本机 → 丢本机侧：本机独有 + 双边冲突。
			const losingOnPull = await commands.previewOverwrite("pull", deviceB);
			expect(losingOnPull).toContain("prompts/from-b.md");
			expect(losingOnPull).toContain("prompts/shared.md");

			// 以本机覆盖远端 → 丢仓库侧。预览会先 fetch，所以 A 机推上去的
			// 新文件也要出现在清单里——破坏性操作的清单漏报比慢一点严重得多。
			const losingOnPush = await commands.previewOverwrite("push", deviceB);
			expect(losingOnPush).toContain("prompts/shared.md");
			expect(losingOnPush).toContain("prompts/from-a.md");
			// 本机独有的文件不会因为推送而丢失。
			expect(losingOnPush).not.toContain("prompts/from-b.md");
		});
	});

	it("returns an empty preview when the repository is not initialized", async () => {
		await withTestEnvironment(async (environment) => {
			await expect(
				new PiSyncCommands(environment.agentDir).previewOverwrite("pull"),
			).resolves.toEqual([]);
		});
	});

	it("overwriteFromRemote makes the local side an exact replica of the remote", async () => {
		await withTestEnvironment(async (environment) => {
			const { deviceB } = await seedDivergedDevices(environment);
			const commands = new PiSyncCommands(environment.agentDir);

			const result = await commands.overwriteFromRemote();
			expect(result.ok, result.message).toBe(true);

			// 本机改动被丢弃，取远端内容。
			expect(
				await readFile(
					join(environment.agentDir, "prompts/shared.md"),
					"utf-8",
				),
			).toBe("from A\n");
			// 远端新增落到本机。
			expect(
				await readFile(join(environment.agentDir, "prompts/from-a.md"), "utf-8"),
			).toBe("A only\n");
			// 本机独有的文件被删除——这是整机对齐与智能化拉取的关键差别。
			expect(existsSync(join(environment.agentDir, "prompts/from-b.md"))).toBe(
				false,
			);

			// 基线收口为远端的样子，重跑应无事可做。
			const state = await loadState(environment.agentDir);
			expect(Object.keys(state.files)).not.toContain("prompts/from-b.md");
			expect(state.files["prompts/from-a.md"]).toBeDefined();
			expect(await commands.previewOverwrite("pull", deviceB)).toEqual([]);
		});
	});

	it("overwriteFromLocal makes the remote an exact replica of the local side", async () => {
		await withTestEnvironment(async (environment) => {
			const { deviceB, deviceA } = await seedDivergedDevices(environment);
			const commands = new PiSyncCommands(environment.agentDir);

			const result = await commands.overwriteFromLocal();
			expect(result.ok, result.message).toBe(true);

			// 远端主分支变成本机的样子。
			await runGit(deviceA, ["fetch", "origin"]);
			const remoteShared = await runGit(deviceA, [
				"show",
				"origin/main:sync/prompts/shared.md",
			]);
			expect(remoteShared.stdout).toBe("from B");
			const remoteFromB = await runGit(deviceA, [
				"show",
				"origin/main:sync/prompts/from-b.md",
			]);
			expect(remoteFromB.stdout).toBe("B only");

			// A 机独有的文件从远端被删除。
			const listing = await runGit(deviceA, [
				"ls-tree",
				"--name-only",
				"origin/main:sync/prompts",
			]);
			expect(listing.stdout).not.toContain("from-a.md");

			// 本机文件保持原样——推送方向不该改写本机内容。
			expect(
				await readFile(
					join(environment.agentDir, "prompts/shared.md"),
					"utf-8",
				),
			).toBe("from B\n");
			expect(existsSync(join(deviceB, "sync/prompts/from-a.md"))).toBe(false);
		});
	});

	it("both directions are idempotent", async () => {
		await withTestEnvironment(async (environment) => {
			await seedDivergedDevices(environment);
			const commands = new PiSyncCommands(environment.agentDir);

			expect((await commands.overwriteFromRemote()).ok).toBe(true);
			const second = await commands.overwriteFromRemote();
			expect(second.ok, second.message).toBe(true);
		});
	});

	it("refuses to run before initialization instead of throwing", async () => {
		await withTestEnvironment(async (environment) => {
			const commands = new PiSyncCommands(environment.agentDir);

			const pull = await commands.overwriteFromRemote();
			expect(pull.ok).toBe(false);
			expect(pull.message).toContain("/pisync");

			const push = await commands.overwriteFromLocal();
			expect(push.ok).toBe(false);
			expect(push.message).toContain("/pisync");
		});
	});

	it("leaves files outside the include whitelist untouched", async () => {
		await withTestEnvironment(async (environment) => {
			await seedDivergedDevices(environment);
			await environment.writeAgentFile("notes/private.md", "not synced\n");

			const result = await new PiSyncCommands(
				environment.agentDir,
			).overwriteFromRemote();
			expect(result.ok, result.message).toBe(true);

			// 白名单外的文件不参与同步，整机对齐也不该动它。
			expect(
				await readFile(join(environment.agentDir, "notes/private.md"), "utf-8"),
			).toBe("not synced\n");
		});
	});
});