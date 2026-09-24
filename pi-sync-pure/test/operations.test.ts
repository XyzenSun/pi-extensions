import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  align,
  initializeRepository,
  mergeDown,
  mergeUp,
  normalizeDeviceBranch,
  parseMergeStrategy,
  previewForceChanges,
  publish,
  push,
  recover,
  renameDevice,
  runAutoSync,
} from "../src/operations.ts";
import { currentBranch, git, localBranchExists, stageAndCommit } from "../src/git.ts";

const temporaryDirectories: string[] = [];

interface FixturePaths {
  piDir: string;
  agentDir: string;
  repoPath: string;
  statePath: string;
}

async function createRemoteFixture(): Promise<{ root: string; remote: string; paths: FixturePaths }> {
  const root = await mkdtemp(join(tmpdir(), "pi-sync-pure-operations-"));
  temporaryDirectories.push(root);
  const remote = join(root, "remote.git");
  await git(root, ["init", "--bare", remote]);
  const agentDir = join(root, "home", ".pi", "agent");
  const piDir = join(root, "home", ".pi");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", trackingId: "machine" }));
  return {
    root,
    remote,
    paths: {
      piDir,
      agentDir,
      repoPath: join(piDir, "config-repo"),
      statePath: join(agentDir, "pi-sync-pure.json"),
    },
  };
}

function devicePaths(root: string, name: string): FixturePaths {
  const agentDir = join(root, name, ".pi", "agent");
  return {
    piDir: join(root, name, ".pi"),
    agentDir,
    repoPath: join(root, name, ".pi", "config-repo"),
    statePath: join(agentDir, "pi-sync-pure.json"),
  };
}

async function seedMain(remote: string, root: string): Promise<void> {
  const seed = join(root, "seed");
  await mkdir(seed, { recursive: true });
  await git(seed, ["init", "-b", "main"]);
  await git(seed, ["config", "user.name", "Pi Sync Test"]);
  await git(seed, ["config", "user.email", "pi-sync-test@example.invalid"]);
  await mkdir(join(seed, "sync"), { recursive: true });
  await writeFile(join(seed, "sync", "settings.json"), JSON.stringify({ theme: "light", packages: ["npm:@xyzensun/pi-sync-pure"] }, null, 2));
  await writeFile(join(seed, "pi-sync.json"), JSON.stringify({
    schemaVersion: 2,
    include: ["settings.json", "prompts/**"],
    exclude: [],
    special: { "settings.json": "settings" },
    autoSync: { enabled: false },
  }, null, 2));
  await stageAndCommit(seed, "seed main");
  await git(seed, ["remote", "add", "origin", remote]);
  await git(seed, ["push", "origin", "main"]);
}

