import { spawn } from "node:child_process";

export interface GitResult {
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly code: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export async function git(
  repoPath: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<GitResult> {
  return runProcess("git", ["-C", repoPath, ...args], repoPath, options.timeoutMs);
}

export async function gitOutsideRepository(
  args: string[],
  cwd: string,
  options: { timeoutMs?: number } = {},
): Promise<GitResult> {
  return runProcess("git", args, cwd, options.timeoutMs);
}

export async function cloneRepository(remoteUrl: string, destination: string): Promise<void> {
  await gitOutsideRepository(["clone", "--origin", "origin", remoteUrl, destination], process.cwd(), { timeoutMs: 120_000 });
}

export async function currentBranch(repoPath: string): Promise<string> {
  return (await git(repoPath, ["branch", "--show-current"])).stdout.trim();
}

export async function currentRemoteUrl(repoPath: string): Promise<string> {
  return (await git(repoPath, ["remote", "get-url", "origin"])).stdout.trim();
}

export async function fetchOrigin(repoPath: string): Promise<void> {
  await git(repoPath, ["fetch", "origin", "--prune"], { timeoutMs: 120_000 });
}

export async function listBranchFiles(repoPath: string, branch: string, directory: string): Promise<string[]> {
  const output = (await git(repoPath, ["ls-tree", "-r", "--name-only", branch, "--", directory])).stdout;
  return output.split(/\r?\n/).filter(Boolean);
}

export async function listRemoteDeviceBranches(repoPath: string): Promise<string[]> {
  const output = (await git(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/device/"])).stdout;
  return output.split(/\r?\n/).filter(Boolean).map((branch) => branch.replace(/^origin\//, ""));
}

export async function remoteBranchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await git(repoPath, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export async function localBranchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await git(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export async function ensureValidBranchName(repoPath: string, branch: string): Promise<void> {
  try {
    await git(repoPath, ["check-ref-format", "--branch", branch]);
  } catch {
    throw new Error(`无效的 Git 分支名: ${branch}`);
  }
}

export async function stageAndCommit(repoPath: string, message: string): Promise<boolean> {
  await git(repoPath, ["add", "-A"]);
  try {
    await git(repoPath, ["diff", "--cached", "--quiet"]);
    return false;
  } catch (error) {
    if (!(error instanceof GitError) || error.code !== 1) throw error;
  }
  await git(repoPath, ["commit", "-m", message]);
  return true;
}

export async function changedPaths(repoPath: string, ...args: string[]): Promise<string[]> {
  const output = (await git(repoPath, ["diff", "--name-only", ...args])).stdout;
  return output.split(/\r?\n/).filter(Boolean);
}

export async function statusPorcelain(repoPath: string): Promise<string> {
  return (await git(repoPath, ["status", "--porcelain", "--untracked-files=all"])).stdout;
}

export async function aheadBehind(repoPath: string, branch: string): Promise<{ ahead: number; behind: number } | undefined> {
  if (!(await remoteBranchExists(repoPath, branch))) return undefined;
  const output = (await git(repoPath, ["rev-list", "--left-right", "--count", `HEAD...origin/${branch}`])).stdout.trim();
  const [ahead, behind] = output.split(/\s+/).map(Number);
  return { ahead: ahead ?? 0, behind: behind ?? 0 };
}

export async function listConflictedPaths(repoPath: string): Promise<string[]> {
  const output = (await git(repoPath, ["diff", "--name-only", "--diff-filter=U"])).stdout;
  return output.split(/\r?\n/).filter(Boolean);
}

function runProcess(command: string, args: string[], cwd: string, timeoutMs = 30_000): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new GitError(`无法启动 ${command}: ${error.message}`, args, null, stdout, stderr));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const reason = timedOut ? `命令超时 (${timeoutMs} ms)` : stderr.trim() || `退出码 ${String(code)}`;
      reject(new GitError(`git ${args.join(" ")} 失败: ${reason}`, args, code, stdout, stderr));
    });
  });
}
