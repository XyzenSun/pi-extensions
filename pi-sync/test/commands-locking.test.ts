import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	PiSyncCommands,
	type PushPreparation,
} from "../src/orchestration/commands.ts";
import { saveState } from "../src/system/state.ts";
import { createSyncState } from "./helpers/factories.ts";
import { withTestEnvironment } from "./helpers/temp-env.ts";

const config = {
	schemaVersion: 2,
	branch: "main",
	root: "sync",
	include: ["prompts/**"],
	exclude: [],
	delete: "tracked",
} as const;

async function writeConfig(repoPath: string): Promise<void> {
	await mkdir(join(repoPath, "sync/prompts"), { recursive: true });
	await writeFile(join(repoPath, "pi-sync.json"), JSON.stringify(config));
}

function blockLock(commands: PiSyncCommands): void {
	(
		commands as unknown as {
			lock: { acquire: () => Promise<boolean> };
		}
	).lock = { acquire: async () => false };
}

function readyPreparation(repoPath: string): PushPreparation {
	return {
		kind: "ready",
		capture: {
			captured: [],
			deleted: [],
			errors: [],
			hasConflicts: false,
			conflicts: [],
		},
		changedFiles: [],
		diff: "",
		repoHead: "head",
		worktreeFingerprint: "fingerprint",
		repoPath,
		branch: config.branch,
	};
}

describe.sequential("PiSyncCommands façade lock boundaries", () => {
	it("returns the configured repository for conflict handoffs", async () => {
		await withTestEnvironment(async (environment) => {
			await saveState(
				environment.agentDir,
				createSyncState({ repoPath: environment.repoDir }),
			);

			await expect(
				new PiSyncCommands(environment.agentDir).getConflictRepoPath(),
			).resolves.toBe(environment.repoDir);
		});
	});

	it("returns a busy result before entering the pull flow", async () => {
		await withTestEnvironment(async (environment) => {
			await writeConfig(environment.repoDir);
			const commands = new PiSyncCommands(environment.agentDir);
			blockLock(commands);

			await expect(commands.pull(environment.repoDir)).resolves.toMatchObject({
				ok: false,
				code: "partial_failure",
				message: "已有同步操作正在进行。",
				reload: false,
			});
		});
	});

	it("returns a blocked preparation before entering the push preparation flow", async () => {
		await withTestEnvironment(async (environment) => {
			await writeConfig(environment.repoDir);
			const commands = new PiSyncCommands(environment.agentDir);
			blockLock(commands);

			await expect(
				commands.preparePush(environment.repoDir),
			).resolves.toMatchObject({
				kind: "blocked",
				repoPath: environment.repoDir,
				branch: config.branch,
				message: "已有同步操作正在进行。",
			});
		});
	});

	it("returns a busy result before executing a prepared push", async () => {
		await withTestEnvironment(async (environment) => {
			await writeConfig(environment.repoDir);
			const commands = new PiSyncCommands(environment.agentDir);
			blockLock(commands);

			await expect(
				commands.executePush(readyPreparation(environment.repoDir)),
			).resolves.toMatchObject({
				ok: false,
				code: "partial_failure",
				message: "已有同步操作正在进行。",
				reload: false,
			});
		});
	});
});