/** 模拟另一台机器在 main 上新增内容并推送。 */
async function pushFileToMain(remote: string, root: string, file: string, content: string): Promise<void> {
  const work = join(root, `main-work-${Math.random().toString(36).slice(2, 7)}`);
  // bare 仓库的 HEAD 可能指向不存在的默认分支, clone 时显式指定 main。
  await git(root, ["clone", "-b", "main", remote, work]);
  await git(work, ["config", "user.name", "Pi Sync Test"]);
  await git(work, ["config", "user.email", "pi-sync-test@example.invalid"]);
  await mkdir(join(work, "sync", "prompts"), { recursive: true });
  await writeFile(join(work, file), content);
  await stageAndCommit(work, "update main");
  await git(work, ["push", "origin", "main"]);
  await rm(work, { recursive: true, force: true });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("branch operations", () => {
  it("creates a device branch on an empty remote without checking out main", async () => {
    const fixture = await createRemoteFixture();
    const initialized = await initializeRepository(fixture.paths, fixture.remote, "laptop");
    expect(initialized.state.deviceBranch).toBe("device/laptop");
    expect(await git(fixture.paths.repoPath, ["branch", "--show-current"])).toMatchObject({ stdout: "device/laptop\n" });
    expect((await git(fixture.paths.repoPath, ["ls-remote", "--heads", "origin", "device/laptop"])).stdout).toContain("refs/heads/device/laptop");
    expect(await readFile(join(fixture.paths.statePath), "utf8")).toContain("device/laptop");
  });

  it("creates a device branch based on main and only force-publishes main explicitly", async () => {
    const fixture = await createRemoteFixture();
    await seedMain(fixture.remote, fixture.root);
    await initializeRepository(fixture.paths, fixture.remote, "laptop");
    expect((await git(fixture.paths.repoPath, ["branch", "--show-current"])).stdout.trim()).toBe("device/laptop");
    await publish({ paths: fixture.paths, state: { remoteUrl: fixture.remote, deviceBranch: "device/laptop" } });
    expect((await git(fixture.paths.repoPath, ["ls-remote", "--heads", "origin", "main"])).stdout).toContain("refs/heads/main");
  });

  it("offers remote device claims and can explicitly create a separate device branch", async () => {
    const fixture = await createRemoteFixture();
    await initializeRepository(fixture.paths, fixture.remote, "first-device");
    const secondPaths = { ...fixture.paths, repoPath: join(fixture.root, "second", "repo"), statePath: join(fixture.root, "second", "state.json") };
    await expect(initializeRepository(secondPaths, fixture.remote, "second-device")).rejects.toThrow("远端存在设备分支");
    await rm(secondPaths.repoPath, { recursive: true, force: true });
    const initialized = await initializeRepository(secondPaths, fixture.remote, "second-device", undefined, async () => null);
    expect(initialized.state.deviceBranch).toBe("device/second-device");
    expect((await git(secondPaths.repoPath, ["branch", "--show-current"])).stdout.trim()).toBe("device/second-device");
  });

  it("recognizes an explicit branch claim without capturing or pushing local state", async () => {
    const fixture = await createRemoteFixture();
    await initializeRepository(fixture.paths, fixture.remote, "first-device");
    // 模拟旧机器的独有配置: 认领后它必须原封不动地留在远端分支上。
    await mkdir(join(fixture.paths.repoPath, "sync", "extensions"), { recursive: true });
    await writeFile(join(fixture.paths.repoPath, "sync", "extensions", "old.ts"), "old config");
    await stageAndCommit(fixture.paths.repoPath, "add old config");
    await git(fixture.paths.repoPath, ["push", "-f", "origin", "HEAD"]);

    const claimPaths = { ...fixture.paths, repoPath: join(fixture.root, "claim", "repo"), statePath: join(fixture.root, "claim", "state.json") };
    const claimed = await initializeRepository(claimPaths, fixture.remote, "ignored-name", "device/first-device");
    expect(claimed.state.deviceBranch).toBe("device/first-device");
    expect(claimed.result.message).toContain("recover");
    const remoteTree = (await git(claimPaths.repoPath, ["ls-tree", "-r", "--name-only", "origin/device/first-device"])).stdout;
    expect(remoteTree).toContain("sync/extensions/old.ts");

    const invalidPaths = { ...fixture.paths, repoPath: join(fixture.root, "invalid", "repo"), statePath: join(fixture.root, "invalid", "state.json") };
    await expect(initializeRepository(invalidPaths, fixture.remote, "ignored-name", "device/missing")).rejects.toThrow("远端不存在可认领的分支");
  });

  it("creates a new device branch non-interactively with --new despite existing remote device branches", async () => {
    const fixture = await createRemoteFixture();
    await initializeRepository(fixture.paths, fixture.remote, "first-device");
    const newPaths = { ...fixture.paths, repoPath: join(fixture.root, "second", "repo"), statePath: join(fixture.root, "second", "state.json") };
    const created = await initializeRepository(newPaths, fixture.remote, "second-device", undefined, undefined, true);
    expect(created.state.deviceBranch).toBe("device/second-device");
    expect((await git(newPaths.repoPath, ["ls-remote", "--heads", "origin", "device/second-device"])).stdout).toContain("refs/heads/device/second-device");
  });

  it("pushes even when local settings declare non-portable package sources", async () => {
    const fixture = await createRemoteFixture();
    await initializeRepository(fixture.paths, fixture.remote, "laptop");
    await writeFile(
      join(fixture.paths.agentDir, "settings.json"),
      JSON.stringify({ theme: "dark", packages: ["npm:shared", "file:../local-dev-plugin"] }),
    );
    const result = await push({ paths: fixture.paths, state: { remoteUrl: fixture.remote, deviceBranch: "device/laptop" } });
    expect(result.message).toContain("已推送");
    const repositorySettings = JSON.parse(await readFile(join(fixture.paths.repoPath, "sync", "settings.json"), "utf8"));
    expect(repositorySettings.packages).toContain("npm:shared");
    expect(JSON.stringify(repositorySettings.packages)).not.toContain("file:");
  });

  it("previews force changes as a file-level diff between branch heads", async () => {
    const fixture = await createRemoteFixture();
    await seedMain(fixture.remote, fixture.root);
    await initializeRepository(fixture.paths, fixture.remote, "laptop");
    // main 的 settings.json 是 theme light, 本机是 theme dark, 两点 diff 应只列出这一个文件,
    // 而不是全部同步文件。
    const affected = await previewForceChanges(
      { paths: fixture.paths, state: { remoteUrl: fixture.remote, deviceBranch: "device/laptop" } },
      "main",
    );
    expect(affected).toEqual(["settings.json"]);
  });

  it("uses confirmed strategy flags and validates device branch names", () => {
    expect(parseMergeStrategy(["--ours"], ["ours", "theirs"])).toBe("ours");
    expect(parseMergeStrategy(["--theirs"], ["theirs", "ours"])).toBe("theirs");
    expect(() => parseMergeStrategy(["--ours", "--theirs"], ["ours", "theirs"])).toThrow();
    expect(normalizeDeviceBranch("laptop")).toBe("device/laptop");
    expect(normalizeDeviceBranch("device/other")).toBe("device/other");
  });

  it("merge-down archives local changes first and merges main", async () => {
    const fixture = await createRemoteFixture();
    await seedMain(fixture.remote, fixture.root);
    await initializeRepository(fixture.paths, fixture.remote, "laptop");
    // 本机有未 push 的改动, main 上有新文件, 两边互不冲突。
    await writeFile(join(fixture.paths.agentDir, "settings.json"), JSON.stringify({ theme: "solarized", trackingId: "machine" }));
    await pushFileToMain(fixture.remote, fixture.root, join("sync", "prompts", "shared.md"), "shared prompt\n");

    const result = await mergeDown({ paths: fixture.paths, state: { remoteUrl: fixture.remote, deviceBranch: "device/laptop" } });
    expect(result.message).toContain("origin/main");
    // 本机未 push 的改动被存档并保留。
    const settings = JSON.parse(await readFile(join(fixture.paths.agentDir, "settings.json"), "utf8"));
    expect(settings.theme).toBe("solarized");
    // main 的新文件被合并进来。
    expect(await readFile(join(fixture.paths.agentDir, "prompts", "shared.md"), "utf8")).toContain("shared prompt");
  });

  it("merge-down can merge from another device branch directly", async () => {
    const fixture = await createRemoteFixture();
    await seedMain(fixture.remote, fixture.root);
    // 设备 B 推送自己的独有配置。
    const bPaths = devicePaths(fixture.root, "home-b");
    await mkdir(join(bPaths.agentDir, "prompts"), { recursive: true });
    await writeFile(join(bPaths.agentDir, "prompts", "b-prompt.md"), "device b prompt\n");
    // B 的 settings 与 main 保持一致, 避免与 A 的修改形成人为冲突。
    await writeFile(join(bPaths.agentDir, "settings.json"), JSON.stringify({ theme: "light" }));
    await initializeRepository(bPaths, fixture.remote, "device-b");
    // 设备 A 直接从 device/B 合并, 不经过 main; 远端已有 B 的分支, 用 --new 强制新建。
    await initializeRepository(fixture.paths, fixture.remote, "laptop", undefined, undefined, true);
    const result = await mergeDown(
      { paths: fixture.paths, state: { remoteUrl: fixture.remote, deviceBranch: "device/laptop" } },
      "device/device-b",
    );
    expect(result.message).toContain("origin/device/device-b");
    expect(await readFile(join(fixture.paths.agentDir, "prompts", "b-prompt.md"), "utf8")).toContain("device b prompt");
  });

  it("merge-up merges the device branch into main and restores the device checkout", async () => {
    const fixture = await createRemoteFixture();
    await seedMain(fixture.remote, fixture.root);
    await initializeRepository(fixture.paths, fixture.remote, "laptop");
    await mkdir(join(fixture.paths.agentDir, "prompts"), { recursive: true });
    await writeFile(join(fixture.paths.agentDir, "prompts", "a-prompt.md"), "device a prompt\n");
    await push({ paths: fixture.paths, state: { remoteUrl: fixture.remote, deviceBranch: "device/laptop" } });

    const result = await mergeUp({ paths: fixture.paths, state: { remoteUrl: fixture.remote, deviceBranch: "device/laptop" } });
    expect(result.message).toContain("main");
    const mainTree = (await git(fixture.paths.repoPath, ["ls-tree", "-r", "--name-only", "origin/main"])).stdout;
    expect(mainTree).toContain("sync/prompts/a-prompt.md");
    // 操作完回到设备分支, 本地 main 只是临时 checkout, 用完即删。
    expect(await currentBranch(fixture.paths.repoPath)).toBe("device/laptop");
    expect(await localBranchExists(fixture.paths.repoPath, "main")).toBe(false);
  });

  it("align force-resets the device branch to origin/main and mirrors it back", async () => {
    const fixture = await createRemoteFixture();
    await seedMain(fixture.remote, fixture.root);
    await initializeRepository(fixture.paths, fixture.remote, "laptop");
    await mkdir(join(fixture.paths.agentDir, "prompts"), { recursive: true });
    await writeFile(join(fixture.paths.agentDir, "prompts", "local-only.md"), "local only\n");
    await push({ paths: fixture.paths, state: { remoteUrl: fixture.remote, deviceBranch: "device/laptop" } });

    await align({ paths: fixture.paths, state: { remoteUrl: fixture.remote, deviceBranch: "device/laptop" } });
    // 分支头被重置为 main: 本机独有的文件从分支与 agent 目录中一并消失。
    const headTree = (await git(fixture.paths.repoPath, ["ls-tree", "-r", "--name-only", "HEAD"])).stdout;
    expect(headTree).not.toContain("local-only.md");
    await expect(readFile(join(fixture.paths.agentDir, "prompts", "local-only.md"))).rejects.toThrow();
  });

  it("recover restores the agent directory from the remote device branch", async () => {
    const fixture = await createRemoteFixture();
    await seedMain(fixture.remote, fixture.root);
    await initializeRepository(fixture.paths, fixture.remote, "laptop");
    await mkdir(join(fixture.paths.agentDir, "prompts"), { recursive: true });
    await writeFile(join(fixture.paths.agentDir, "prompts", "precious.md"), "precious config\n");
    await push({ paths: fixture.paths, state: { remoteUrl: fixture.remote, deviceBranch: "device/laptop" } });

    // 模拟本机文件丢失, recover 后从远端设备分支找回。
    await rm(join(fixture.paths.agentDir, "prompts", "precious.md"));
    const result = await recover({ paths: fixture.paths, state: { remoteUrl: fixture.remote, deviceBranch: "device/laptop" } });
    expect(result.message).toContain("恢复");
    expect(await readFile(join(fixture.paths.agentDir, "prompts", "precious.md"), "utf8")).toContain("precious config");
  });

  it("rename keeps the old remote branch and updates local state", async () => {
    const fixture = await createRemoteFixture();
    await initializeRepository(fixture.paths, fixture.remote, "old-name");
    const result = await renameDevice(
      { paths: fixture.paths, state: { remoteUrl: fixture.remote, deviceBranch: "device/old-name" } },
      "new-name",
    );
    expect(result.message).toContain("device/new-name");
    expect((await git(fixture.paths.repoPath, ["ls-remote", "--heads", "origin"])).stdout).toContain("device/old-name");
    expect((await git(fixture.paths.repoPath, ["ls-remote", "--heads", "origin"])).stdout).toContain("device/new-name");
    expect(await currentBranch(fixture.paths.repoPath)).toBe("device/new-name");
  });

  it("autoSync archives local changes, merges main once and stays silent afterwards", async () => {
    const fixture = await createRemoteFixture();
    await seedMain(fixture.remote, fixture.root);
    await initializeRepository(fixture.paths, fixture.remote, "laptop");
    await writeFile(join(fixture.paths.agentDir, "settings.json"), JSON.stringify({ theme: "solarized", trackingId: "machine" }));
    await pushFileToMain(fixture.remote, fixture.root, join("sync", "prompts", "shared.md"), "shared prompt\n");

    const context = { paths: fixture.paths, state: { remoteUrl: fixture.remote, deviceBranch: "device/laptop" } };
    const result = await runAutoSync(context);
    expect(result?.message).toContain("/reload");
    // 本机改动被 push 到设备分支存档并保留。
    const settings = JSON.parse(await readFile(join(fixture.paths.agentDir, "settings.json"), "utf8"));
    expect(settings.theme).toBe("solarized");
    expect(await readFile(join(fixture.paths.agentDir, "prompts", "shared.md"), "utf8")).toContain("shared prompt");
    // main 无新内容时静默结束。
    expect(await runAutoSync(context)).toBeUndefined();
  });
});
