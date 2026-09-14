/**
 * Git 操作封装
 *
 * 功能：
 * - status、fetch、pull（仅 ff）、push
 * - rebase, 冲突检测
 * - commit 前 diff 生成
 * - 受限操作保护（禁止 reset --hard, clean -fd, push --force）
 *
 * v0.2: 严格错误模型
 * - gitExec 非零退出时 throw GitCommandError
 * - gitProbe 用于预期可能失败的探测（如 ls-remote、remote get-url）
 */
import { spawn, type ChildProcess } from "node:child_process";
import { getOperationSignal } from "./operation-context.ts";

const MAX_GIT_OUTPUT_BYTES = 20 * 1024 * 1024;

// ========== 类型 ==========

export interface GitStatus {
	branch: string;
	commit: string;
	commitShort: string;
	ahead: number;
	behind: number;
	hasUncommittedChanges: boolean;
	hasUnpushedCommits: boolean;
	remoteExists: boolean;
	changedFiles: string[];
	/** 是否处于 merge/rebase/冲突状态 */
	isRebasing: boolean;
	isMerging: boolean;
	hasConflicts: boolean;
	/** 冲突文件列表 */
	conflictedFiles: string[];
}

export interface GitDiff {
	path: string;
	status: "added" | "modified" | "deleted" | "renamed";
	oldPath?: string;
}

export interface GitCommandOutput {
	stdout: string;
	stderr: string;
}

export interface GitProbeOutput extends GitCommandOutput {
	ok: boolean;
}

// ========== GitCommandError ==========

export class GitCommandError extends Error {
	args: string[];
	cwd: string;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	timeoutMs?: number;

	constructor(
		args: string[],
		cwd: string,
		exitCode: number | null,
		stdout: string,
		stderr: string,
		timedOut: boolean,
		timeoutMs?: number,
	) {
		const detail = stderr || stdout || `exit code ${exitCode}`;
		const command = `git ${args.join(" ")}`;
		super(
			timedOut && timeoutMs !== undefined
				? `${command} timed out after ${timeoutMs} ms: ${detail}`
				: `${command} failed: ${detail}`,
		);
		this.name = "GitCommandError";
		this.args = args;
		this.cwd = cwd;
		this.exitCode = exitCode;
		this.stdout = stdout;
		this.stderr = stderr;
		this.timedOut = timedOut;
		this.timeoutMs = timeoutMs;
	}

	/** 是否为认证失败 */
	isAuthFailure(): boolean {
		return /Permission denied|Authentication failed|fatal: could not read from remote/i.test(
			`${this.stderr}\n${this.stdout}`,
		);
	}

	/** 是否为远端不存在 */
	isRemoteMissing(): boolean {
		return /fatal:.*remote.*not found|fatal:.*does not appear to be a git repository|fatal:.*could not read from remote/i.test(
			`${this.stderr}\n${this.stdout}`,
		);
	}

	/** 是否为分支不存在 */
	isBranchMissing(): boolean {
		return /fatal:.*branch.*not found|fatal:.*couldn't find remote ref/i.test(
			`${this.stderr}\n${this.stdout}`,
		);
	}

	/** 是否为超时 */
	isTimeout(): boolean {
		return this.timedOut;
	}
}

// ========== 环境 ==========

export function buildGitEnv(): Record<string, string | undefined> {
	const existing = process.env.GIT_SSH_COMMAND;
	const sshCmd = existing
		? `${existing} -o StrictHostKeyChecking=accept-new`
		: "ssh -o StrictHostKeyChecking=accept-new";
	return {
		...process.env,
		GIT_TERMINAL_PROMPT: "0",
		GIT_SSH_COMMAND: sshCmd,
	};
}

// ========== gitExec（严格：非零退出时 throw） ==========

export interface GitCommandOptions {
	timeout?: number;
	signal?: AbortSignal;
}

