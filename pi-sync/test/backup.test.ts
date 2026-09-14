import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_BACKUPS,
  cleanupOldBackups,
  createBackup,
  getLatestBackup,
  listBackups,
  restoreBackup,
} from "../src/system/backup.ts";
import type { MaterializePlan } from "../src/sync/materialize.ts";
import { PiSyncCommands } from "../src/orchestration/commands.ts";
import { loadState, saveState } from "../src/system/state.ts";
import { createPiSyncConfig, createSyncState } from "./helpers/factories.ts";
import { runGit } from "./helpers/git-fixture.ts";
import { withTestEnvironment } from "./helpers/temp-env.ts";

function createPlan(): MaterializePlan {
  return {
    toWrite: [
      { relativePath: "themes/current.json", content: Buffer.from("new\n"), mode: 0o644 },
      { relativePath: "prompts/new.md", content: Buffer.from("new prompt\n"), mode: 0o644 },
    ],
    toDelete: ["prompts/old.md"],
    deferred: [],
    conflicts: [],
    validationErrors: [],
    blocked: false,
    nextBaseline: {
      "themes/current.json": { sha256: "abc123", mode: 0o644 },
      "prompts/new.md": { sha256: "def456", mode: 0o644 },
    },
    hasStateChanges: true,
  };
}

