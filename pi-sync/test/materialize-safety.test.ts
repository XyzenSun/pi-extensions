import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { atomicWrite, executeMaterialize, readAgentFile } from "../src/sync/materialize.ts";
import type { MaterializePlan } from "../src/sync/materialize.ts";
import { withTestEnvironment } from "./helpers/temp-env.ts";

function plan(overrides: Partial<MaterializePlan>): MaterializePlan {
  return {
    toWrite: [],
    toDelete: [],
    deferred: [],
    conflicts: [],
    validationErrors: [],
    blocked: false,
    nextBaseline: null,
    hasStateChanges: false,
    ...overrides,
  };
}

describe.sequential("materialize execution safety", () => {
  it("retains requested file modes and leaves no temporary file after atomic writes", async () => {
    await withTestEnvironment(async ({ agentDir }) => {
      const targetPath = join(agentDir, "themes/dark.json");
      await atomicWrite(targetPath, "{}\n", 0o600);

      expect(await readFile(targetPath, "utf-8")).toBe("{}\n");
      expect((await import("node:fs/promises").then(({ stat }) => stat(targetPath))).mode & 0o777).toBe(0o600);
      expect((await import("node:fs/promises").then(({ readdir }) => readdir(join(agentDir, "themes"))))
        .every((name) => !name.endsWith(".tmp"))).toBe(true);
    });
  });

  it("records unsafe writes and deletes as failures without escaping the agent directory", async () => {
    await withTestEnvironment(async ({ rootDir, agentDir }) => {
      const outsidePath = join(rootDir, "outside.txt");
      await writeFile(outsidePath, "outside", "utf-8");

      const result = await executeMaterialize(agentDir, plan({
        toWrite: [{ relativePath: "../outside.txt", content: Buffer.from("overwritten"), mode: 0o644 }],
        toDelete: ["C:\\outside.txt"],
      }));

      expect(result).toMatchObject({
        written: [],
        deleted: [],
        failed: [
          { file: "../outside.txt", reason: expect.stringContaining("不允许路径逃逸") },
          { file: "C:\\outside.txt", reason: expect.stringContaining("不允许绝对路径") },
        ],
      });
      expect(await readFile(outsidePath, "utf-8")).toBe("outside");
    });
  });

  it("does not follow a symbolic-link parent directory when applying or reading files", async () => {
    await withTestEnvironment(async ({ rootDir, agentDir }) => {
      const outsideDir = join(rootDir, "outside");
      await mkdir(outsideDir, { recursive: true });
      await symlink(outsideDir, join(agentDir, "linked"));

      const result = await executeMaterialize(agentDir, plan({
        toWrite: [{ relativePath: "linked/escape.txt", content: Buffer.from("escaped"), mode: 0o644 }],
      }));

      expect(result.failed).toEqual([
        { file: "linked/escape.txt", reason: expect.stringContaining("符号链接") },
      ]);
      expect(existsSync(join(outsideDir, "escape.txt"))).toBe(false);
      await expect(readAgentFile(agentDir, "linked/escape.txt")).rejects.toThrow("符号链接");
    });
  });

  it("reports a skipped deletion when a safe target no longer exists", async () => {
    await withTestEnvironment(async ({ agentDir }) => {
      const result = await executeMaterialize(agentDir, plan({ toDelete: ["themes/missing.json"] }));
      expect(result).toMatchObject({ deleted: [], skipped: ["themes/missing.json"], failed: [] });
    });
  });
});
