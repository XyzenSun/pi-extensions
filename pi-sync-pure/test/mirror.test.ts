import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { capture } from "../src/capture.ts";
import { materialize } from "../src/materialize.ts";

const temporaryDirectories: string[] = [];

async function createFixture(): Promise<{ root: string; agent: string; repo: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-sync-pure-mirror-"));
  temporaryDirectories.push(root);
  const agent = join(root, "agent");
  const repo = join(root, "repo");
  await mkdir(agent, { recursive: true });
  await mkdir(repo, { recursive: true });
  return { root, agent, repo };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("capture and materialize", () => {
  it("mirrors included files and propagates deletions without following symlinks", async () => {
    const { agent, repo } = await createFixture();
    await mkdir(join(agent, "extensions"), { recursive: true });
    await writeFile(join(agent, "settings.json"), JSON.stringify({ theme: "dark", trackingId: "machine" }));
    await writeFile(join(agent, "extensions", "sample.ts"), "export const value = 1;\n");
    await writeFile(join(agent, "ignored.txt"), "not included");
    await symlink(join(agent, "settings.json"), join(agent, "extensions", "link.json"));

    const config = structuredClone(DEFAULT_CONFIG);
    config.include = ["settings.json", "extensions/**"];
    const captured = await capture(agent, repo, config);
    expect(captured.copied).toContain("settings.json");
    expect(captured.copied).toContain("extensions/sample.ts");
    expect(captured.copied).not.toContain("extensions/link.json");
    expect(captured.copied).not.toContain("ignored.txt");

    await rm(join(agent, "extensions", "sample.ts"));
    await capture(agent, repo, config);
    await expect(readFile(join(repo, "sync", "extensions", "sample.ts"))).rejects.toThrow();
    expect(await readFile(join(repo, "sync", "settings.json"), "utf8")).toContain("npm:@xyzensun/pi-sync-pure");
  });

  it("materializes repository files and removes local included files absent from repository", async () => {
    const { agent, repo } = await createFixture();
    await mkdir(join(repo, "sync", "extensions"), { recursive: true });
    await mkdir(join(agent, "extensions"), { recursive: true });
    await writeFile(join(repo, "sync", "extensions", "shared.ts"), "export const shared = true;\n");
    await writeFile(join(agent, "extensions", "old.ts"), "old");
    const config = structuredClone(DEFAULT_CONFIG);
    config.include = ["extensions/**"];

    const result = await materialize(repo, agent, config);
    expect(result.copied).toEqual(["extensions/shared.ts"]);
    expect(result.deleted).toEqual(["extensions/old.ts"]);
    expect(await readFile(join(agent, "extensions", "shared.ts"), "utf8")).toContain("shared = true");
    await expect(readFile(join(agent, "extensions", "old.ts"))).rejects.toThrow();
  });
});
