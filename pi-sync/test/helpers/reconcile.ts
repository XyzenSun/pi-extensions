/**
 * 测试辅助：包同步的 prepare → execute 组合。
 *
 * 产品代码中已删除 reconcilePackages 这层薄封装，用例改为直接串联
 * preparePackagePlan + executePackagePlan（即原封装的内部实现），
 * 以保持既有断言不变。
 */
import {
	executePackagePlan,
	preparePackagePlan,
	type PackageApproval,
	type ReconcileResult,
} from "../../src/system/packages.ts";
import type { PiSyncConfig } from "../../src/sync/config.ts";

export interface ReconcileTestOptions {
	approval?: PackageApproval;
	signal?: AbortSignal;
}

export async function reconcilePackages(
	repoPath: string,
	agentDir: string,
	config: PiSyncConfig,
	options: ReconcileTestOptions = {},
): Promise<ReconcileResult> {
	const plan = await preparePackagePlan(repoPath, agentDir, config);
	return executePackagePlan(plan, agentDir, {
		approval: options.approval,
		signal: options.signal,
	});
}
