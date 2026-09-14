import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPiSyncConfig, validateConfig } from "../src/sync/config.ts";
import { withTestEnvironment } from "./helpers/temp-env.ts";

const minimumConfig = {
  schemaVersion: 2,
  include: ["settings.json"],
} as const;

describe("schema v2 configuration validation", () => {
  it.each([
    ["Windows drive root", { ...minimumConfig, root: "C:\\agent" }],
    ["UNC root", { ...minimumConfig, root: "\\\\server\\share" }],
    ["empty root", { ...minimumConfig, root: "" }],
    ["non-string root", { ...minimumConfig, root: 1 }],
    ["empty branch", { ...minimumConfig, branch: " " }],
    ["option-like branch", { ...minimumConfig, branch: "--upload-pack" }],
    ["whitespace-padded branch", { ...minimumConfig, branch: " sync/main" }],
    ["control-character branch", { ...minimumConfig, branch: "sync/\u0007main" }],
    ["Windows drive include", { ...minimumConfig, include: ["C:\\secret"] }],
    ["traversing exclude", { ...minimumConfig, exclude: ["../secret"] }],
    ["absolute exclude", { ...minimumConfig, exclude: ["/secret"] }],
    ["non-string include", { ...minimumConfig, include: [1] }],
    ["non-string exclude", { ...minimumConfig, exclude: [1] }],
    ["non-object special", { ...minimumConfig, special: true }],
    ["non-object autoSync", { ...minimumConfig, autoSync: "yes" }],
  ])("rejects %s", (_name, raw) => {
    expect(() => validateConfig(raw)).toThrow("pi-sync.json");
  });

  it("does not share mutable default values between validation results", () => {
    const first = validateConfig({ ...minimumConfig });
    const second = validateConfig({ ...minimumConfig });

    first.include.push("themes/**");
    first.special["settings.json"] = "settings";
    first.autoSync.enabled = true;

    expect(second.include).toEqual(["settings.json"]);
    expect(second.special).toEqual({});
    expect(second.autoSync.enabled).toBe(false);
  });

  it("loads a valid config and reports missing or malformed files without leaking parse details", async () => {
    await withTestEnvironment(async ({ repoDir }) => {
      const configPath = join(repoDir, "pi-sync.json");
      await expect(loadPiSyncConfig(repoDir)).rejects.toThrow(`无法读取或解析 pi-sync.json：${configPath}`);

      await writeFile(configPath, JSON.stringify({ ...minimumConfig, branch: "sync/main" }), "utf-8");
      await expect(loadPiSyncConfig(repoDir)).resolves.toMatchObject({ branch: "sync/main" });

      await writeFile(configPath, "{not json", "utf-8");
      await expect(loadPiSyncConfig(repoDir)).rejects.toThrow(`无法读取或解析 pi-sync.json：${configPath}`);
    });
  });
});
