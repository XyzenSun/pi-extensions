import {
	gitCommit,
	gitFastForward,
	gitFetch,
	gitRebase,
	gitStatus,
} from "../system/git.ts";
import type { GitStatus } from "../system/git.ts";

export interface PullIntegrationPhaseOptions {
	repoPath: string;
	branch: string;
	timeoutMs: number;
	capturedLocalChanges: boolean;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
	onGitCommandStart?: (command: string, timeoutMs: number) => void;
}

export type PullIntegrationPhaseResult =
	| { kind: "rebased" }
	| { kind: "fast_forwarded"; pulled: boolean }
	| { kind: "rebase_conflict" }
	| { kind: "failed"; message: string };

export type PullWorktreePhaseResult =
	| { kind: "ready"; status: GitStatus; committedRepositoryChanges: boolean }
	| { kind: "blocked"; message: string }
	| { kind: "failed"; message: string };

export type PullCaptureCommitPhaseResult =
	| { kind: "committed" }
	| { kind: "failed"; message: string };

/** 检查并保全有未提交改动的工作区，不获取同步锁。 */
export async function preparePullWorktree(
	repoPath: string,
	status: GitStatus,
	onProgress?: (message: string) => void,
): Promise<PullWorktreePhaseResult> {
	if (status.isRebasing || status.isMerging) {
		return {
			kind: "blocked",
			message: "仓库处于 rebase/merge 状态，请先解决冲突。",
		};
	}
	if (!status.hasUncommittedChanges) {
		return { kind: "ready", status, committedRepositoryChanges: false };
	}
	try {
		onProgress?.(
			"正在执行：git commit -m pi-sync: pull 前保留仓库改动……",
		);
		await gitCommit(
			repoPath,
			"pi-sync: pull 前保留仓库改动",
		);
		return {
			kind: "ready",
			status: await gitStatus(repoPath),
			committedRepositoryChanges: true,
		};
	} catch (error) {
		return {
			kind: "failed",
			message: `pull 前无法提交仓库改动：${error instanceof Error ? error.message : "未知错误"}`,
		};
	}
}

/** 提交已捕获的本机改动，不获取同步锁。 */
export async function commitCapturedChangesBeforePull(
	repoPath: string,
	onProgress?: (message: string) => void,
): Promise<PullCaptureCommitPhaseResult> {
	try {
		onProgress?.(
			"正在执行：git commit -m pi-sync: pull 前捕获本机改动……",
		);
		await gitCommit(repoPath, "pi-sync: pull 前捕获本机改动");
		return { kind: "committed" };
	} catch (error) {
		return {
			kind: "failed",
			message: `pull 前无法提交本机改动：${error instanceof Error ? error.message : "未知错误"}`,
		};
	}
}

/** 拉取并整合已配置的 branch，不获取同步锁。 */
export async function integratePulledHead(
	options: PullIntegrationPhaseOptions,
): Promise<PullIntegrationPhaseResult> {
	const { repoPath, branch, timeoutMs, capturedLocalChanges, signal } = options;
	const timeoutSeconds = timeoutMs / 1000;
	const gitOptions = { timeout: timeoutMs, signal };
	const reportCommand = (command: string) => {
		options.onProgress?.(
			`正在执行：${command}（超时：${timeoutSeconds}s）……`,
		);
		options.onGitCommandStart?.(command, timeoutMs);
	};

	try {
		const command = "git fetch origin";
		reportCommand(command);
		await gitFetch(repoPath, gitOptions);
	} catch (error) {
		return {
			kind: "failed",
			message: `git fetch 失败：${error instanceof Error ? error.message : "未知错误"}`,
		};
	}

	if (capturedLocalChanges) {
		try {
			const command = `git rebase origin/${branch}`;
			reportCommand(command);
			const rebase = await gitRebase(repoPath, branch, gitOptions);
			return rebase.conflict
				? { kind: "rebase_conflict" }
				: { kind: "rebased" };
		} catch (error) {
			return {
				kind: "failed",
				message: `提交本机改动后 rebase 失败：${error instanceof Error ? error.message : "未知错误"}`,
			};
		}
	}

	try {
		const command = `git merge --ff-only origin/${branch}`;
		reportCommand(command);
		const { pulled } = await gitFastForward(repoPath, branch, gitOptions);
		return { kind: "fast_forwarded", pulled };
	} catch (error) {
		return {
			kind: "failed",
			message: `git 快进失败：${error instanceof Error ? error.message : "未知错误"}`,
		};
	}
}
