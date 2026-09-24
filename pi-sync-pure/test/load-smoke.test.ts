import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("extension loading", () => {
  it("registers /pisync without touching the real user agent directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sync-pure-load-"));
    temporaryDirectories.push(root);
    const agentDir = join(root, ".pi", "agent");
    const settingsManager = SettingsManager.create(root, agentDir);
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager,
      additionalExtensionPaths: [join(process.cwd(), "index.ts")],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const extensions = loader.getExtensions();
    const extension = extensions.extensions.find((entry) => entry.commands.has("pisync"));
    expect(extension).toBeDefined();
    expect(extensions.errors).toEqual([]);
  });
});
