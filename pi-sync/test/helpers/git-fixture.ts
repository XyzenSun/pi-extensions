import { execFile as execFileCallback } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export class GitFixtureError extends Error {
  constructor(
    readonly args: string[],
    readonly cwd: string,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed in ${cwd}: ${stderr || "unknown git error"}`);
    this.name = "GitFixtureError";
  }
}

/** Runs local Git with prompts disabled. It never contacts a network remote. */
export async function runGit(cwd: string, args: string[]): Promise<GitCommandResult> {
  try {
    const result = await execFile("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return {
      stdout: result.stdout.trimEnd(),
      stderr: result.stderr.trimEnd(),
    };
  } catch (error: unknown) {
    const failure = error as { stderr?: string; message?: string };
    throw new GitFixtureError(args, cwd, failure.stderr?.trimEnd() ?? failure.message ?? "");
  }
}

export async function configureGitRepository(repoPath: string): Promise<void> {
  await runGit(repoPath, ["config", "user.name", "pi-git-sync test"]);
  await runGit(repoPath, ["config", "user.email", "pi-git-sync-test@example.invalid"]);
  await runGit(repoPath, ["config", "commit.gpgSign", "false"]);
}

export async function createGitRepository(repoPath: string): Promise<void> {
  await mkdir(repoPath, { recursive: true });
  await runGit(repoPath, ["init", "--initial-branch=main"]);
  await configureGitRepository(repoPath);
}

export async function commitAll(repoPath: string, message: string): Promise<string> {
  await runGit(repoPath, ["add", "--all"]);
  await runGit(repoPath, ["commit", "--no-gpg-sign", "-m", message]);
  return (await runGit(repoPath, ["rev-parse", "HEAD"])).stdout;
}

export interface GitFixture {
  remotePath: string;
  seedPath: string;
  deviceAPath: string;
  deviceBPath: string;
  writeAndCommit(repoPath: string, relativePath: string, content: string): Promise<string>;
}

/**
 * Creates a bare local remote with two configured clones. The remote starts with
 * one harmless commit so both clones have an attached `main` branch.
 */
export async function createGitFixture(rootDir: string): Promise<GitFixture> {
  const remotePath = join(rootDir, "remote.git");
  const seedPath = join(rootDir, "seed");
  const deviceAPath = join(rootDir, "device-a");
  const deviceBPath = join(rootDir, "device-b");

  await runGit(rootDir, ["init", "--bare", remotePath]);
  await createGitRepository(seedPath);
  await writeFile(join(seedPath, ".gitkeep"), "", "utf-8");
  await commitAll(seedPath, "Initialize test remote");
  await runGit(seedPath, ["remote", "add", "origin", remotePath]);
  await runGit(seedPath, ["push", "--set-upstream", "origin", "main"]);
  await runGit(rootDir, ["--git-dir", remotePath, "symbolic-ref", "HEAD", "refs/heads/main"]);

  await runGit(rootDir, ["clone", remotePath, deviceAPath]);
  await runGit(rootDir, ["clone", remotePath, deviceBPath]);
  await Promise.all([configureGitRepository(deviceAPath), configureGitRepository(deviceBPath)]);

  return {
    remotePath,
    seedPath,
    deviceAPath,
    deviceBPath,
    async writeAndCommit(repoPath, relativePath, content) {
      const targetPath = join(repoPath, relativePath);
      await mkdir(join(targetPath, ".."), { recursive: true });
      await writeFile(targetPath, content, "utf-8");
      return commitAll(repoPath, `Update ${relativePath}`);
    },
  };
}