interface GitProcessFailure {
	code?: number | string | null;
	killed?: boolean;
	message?: string;
	stdout: string;
	stderr: string;
}

/**
 * 杀掉 git 及其启动的所有子进程，然后断开父进程侧的全部句柄。
 * 销毁管道是必要的：逃出进程组的后代进程否则可能让管道保持打开，
 * 使 Pi 的命令生命周期一直处于忙碌状态。
 */
function terminateGitProcessTree(child: ChildProcess): void {
	const pid = child.pid;

	// 发送信号前先停止接收输出。这样超时的完成就不再依赖于
	// git/ssh 是否正确关闭了继承来的 stdout 与 stderr。
	child.stdout?.removeAllListeners("data");
	child.stderr?.removeAllListeners("data");
	child.stdout?.destroy();
	child.stderr?.destroy();

	if (pid !== undefined) {
		if (process.platform === "win32") {
			try {
				spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
					stdio: "ignore",
					windowsHide: true,
				}).unref();
			} catch {
				// 下面还会杀掉直接子进程。
			}
		} else {
			try {
				// 下面的 detached: true 让 git 拥有自己的进程组，ssh 也包含在内。
				process.kill(-pid, "SIGKILL");
			} catch {
				// 进程可能在超时与本次调用之间就已经退出。
			}
		}
	}

	// 这在 Windows 上是必需的兜底；若上面的进程组杀灭已经成功，它也无害。
	// unref() 确保出问题的后代进程不会滞留 Pi。
	child.kill("SIGKILL");
	child.unref();
}

/**
 * 以硬性超时运行 git 进程。
 *
 * execFile 的 timeout 只杀掉它的直接子进程，随后还要等待该子进程继承的
 * stdout/stderr 句柄关闭。git 命令可能留下存活的 ssh 或 shell 后代进程，
 * 这会让一个已超时的 /pisync 命令看起来永久卡死。使用独立的进程组，
 * 我们就能杀掉整棵进程树，并在超时到期时立即 reject。
 */
