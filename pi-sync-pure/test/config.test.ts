import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, getSyncPaths, loadLocalState, saveLocalState, validateConfig } from "../src/config.ts";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-sync-pure-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("pi-sync config", () => {
  it("provides the agreed include/exclude and autoSync defaults", () => {
    expect(DEFAULT_CONFIG.include).toContain("settings.json");
    expect(DEFAULT_CONFIG.exclude).toContain("**/*.tmp");
    expect(DEFAULT_CONFIG.special["settings.json"]).toBe("settings");
    expect(DEFAULT_CONFIG.autoSync).toEqual({ enabled: false });
  });

  it("validates and fills optional configuration fields", () => {
    expect(validateConfig({ schemaVersion: 2, include: ["extensions/**"] })).toEqual({
      schemaVersion: 2,
      include: ["extensions/**"],
      exclude: [],
      special: {},
      autoSync: { enabled: false },
    });
  });

  it.each([
    { schemaVersion: 1, include: ["settings.json"] },
    { schemaVersion: 2, include: [] },
    { schemaVersion: 2, include: ["../outside"] },
    { schemaVersion: 2, include: ["settings.json"], autoSync: { enabled: "yes" } },
    { schemaVersion: 2, include: ["settings.json"], special: { "settings.json": "./../outside.js" } },
  ])("rejects invalid configuration %#", (configuration) => {
    expect(() => validateConfig(configuration)).toThrow();
  });

  it("derives stable config-repo and local-state locations from a supplied home fixture", () => {
    expect(getSyncPaths("/temporary/home")).toEqual({
      piDir: "/temporary/home/.pi",
      agentDir: "/temporary/home/.pi/agent",
      repoPath: "/temporary/home/.pi/config-repo",
      statePath: "/temporary/home/.pi/agent/pi-sync-pure.json",
    });
  });

  it("saves and loads local state atomically in the supplied test directory", async () => {
    const directory = await createTemporaryDirectory();
    const statePath = join(directory, "state", "pi-sync-pure.json");
    expect(await loadLocalState(statePath)).toBeUndefined();
    await saveLocalState(statePath, { remoteUrl: "file:///remote.git", deviceBranch: "device/test" });
    expect(await loadLocalState(statePath)).toEqual({ remoteUrl: "file:///remote.git", deviceBranch: "device/test" });
    expect(JSON.parse(await readFile(statePath, "utf8"))).toHaveProperty("deviceBranch", "device/test");
  });
});
