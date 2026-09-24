import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { aheadBehind, currentBranch, git, localBranchExists, remoteBranchExists, stageAndCommit, statusPorcelain } from "../src/git.ts";

const temporaryDirectories: string[] = [];

async function createGitRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-sync-pure-git-"));
  temporaryDirectories.push(directory);
  await mkdir(directory, { recursive: true });
  await git(directory, ["init", "-b", "device/test"]);
  await git(directory, ["config", "user.name", "Pi Sync Test"]);
  await git(directory, ["config", "user.email", "pi-sync-test@example.invalid"]);
  await writeFile(join(directory, "tracked.txt"), "initial\n");
  await stageAndCommit(directory, "initial commit");
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("git helpers", () => {
  it("runs git in the supplied temporary repository and detects changes", async () => {
    const repo = await createGitRepository();
    expect(await currentBranch(repo)).toBe("device/test");
    expect(await localBranchExists(repo, "device/test")).toBe(true);
    expect(await remoteBranchExists(repo, "device/test")).toBe(false);
    expect(await aheadBehind(repo, "device/test")).toBeUndefined();

    await writeFile(join(repo, "tracked.txt"), "changed\n");
    expect((await statusPorcelain(repo)).trim()).toBe("M tracked.txt");
    expect(await stageAndCommit(repo, "update file")).toBe(true);
    expect(await stageAndCommit(repo, "empty commit skipped")).toBe(false);
    expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("changed\n");
  });

  it("raises a structured error when git fails", async () => {
    const repo = await createGitRepository();
    await expect(git(repo, ["not-a-git-subcommand"])).rejects.toMatchObject({ code: 1, args: expect.any(Array) });
  });
});