function runGitProcess(
	repoPath: string,
	args: string[],
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<GitCommandOutput> {
	return new Promise((resolve, reject) => {
		let child: ChildProcess;
		try {
			child = spawn("git", args, {
				cwd: repoPath,
				env: buildGitEnv(),
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			reject(error);
			return;
		}

		let stdout = "";
		let stderr = "";
		let outputBytes = 0;
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let abort: (() => void) | undefined;

		const finish = (failure?: GitProcessFailure) => {
			if (settled) return;
			settled = true;
			if (timeout !== undefined) clearTimeout(timeout);
			if (abort !== undefined) signal?.removeEventListener("abort", abort);

			if (!failure) {
				resolve({ stdout: stdout.trimEnd(), stderr: stderr.trimEnd() });
				return;
			}
			reject(failure);
		};

		const appendOutput = (stream: "stdout" | "stderr", chunk: Buffer) => {
			if (settled) return;
			outputBytes += chunk.length;
			if (stream === "stdout") stdout += chunk.toString();
			else stderr += chunk.toString();

			if (outputBytes > MAX_GIT_OUTPUT_BYTES) {
				terminateGitProcessTree(child);
				finish({
					code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
					message: `git 输出超过 ${MAX_GIT_OUTPUT_BYTES} 字节`,
					stdout,
					stderr,
				});
			}
		};

		child.stdout?.on("data", (chunk: Buffer) => appendOutput("stdout", chunk));
		child.stderr?.on("data", (chunk: Buffer) => appendOutput("stderr", chunk));
		child.once("error", (error) =>
			finish({
				code: (error as NodeJS.ErrnoException).code,
				message: error.message,
				stdout,
				stderr,
			}),
		);
		child.once("close", (code, signal) => {
			if (code === 0) {
				finish();
				return;
			}
			finish({
				code,
				message: signal ? `git 被 ${signal} 终止` : undefined,
				stdout,
				stderr,
			});
		});

		abort = () => {
			terminateGitProcessTree(child);
			finish({
				code: "ABORT_ERR",
				killed: true,
				message: "git 操作已取消",
				stdout,
				stderr,
			});
		};
		if (signal?.aborted) {
			abort();
			return;
		}
		signal?.addEventListener("abort", abort, { once: true });

		timeout = setTimeout(() => {
			terminateGitProcessTree(child);
			finish({
				code: "ETIMEDOUT",
				killed: true,
				message: `git timed out after ${timeoutMs} ms`,
				stdout,
				stderr,
			});
		}, timeoutMs);
	});
}

export async function gitExec(
	repoPath: string,
	args: string[],
	options?: GitCommandOptions,
): Promise<GitCommandOutput> {
	const timeoutMs = options?.timeout ?? 30000;
	const signal = options?.signal ?? getOperationSignal();
	try {
		return await runGitProcess(repoPath, args, timeoutMs, signal);
	} catch (err: unknown) {
		const error = err as Partial<GitProcessFailure>;
		const timedOut = error.code === "ETIMEDOUT";
		throw new GitCommandError(
			args,
			repoPath,
			typeof error.code === "number" ? error.code : null,
			error.stdout?.trimEnd() ?? "",
			error.stderr?.trimEnd() ?? error.message ?? "未知的 git 错误",
			timedOut,
			timeoutMs,
		);
	}
}

// ========== gitProbe（探测用，不 throw） ==========

/**
 * 运行 Git 命令进行探测（预期可能失败，不 throw）。
 * 用于 ls-remote、remote get-url、rev-list --count（空仓库）等场景。
 */
export async function gitProbe(
	repoPath: string,
	args: string[],
	options?: GitCommandOptions,
): Promise<GitProbeOutput> {
	try {
		const result = await gitExec(repoPath, args, options);
		return { ...result, ok: true };
	} catch (err) {
		if (err instanceof GitCommandError) {
			return { stdout: err.stdout, stderr: err.stderr, ok: false };
		}
		throw err;
	}
}

// ========== Status ==========

export async function gitStatus(
	repoPath: string,
	trackingBranch?: string,
): Promise<GitStatus> {
	const [branchResult, commitResult, statusResult, rebaseResult] =
		await Promise.all([
			gitExec(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
			gitExec(repoPath, ["rev-parse", "HEAD"]),
			gitExec(repoPath, ["status", "--porcelain"]),
			gitExec(repoPath, ["rev-parse", "--git-dir"])
				.then(async (r) => {
					const gitDir = r.stdout.trim();
					const { existsSync: es } = await import("node:fs");
					const { join: j } = await import("node:path");
					return {
						rebasing:
							es(j(repoPath, gitDir, "rebase-merge")) ||
							es(j(repoPath, gitDir, "rebase-apply")),
						merging: es(j(repoPath, gitDir, "MERGE_HEAD")),
					};
				})
				.catch(() => ({ rebasing: false, merging: false })),
		]);

	const branch = branchResult.stdout.trim();
	const commit = commitResult.stdout.trim();
	const trackedBranch = trackingBranch ?? branch;
	const commitShort = commit.substring(0, 7);
	const hasUncommittedChanges = statusResult.stdout.trim().length > 0;

	const changedFiles = statusResult.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => line.substring(3).trim());

	// 冲突文件列表
	const conflictedFiles: string[] = [];
	for (const line of statusResult.stdout.split("\n").filter(Boolean)) {
		if (
			line.startsWith("UU ") ||
			line.startsWith("AA ") ||
			line.startsWith("DD ")
		) {
			conflictedFiles.push(line.substring(3).trim());
		}
	}

	const hasConflicts = conflictedFiles.length > 0;

	// 远端信息（使用 probe，因为可能无 origin）
	let remoteExists = false;
	let ahead = 0;
	let behind = 0;

	const remoteProbe = await gitProbe(repoPath, ["remote", "get-url", "origin"]);
	remoteExists = remoteProbe.ok && remoteProbe.stdout.trim().length > 0;

	if (remoteExists) {
		const revListProbe = await gitProbe(repoPath, [
			"rev-list",
			"--left-right",
			"--count",
			`${trackedBranch}...origin/${trackedBranch}`,
		]);

		if (revListProbe.ok) {
			const counts = revListProbe.stdout.trim().split(/\s+/);
			if (counts.length === 2) {
				ahead = Number.parseInt(counts[0]!, 10) || 0;
				behind = Number.parseInt(counts[1]!, 10) || 0;
			}
		} else {
			// origin/branch 可能尚不存在
			remoteExists = false;
		}
	}

	return {
		branch,
		commit,
		commitShort,
		ahead,
		behind,
		hasUncommittedChanges,
		hasUnpushedCommits: ahead > 0,
		remoteExists,
		changedFiles,
		isRebasing: rebaseResult.rebasing,
		isMerging: rebaseResult.merging,
		hasConflicts,
		conflictedFiles,
	};
}

/**
 * 切换到已配置的同步 branch；当只存在 origin/<branch> 时，创建本地跟踪分支。
 * 是否需要先 fetch 由调用方决定。
 */
export async function ensureConfiguredBranch(
	repoPath: string,
	branch: string,
): Promise<boolean> {
	const branchFormat = await gitProbe(repoPath, [
		"check-ref-format",
		"--branch",
		branch,
	]);
	if (!branchFormat.ok) {
		throw new Error(`已配置的同步 branch "${branch}" 无效。`);
	}

	const status = await gitStatus(repoPath);
	if (status.branch === branch) return false;

	const localRef = await gitProbe(repoPath, [
		"show-ref",
		"--verify",
		`refs/heads/${branch}`,
	]);
	if (localRef.ok) {
		await gitExec(repoPath, ["switch", branch]);
		return true;
	}

	const remoteRef = await gitProbe(repoPath, [
		"show-ref",
		"--verify",
		`refs/remotes/origin/${branch}`,
	]);
	if (!remoteRef.ok) {
		throw new Error(
			`已配置的同步 branch "${branch}" 在本机与 origin 上都不存在。`,
		);
	}
	await gitExec(repoPath, [
		"switch",
		"--track",
		"-c",
		branch,
		`origin/${branch}`,
	]);
	return true;
}

// ========== Diff ==========

export async function gitDiff(repoPath: string): Promise<string> {
	const result = await gitExec(repoPath, ["diff", "HEAD"]);
	return result.stdout;
}

export async function gitDiffRange(
	repoPath: string,
	from: string,
	to: string,
): Promise<string> {
	const result = await gitExec(repoPath, ["diff", from, to]);
	return result.stdout;
}

export async function gitDiffFiles(
	repoPath: string,
	from: string,
	to: string,
): Promise<GitDiff[]> {
	const result = await gitExec(repoPath, ["diff", "--name-status", from, to]);

	return result.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const parts = line.split(/\t/);
			const statusCode = parts[0]!;
			const statusMap: Record<string, GitDiff["status"]> = {
				A: "added",
				M: "modified",
				D: "deleted",
				R: "renamed",
			};
			return {
				path: parts.length > 2 ? parts[2]! : parts[1]!,
				status: statusMap[statusCode[0]!] ?? "modified",
				oldPath: parts.length > 2 ? parts[1] : undefined,
			};
		});
}

// ========== Fetch / Pull / Push ==========

export async function gitFetch(
	repoPath: string,
	options?: GitCommandOptions,
): Promise<void> {
	await gitExec(repoPath, ["fetch", "origin"], options);
}

/**
 * 用已经 fetch 到的远端跟踪 ref 快进当前 branch。
 * 这里有意使用 merge 而非 pull：pull 会在 gitFetch() 之后再次联系 origin，
 * 可能重复一次缓慢的 SSH/认证握手。
 */
export async function gitFastForward(
	repoPath: string,
	branch: string,
	options?: GitCommandOptions,
): Promise<{ pulled: boolean }> {
	const result = await gitExec(
		repoPath,
		["merge", "--ff-only", `origin/${branch}`],
		options,
	);
	const pulled =
		!result.stdout.includes("Already up to date") &&
		!result.stdout.includes("Already up-to-date");
	return { pulled };
}

export async function gitPush(repoPath: string, branch: string): Promise<void> {
	await gitExec(repoPath, ["push", "--set-upstream", "origin", branch]);
}

/**
 * 将 HEAD 作为本设备的远端快照发布。force-with-lease 允许设备替换
 * 自己此前的旧快照，同时仍拒绝覆盖在最近一次 fetch 之后发生变化的 ref。
 */
export async function gitPushHeadToBranch(
	repoPath: string,
	branch: string,
): Promise<void> {
	await gitExec(repoPath, [
		"push",
		"--force-with-lease",
		"origin",
		`HEAD:refs/heads/${branch}`,
	]);
}

/** 将已存在的本地设备分支发布为其远端快照。 */
export async function gitPushDeviceBranch(
	repoPath: string,
	branch: string,
): Promise<void> {
	await gitExec(repoPath, [
		"push",
		"--force-with-lease",
		"--set-upstream",
		"origin",
		branch,
	]);
}

export async function gitRenameBranch(
	repoPath: string,
	branch: string,
): Promise<void> {
	await gitExec(repoPath, ["branch", "-M", branch]);
}

// ========== Rebase ==========

/**
 * 对 origin/<branch> 执行 rebase
 * @returns 是否发生冲突
 */
export async function gitRebase(
	repoPath: string,
	branch: string,
	options?: GitCommandOptions,
): Promise<{ rebased: boolean; conflict: boolean }> {
	try {
		const result = await gitExec(
			repoPath,
			["rebase", `origin/${branch}`],
			options,
		);
		const combined = `${result.stderr}\n${result.stdout}`;

		if (/CONFLICT/i.test(combined)) {
			return { rebased: false, conflict: true };
		}

		const rebased =
			!combined.includes("Current branch") ||
			!combined.includes("is up to date");

		return { rebased, conflict: false };
	} catch (err) {
		// rebase 可能因冲突而退出非零，检查输出
		if (err instanceof GitCommandError) {
			const combined = `${err.stderr}\n${err.stdout}`;
			if (/CONFLICT/i.test(combined)) {
				return { rebased: false, conflict: true };
			}
		}
		throw err;
	}
}

/**
 * 中止 rebase
 */
export async function gitRebaseAbort(repoPath: string): Promise<void> {
	await gitExec(repoPath, ["rebase", "--abort"]);
}

// ========== Commit ==========

export async function gitCommit(
	repoPath: string,
	message: string,
): Promise<void> {
	const before = await getHeadCommit(repoPath).catch(() => "");
	await gitExec(repoPath, ["add", "-A"]);

	try {
		await gitExec(repoPath, ["commit", "-m", message]);
	} catch (err) {
		if (err instanceof GitCommandError) {
			const combined = `${err.stderr}\n${err.stdout}`;
			// "nothing to commit" 不是错误 —— 它表示没有改动
			if (/nothing to commit|no changes added to commit/i.test(combined)) {
				return;
			}
		}
		throw err;
	}

	const after = await getHeadCommit(repoPath).catch(() => "");
	if (after === "" || after === before) {
		throw new GitCommandError(
			["commit", "-m", message],
			repoPath,
			null,
			"",
			"没有创建任何 commit",
			false,
		);
	}
}

// ========== 查询 ==========

export async function getHeadCommit(repoPath: string): Promise<string> {
	const result = await gitExec(repoPath, ["rev-parse", "HEAD"]);
	return result.stdout.trim();
}

export async function hasUncommittedChanges(
	repoPath: string,
): Promise<boolean> {
	const result = await gitExec(repoPath, ["status", "--porcelain"]);
	return result.stdout.trim().length > 0;
}

export async function canFastForward(
	repoPath: string,
	local: string,
	remote: string,
): Promise<boolean> {
	const result = await gitProbe(repoPath, [
		"merge-base",
		"--is-ancestor",
		local,
		remote,
	]);
	return result.ok;
}

export async function isDiverged(
	repoPath: string,
	local: string,
	remote: string,
): Promise<boolean> {
	const [localIsAncestor, remoteIsAncestor] = await Promise.all([
		canFastForward(repoPath, local, remote),
		canFastForward(repoPath, remote, local),
	]);
	return !localIsAncestor && !remoteIsAncestor;
}

/**
 * 检查是否有未合并的文件
 */
export async function hasUnmergedPaths(repoPath: string): Promise<boolean> {
	return (await listUnmergedPaths(repoPath)).length > 0;
}

export interface GitUnmergedPath {
	relativePath: string;
	stages: number[];
}

/** 列出索引中未解决的路径，以及每个路径可用的 stage 编号。 */
export async function listUnmergedEntries(
	repoPath: string,
): Promise<GitUnmergedPath[]> {
	const result = await gitExec(repoPath, ["ls-files", "--unmerged", "-z"]);
	const entries = new Map<string, Set<number>>();
	for (const entry of result.stdout.split("\0")) {
		if (!entry) continue;
		const tab = entry.indexOf("\t");
		const metadata = tab >= 0 ? entry.slice(0, tab) : "";
		const relativePath = tab >= 0 ? entry.slice(tab + 1) : "";
		const stage = Number(metadata.split(/\s+/)[2]);
		if (!relativePath || !Number.isInteger(stage)) continue;
		const stages = entries.get(relativePath) ?? new Set<number>();
		stages.add(stage);
		entries.set(relativePath, stages);
	}
	return [...entries.entries()]
		.map(([relativePath, stages]) => ({
			relativePath,
			stages: [...stages].sort((a, b) => a - b),
		}))
		.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/** 列出索引中存在未解决条目的、相对工作区的去重路径。 */
export async function listUnmergedPaths(repoPath: string): Promise<string[]> {
	return (await listUnmergedEntries(repoPath)).map(
		(entry) => entry.relativePath,
	);
}

/**
 * 检查工作树是否干净（无 staged 或 unstaged 变更）
 */
export async function isWorktreeClean(repoPath: string): Promise<boolean> {
	return !(await hasUncommittedChanges(repoPath));
}

/**
 * 获取当前操作状态（rebase/merge 等）
 */
export async function getGitOperationState(repoPath: string): Promise<{
	isRebasing: boolean;
	isMerging: boolean;
	hasConflicts: boolean;
}> {
	const { existsSync: es } = await import("node:fs");
	const { join: j } = await import("node:path");
	const gitDirProbe = await gitProbe(repoPath, ["rev-parse", "--git-dir"]);
	const gitDir = gitDirProbe.ok ? gitDirProbe.stdout.trim() : ".git";

	return {
		isRebasing:
			es(j(repoPath, gitDir, "rebase-merge")) ||
			es(j(repoPath, gitDir, "rebase-apply")),
		isMerging: es(j(repoPath, gitDir, "MERGE_HEAD")),
		hasConflicts: await hasUnmergedPaths(repoPath),
	};
}

// ========== Push 流程步骤 ==========

/**
 * 检查 origin 是否可达且目标分支是否存在。
 * 用于 push 时提前检测 "no upstream"。
 */
export async function gitRemoteRefExists(
	repoPath: string,
	branch: string,
): Promise<boolean> {
	const probe = await gitProbe(repoPath, [
		"ls-remote",
		"--heads",
		"origin",
		branch,
	]);
	return probe.ok && probe.stdout.trim().length > 0;
}
