import { createHash } from "node:crypto";
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
	computeBaselineEntry,
	getBaselineFile,
	getStatePath,
	loadState,
	saveState,
	updateState,
} from "../src/system/state.ts";
import { createSyncState } from "./helpers/factories.ts";
import { withTestEnvironment } from "./helpers/temp-env.ts";

describe.sequential("sync state persistence", () => {
	it("uses an empty safe state when no state file exists", async () => {
		await withTestEnvironment(async ({ agentDir }) => {
			expect(getStatePath(agentDir)).toBe(`${agentDir}/.pi-sync/state.json`);
			await expect(loadState(agentDir)).resolves.toMatchObject({
				schemaVersion: 3,
				repoPath: "",
				branch: "main",
				files: {},
				pendingOperation: null,
			});
		});
	});

	it("atomically round-trips state without leaving temporary files", async () => {
		await withTestEnvironment(async ({ agentDir }) => {
			const state = createSyncState({
				repoPath: "/tmp/config-repo",
				lastSyncedCommit: "a".repeat(40),
				files: { "settings.json": computeBaselineEntry("hash", 0o600) },
			});
			await saveState(agentDir, state);

			expect(await loadState(agentDir)).toEqual(state);
			expect(await readdir(`${agentDir}/.pi-sync`)).toEqual(["state.json"]);
		});
	});

	it("relocates local state into the ignored config-repo directory", async () => {
		await withTestEnvironment(async ({ agentDir, repoDir }) => {
			await mkdir(`${repoDir}/.git/info`, { recursive: true });
			const state = createSyncState({ repoPath: repoDir });

			await saveState(agentDir, state);

			expect((await lstat(`${agentDir}/.pi-sync`)).isSymbolicLink()).toBe(true);
			expect(await loadState(agentDir)).toEqual(state);
			expect(
				await readFile(`${repoDir}/.pi-sync/state.json`, "utf-8"),
			).toContain(repoDir);
			expect(await readFile(`${repoDir}/.git/info/exclude`, "utf-8")).toContain(
				".pi-sync/",
			);
		});
	});

	it("recreates the state target when init --force leaves a dangling link", async () => {
		await withTestEnvironment(async ({ agentDir, repoDir }) => {
			await mkdir(`${repoDir}/.git/info`, { recursive: true });
			const state = createSyncState({ repoPath: repoDir });
			await saveState(agentDir, state);

			await rm(repoDir, { recursive: true, force: true });
			await mkdir(`${repoDir}/.git/info`, { recursive: true });
			await saveState(agentDir, state);

			expect((await lstat(`${agentDir}/.pi-sync`)).isSymbolicLink()).toBe(true);
			expect(await loadState(agentDir)).toEqual(state);
			await expect(
				readFile(`${repoDir}/.pi-sync/state.json`, "utf-8"),
			).resolves.toContain(repoDir);
		});
	});

	it("merges updates without losing an existing baseline", async () => {
		await withTestEnvironment(async ({ agentDir }) => {
			const initial = createSyncState({
				files: { "themes/dark.json": computeBaselineEntry("theme", 0o644) },
				lastSyncedCommit: "a".repeat(40),
			});
			await saveState(agentDir, initial);

			const updated = await updateState(agentDir, {
				pendingOperation: {
					type: "push-rebase-conflict",
					startedAt: "2026-01-01T00:00:00.000Z",
				},
				lastBackup: "2026-01-01T00:00:00.000Z",
			});

			expect(updated.files).toEqual(initial.files);
			expect(updated.lastSyncedCommit).toBe(initial.lastSyncedCommit);
			expect(updated.pendingOperation?.type).toBe("push-rebase-conflict");
			expect(getBaselineFile(updated, "themes/dark.json")).toEqual({
				sha256: "theme",
				mode: 0o644,
			});
			expect(getBaselineFile(updated, "missing.txt")).toBeNull();
		});
	});

	it("migrates schema v2 and reconciles an equal local/repo baseline", async () => {
		await withTestEnvironment(
			async ({ agentDir, repoDir, writeAgentFile, writeRepoFile }) => {
				const content = "same content";
				const hash = createHash("sha256").update(content).digest("hex");
				await writeAgentFile("settings.json", content);
				await writeRepoFile("pi-sync.json", JSON.stringify({ root: "sync" }));
				await writeRepoFile("sync/settings.json", content);
				await mkdir(`${agentDir}/.pi-sync`, { recursive: true });
				await writeFile(
					getStatePath(agentDir),
					JSON.stringify({
						schemaVersion: 2,
						repoPath: repoDir,
						branch: "main",
						lastSyncedCommit: "a".repeat(40),
						lastSyncedAt: "2025-01-01T00:00:00.000Z",
						files: { "settings.json": computeBaselineEntry("old", 0o600) },
						pendingOperation: "apply-failed",
						lastBackup: null,
					}),
					"utf-8",
				);

				const migrated = await loadState(agentDir);

				expect(migrated.schemaVersion).toBe(3);
				expect(migrated.files["settings.json"]).toEqual({
					sha256: hash,
					mode: 0o644,
				});
				expect(migrated.pendingOperation).toMatchObject({
					type: "apply-failed",
				});
				expect(migrated.migrationReport?.reconciled).toEqual(["settings.json"]);
				expect(
					JSON.parse(await readFile(getStatePath(agentDir), "utf-8"))
						.schemaVersion,
				).toBe(3);
				await expect(readdir(`${agentDir}/.pi-sync`)).resolves.toEqual(
					expect.arrayContaining(["state.json"]),
				);
			},
		);
	});

	it("preserves mismatched v2 baselines and reports migration conflicts", async () => {
		await withTestEnvironment(
			async ({ agentDir, repoDir, writeAgentFile, writeRepoFile }) => {
				await writeAgentFile("settings.json", "local");
				await writeRepoFile("pi-sync.json", JSON.stringify({ root: "sync" }));
				await writeRepoFile("sync/settings.json", "remote");
				await mkdir(`${agentDir}/.pi-sync`, { recursive: true });
				const baseline = computeBaselineEntry("old", 0o600);
				await writeFile(
					getStatePath(agentDir),
					JSON.stringify({
						schemaVersion: 2,
						repoPath: repoDir,
						branch: "main",
						files: { "settings.json": baseline },
						pendingOperation: null,
					}),
					"utf-8",
				);

				const migrated = await loadState(agentDir);

				expect(migrated.files["settings.json"]).toEqual(baseline);
				expect(migrated.migrationReport?.conflicts).toEqual([
					expect.objectContaining({
						relativePath: "settings.json",
						reason: "local_repo_mismatch",
						baseline,
					}),
				]);
			},
		);
	});

	it("removes a v2 baseline when both sides are gone", async () => {
		await withTestEnvironment(async ({ agentDir, repoDir, writeRepoFile }) => {
			await writeRepoFile("pi-sync.json", JSON.stringify({ root: "sync" }));
			await mkdir(`${agentDir}/.pi-sync`, { recursive: true });
			await writeFile(
				getStatePath(agentDir),
				JSON.stringify({
					schemaVersion: 2,
					repoPath: repoDir,
					files: { "removed.txt": computeBaselineEntry("old", 0o600) },
					pendingOperation: null,
				}),
				"utf-8",
			);

			const migrated = await loadState(agentDir);

			expect(migrated.files).toEqual({});
			expect(migrated.migrationReport?.removed).toEqual(["removed.txt"]);
		});
	});

	it("migrates schema v1 and safely discards malformed state", async () => {
		await withTestEnvironment(async ({ agentDir }) => {
			const statePath = getStatePath(agentDir);
			await mkdir(`${agentDir}/.pi-sync`, { recursive: true });
			await writeFile(
				statePath,
				JSON.stringify({
					schemaVersion: 1,
					repoPath: "/old/repo",
					branch: "legacy",
					lastAppliedCommit: "b".repeat(40),
					lastAppliedAt: "2025-01-01T00:00:00.000Z",
					lastBackup: "2025-01-02T00:00:00.000Z",
				}),
				"utf-8",
			);

			await expect(loadState(agentDir)).resolves.toMatchObject({
				schemaVersion: 3,
				repoPath: "/old/repo",
				branch: "legacy",
				lastSyncedCommit: "b".repeat(40),
				lastSyncedAt: "2025-01-01T00:00:00.000Z",
				files: {},
			});

			await writeFile(statePath, "{ invalid", "utf-8");
			await expect(loadState(agentDir)).resolves.toMatchObject({
				schemaVersion: 3,
				repoPath: "",
				files: {},
			});
		});
	});
});
