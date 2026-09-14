import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hasConflictMarkers,
  validateFiles,
  validateJson,
} from "../src/sync/validate.ts";
import { createPiSyncConfig } from "./helpers/factories.ts";
import { withTestEnvironment } from "./helpers/temp-env.ts";

describe("content validation", () => {
  it.each(["<<<<<<< HEAD\nlocal", "=======\nremote", ">>>>>>> branch\n"]) 
    ("recognizes Git conflict markers", (content) => {
      expect(hasConflictMarkers(content)).toBe(true);
    });

  it("does not treat ordinary prose as a conflict marker", () => {
    expect(hasConflictMarkers("Use <<< arrows to describe the flow.")).toBe(false);
  });

  it("returns structured JSON validation errors", () => {
    expect(validateJson("settings.json", '{ "valid": true }')).toEqual([]);
    expect(validateJson("settings.json", "{ broken")).toMatchObject([
      { file: "settings.json", severity: "error" },
    ]);
  });
});

describe.sequential("validateFiles", () => {
  it("aggregates conflict, JSON, and adapter failures before apply", async () => {
    await withTestEnvironment(async ({ agentDir, repoDir }) => {
      const syncDir = join(repoDir, "sync");
      await mkdir(syncDir, { recursive: true });
      await Promise.all([
        writeFile(join(syncDir, "conflict.md"), "<<<<<<< HEAD\nlocal\n=======\nremote\n>>>>>>> main\n", "utf-8"),
        writeFile(join(syncDir, "broken.json"), "{ broken", "utf-8"),
        writeFile(join(syncDir, "settings.json"), JSON.stringify({ packages: ["/tmp/package"] }), "utf-8"),
      ]);

      const result = await validateFiles(
        agentDir,
        repoDir,
        createPiSyncConfig({
          include: ["**"],
          special: { "settings.json": "settings" },
        }),
        ["conflict.md", "broken.json", "settings.json"],
      );

      expect(result.blocked).toBe(true);
      expect(result.errors.map(({ file }) => file)).toEqual(expect.arrayContaining([
        "conflict.md",
        "broken.json",
        "settings.json",
      ]));
      expect(result.errors).toHaveLength(3);
    });
  });

  it("skips adapter validation for files without a special declaration", async () => {
    // 便携性校验归 adapter 所有：settings.json 只在 include 中（字节直传）时
    // 不该被按文件名隐式校验（design.md §0 / v0.2.0 决策 2）。
    await withTestEnvironment(async ({ agentDir, repoDir }) => {
      const syncDir = join(repoDir, "sync");
      await mkdir(syncDir, { recursive: true });
      await writeFile(
        join(syncDir, "settings.json"),
        JSON.stringify({ packages: ["file:/tmp/package"] }),
        "utf-8",
      );

      const result = await validateFiles(
        agentDir,
        repoDir,
        createPiSyncConfig({ include: ["**"] }),
        ["settings.json"],
      );

      expect(result).toEqual({ blocked: false, errors: [] });
    });
  });

  it("refuses path traversal and Windows absolute paths without reading outside sync", async () => {
    await withTestEnvironment(async ({ agentDir, rootDir, repoDir }) => {
      const outsidePath = join(rootDir, "outside.json");
      await writeFile(outsidePath, "{ broken", "utf-8");

      const result = await validateFiles(
        agentDir,
        repoDir,
        createPiSyncConfig({ include: ["**"] }),
        ["../outside.json", "C:\\outside.json", ""],
      );

      expect(result).toEqual({
        blocked: true,
        errors: [
          { file: "../outside.json", message: expect.stringContaining("相对路径"), severity: "error" },
          { file: "C:\\outside.json", message: expect.stringContaining("相对路径"), severity: "error" },
          { file: "", message: expect.stringContaining("相对路径"), severity: "error" },
        ],
      });
    });
  });
});