describe.sequential("backup and restore", () => {
  it("restores overwritten and deleted files, removes created files, and preserves modes", async () => {
    await withTestEnvironment(async (environment) => {
      await environment.writeAgentFile("themes/current.json", "old\n");
      await environment.writeAgentFile("prompts/old.md", "old prompt\n");
      await chmod(join(environment.agentDir, "themes/current.json"), 0o600);
      const plan = createPlan();

      const backup = await createBackup(environment.agentDir, "a".repeat(40), "apply", plan);
      expect(backup.files).toMatchObject({
        "themes/current.json": { action: "backed_up", mode: 0o600 },
        "prompts/new.md": { action: "will_create" },
        "prompts/old.md": { action: "will_delete" },
      });

      await environment.writeAgentFile("themes/current.json", "new\n");
      await environment.writeAgentFile("prompts/new.md", "new prompt\n");
      await rm(join(environment.agentDir, "prompts/old.md"));
      await restoreBackup(environment.agentDir, backup);

      await expect(import("node:fs/promises").then(({ readFile }) => readFile(join(environment.agentDir, "themes/current.json"), "utf-8")))
        .resolves.toBe("old\n");
      await expect(import("node:fs/promises").then(({ readFile }) => readFile(join(environment.agentDir, "prompts/old.md"), "utf-8")))
        .resolves.toBe("old prompt\n");
      await expect(import("node:fs/promises").then(({ access }) => access(join(environment.agentDir, "prompts/new.md"))))
        .rejects.toThrow();
      expect((await stat(join(environment.agentDir, "themes/current.json"))).mode & 0o777).toBe(0o600);
    });
  });

  it("blocks apply and leaves no backup residue when a planned file cannot be backed up", async () => {
    await withTestEnvironment(async (environment) => {
      const config = createPiSyncConfig({ include: ["prompts/**"] });
      await mkdir(join(environment.repoDir, "sync/prompts"), { recursive: true });
      await writeFile(join(environment.repoDir, "pi-sync.json"), JSON.stringify(config), "utf-8");
      await writeFile(join(environment.repoDir, "sync/prompts/remote.md"), "remote\n", "utf-8");
      await runGit(environment.repoDir, ["init", "-b", "main"]);
      await runGit(environment.repoDir, ["config", "user.name", "test"]);
      await runGit(environment.repoDir, ["config", "user.email", "test@example.com"]);
      await runGit(environment.repoDir, ["add", "."]);
      await runGit(environment.repoDir, ["commit", "-m", "remote config"]);

      // A directory at the destination makes the planned file impossible to
      // snapshot. apply must stop before materialize attempts any write.
      await mkdir(join(environment.agentDir, "prompts/remote.md"), { recursive: true });
      await saveState(environment.agentDir, createSyncState({
        repoPath: environment.repoDir,
        files: {},
      }));

      const result = await new PiSyncCommands(environment.agentDir).apply(environment.repoDir);

      expect(result).toMatchObject({ ok: false, code: "partial_failure", reload: false });
      expect(result.message).toContain("备份失败，应用已中止");
      expect((await stat(join(environment.agentDir, "prompts/remote.md"))).isDirectory()).toBe(true);
      expect(await listBackups(environment.agentDir)).toEqual([]);
      await expect(loadState(environment.agentDir)).resolves.toMatchObject({ pendingOperation: null });
    });
  });

  it("lists backups newest first, returns the latest, and removes only old entries", async () => {
    await withTestEnvironment(async (environment) => {
      const backupsDir = join(environment.agentDir, ".pi-sync/backups");
      for (const timestamp of ["2026-01-01T00-00-00-000Z", "2026-01-03T00-00-00-000Z", "2026-01-02T00-00-00-000Z"]) {
        const dir = join(backupsDir, timestamp);
        await writeFile(join(dir, "backup.json"), JSON.stringify({
          timestamp,
          commit: "commit",
          reason: "apply",
          operation: "apply",
          files: {},
        }), { encoding: "utf-8", flag: "w" }).catch(async () => {
          const { mkdir } = await import("node:fs/promises");
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, "backup.json"), JSON.stringify({ timestamp, commit: "commit", reason: "apply", operation: "apply", files: {} }), "utf-8");
        });
      }

      const backups = await listBackups(environment.agentDir);
      expect(backups.map(({ timestamp }) => timestamp)).toEqual([
        "2026-01-03T00-00-00-000Z",
        "2026-01-02T00-00-00-000Z",
        "2026-01-01T00-00-00-000Z",
      ]);
      expect((await getLatestBackup(environment.agentDir))?.timestamp).toBe("2026-01-03T00-00-00-000Z");
      await expect(cleanupOldBackups(environment.agentDir, 1)).resolves.toBe(2);
      expect((await listBackups(environment.agentDir)).map(({ timestamp }) => timestamp))
        .toEqual(["2026-01-03T00-00-00-000Z"]);
    });
  });

  it("rejects unsafe plans and incomplete or corrupted backup data", async () => {
    await withTestEnvironment(async (environment) => {
      const unsafePlan: MaterializePlan = {
        toWrite: [{ relativePath: "../outside.txt", content: Buffer.from("bad"), mode: 0o644 }],
        toDelete: [],
        deferred: [],
        conflicts: [],
        validationErrors: [],
        blocked: false,
        nextBaseline: null,
        hasStateChanges: true,
      };
      await expect(createBackup(environment.agentDir, "commit", "apply", unsafePlan))
        .rejects.toThrow("不允许路径逃逸");

      await environment.writeAgentFile("themes/dark.json", "old");
      const backup = await createBackup(environment.agentDir, "commit", "apply", {
        toWrite: [{ relativePath: "themes/dark.json", content: Buffer.from("new"), mode: 0o644 }],
        toDelete: [],
        deferred: [],
        conflicts: [],
        validationErrors: [],
        blocked: false,
        nextBaseline: null,
        hasStateChanges: true,
      });
      const backupDataPath = join(backup.path, "data/themes/dark.json");
      await writeFile(backupDataPath, "corrupt", "utf-8");
      await expect(restoreBackup(environment.agentDir, backup)).rejects.toThrow("备份数据 hash 不匹配");
      await rm(backupDataPath);
      await expect(restoreBackup(environment.agentDir, backup)).rejects.toThrow("未找到备份数据文件");
    });
  });

  it("skips corrupted backup metadata in listBackups and rejects missing data directory in restoreBackup", async () => {
    await withTestEnvironment(async (environment) => {
      const backupsDir = join(environment.agentDir, ".pi-sync/backups");
      const { mkdir } = await import("node:fs/promises");

      // Create a valid backup with data dir
      const validTimestamp = "2026-07-01T00-00-00-000Z";
      const validDir = join(backupsDir, validTimestamp);
      const dataDir = join(validDir, "data");
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(validDir, "backup.json"), JSON.stringify({
        timestamp: validTimestamp,
        commit: "abc",
        reason: "apply",
        operation: "apply",
        files: {},
      }), "utf-8");

      // Create a corrupted backup (bad JSON)
      const corruptTimestamp = "2026-07-02T00-00-00-000Z";
      const corruptDir = join(backupsDir, corruptTimestamp);
      await mkdir(corruptDir, { recursive: true });
      await writeFile(join(corruptDir, "backup.json"), "not-json-at-all", "utf-8");

      // Create a backup with no data directory
      const noDataTimestamp = "2026-07-03T00-00-00-000Z";
      const noDataDir = join(backupsDir, noDataTimestamp);
      await mkdir(noDataDir, { recursive: true });
      await writeFile(join(noDataDir, "backup.json"), JSON.stringify({
        timestamp: noDataTimestamp,
        commit: "abc",
        reason: "apply",
        operation: "apply",
        files: { "some-file.md": { action: "backed_up", sha256: "abc", mode: 0o644 } },
      }), "utf-8");

      // listBackups should skip the corrupted one
      const backups = await listBackups(environment.agentDir);
      expect(backups.length).toBe(2); // valid + no-data-dir (corrupted skipped)
      expect(backups.map(b => b.timestamp).sort()).toEqual([validTimestamp, noDataTimestamp].sort());

      // restoreBackup should reject missing data directory
      await expect(restoreBackup(environment.agentDir, {
        timestamp: noDataTimestamp,
        path: noDataDir,
        commit: "abc",
        reason: "apply",
        operation: "apply",
        files: { "some-file.md": { action: "backed_up", sha256: "abc", mode: 0o644 } },
      })).rejects.toThrow("未找到备份数据目录");
    });
  });

  it("cleanupOldBackups handles empty or no backups gracefully", async () => {
    await withTestEnvironment(async (environment) => {
      // No backups at all
      const removed = await cleanupOldBackups(environment.agentDir, 5);
      expect(removed).toBe(0);
    });
  });

  it("cleanupOldBackups defaults to retaining MAX_BACKUPS entries", async () => {
    await withTestEnvironment(async (environment) => {
      const backupsDir = join(environment.agentDir, ".pi-sync", "backups");
      // 造 7 份备份，时间戳递增，验证默认保留最新 5 份。
      const timestamps = Array.from(
        { length: 7 },
        (_unused, index) => `2026-01-0${index + 1}T00-00-00-000Z`,
      );
      for (const timestamp of timestamps) {
        const dir = join(backupsDir, timestamp);
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, "backup.json"),
          JSON.stringify({
            timestamp,
            commit: "commit",
            reason: "apply",
            operation: "apply",
            files: {},
          }),
          "utf-8",
        );
      }

      expect(MAX_BACKUPS).toBe(5);
      // 不传 maxBackups：应使用默认值删掉最旧的 2 份。
      await expect(cleanupOldBackups(environment.agentDir)).resolves.toBe(2);

      const remaining = (await listBackups(environment.agentDir)).map(
        ({ timestamp }) => timestamp,
      );
      expect(remaining).toEqual(timestamps.slice(-5).reverse());

      // 幂等：已在阈值内时不再删除。
      await expect(cleanupOldBackups(environment.agentDir)).resolves.toBe(0);
    });
  });
});
