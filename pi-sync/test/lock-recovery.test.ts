import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SyncLock } from "../src/system/lock.ts";
import { withTestEnvironment } from "./helpers/temp-env.ts";

describe.sequential("SyncLock recovery and contention", () => {
  it("allows exactly one concurrent contender to acquire the lock", async () => {
    await withTestEnvironment(async ({ agentDir }) => {
      const syncDir = join(agentDir, ".pi-sync");
      const first = new SyncLock(syncDir);
      const second = new SyncLock(syncDir);

      const acquired = await Promise.all([first.acquire("pull"), second.acquire("push")]);
      expect(acquired.filter(Boolean)).toHaveLength(1);
      await Promise.all([first.release(), second.release()]);
      expect(existsSync(join(syncDir, "sync.lock"))).toBe(false);
    });
  });

  it("recovers stale and malformed locks before acquiring a new one", async () => {
    await withTestEnvironment(async ({ agentDir }) => {
      const syncDir = join(agentDir, ".pi-sync");
      const lockPath = join(syncDir, "sync.lock");
      await mkdir(syncDir, { recursive: true });
      await writeFile(lockPath, JSON.stringify({
        pid: 999_999_999,
        hostname: "dead-host",
        startedAt: "2020-01-01T00:00:00.000Z",
        operation: "stale",
      }), "utf-8");

      const recovered = new SyncLock(syncDir);
      await expect(recovered.acquire("pull")).resolves.toBe(true);
      expect(await recovered.readLock()).toMatchObject({ pid: process.pid, operation: "pull" });
      await recovered.release();

      await writeFile(lockPath, "not-json", "utf-8");
      const malformed = new SyncLock(syncDir);
      await expect(malformed.acquire("push")).resolves.toBe(true);
      await malformed.release();
    });
  });

  it("does not let a non-owner release another active lock and honors timeout", async () => {
    await withTestEnvironment(async ({ agentDir }) => {
      const syncDir = join(agentDir, ".pi-sync");
      const owner = new SyncLock(syncDir);
      const nonOwner = new SyncLock(syncDir);
      await expect(owner.acquire("apply")).resolves.toBe(true);

      await nonOwner.release();
      expect(existsSync(join(syncDir, "sync.lock"))).toBe(true);
      await expect(nonOwner.acquire("push", 50)).resolves.toBe(false);
      expect(existsSync(join(syncDir, "sync.lock"))).toBe(true);

      await owner.release();
      expect(existsSync(join(syncDir, "sync.lock"))).toBe(false);
    });
  });
});
