import { gitFetch, gitRebase, gitRemoteRefExists } from "../system/git.ts";

export interface PushIntegrationPhaseOptions {
	repoPath: string;
	branch: string;
}

export type PushIntegrationPhaseResult =
	| { kind: "ready_to_push" }
	| { kind: "rebase_conflict" }
	| { kind: "failed"; message: string };

/** 对已提交的 push 执行 fetch 与 rebase，不获取同步锁。 */
export async function integrateCommittedPush(
	options: PushIntegrationPhaseOptions,
): Promise<PushIntegrationPhaseResult> {
	const { repoPath, branch } = options;
	try {
		await gitFetch(repoPath);
	} catch (error) {
		return {
			kind: "failed",
			message: `本机提交后 git fetch 失败：${error instanceof Error ? error.message : "未知错误"}。本机提交已保留。`,
		};
	}

	if (!(await gitRemoteRefExists(repoPath, branch))) {
		return { kind: "ready_to_push" };
	}
	try {
		const rebase = await gitRebase(repoPath, branch);
		return rebase.conflict
			? { kind: "rebase_conflict" }
			: { kind: "ready_to_push" };
	} catch (error) {
		return {
			kind: "failed",
			message: `rebase 失败：${error instanceof Error ? error.message : "未知错误"}`,
		};
	}
}
