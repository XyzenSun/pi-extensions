import { cleanupOldBackups, createBackup, restoreBackup } from "../system/backup.ts";
import type { PiSyncConfig } from "../sync/config.ts";
import { executeMaterialize } from "../sync/materialize.ts";
import type { MaterializePlan } from "../sync/materialize.ts";
import type { CommandResult } from "./operation-result.ts";
import { executePackagePlan } from "../system/packages.ts";
import type {
	PackageApproval,
	PackagePlan,
	ReconcileResult,
} from "../system/packages.ts";
import { updateState } from "../system/state.ts";
import type { SyncState } from "../system/state.ts";

type Backup = Awaited<ReturnType<typeof createBackup>>;

export interface ApplyTransactionOptions {
	agentDir: string;
	commit: string;
	config: PiSyncConfig;
	state: SyncState;
	reason: string;
	plan: MaterializePlan;
	packagePlan: PackagePlan;
	packageApproval?: PackageApproval;
	/** 用户确认要移除其残留安装内容的包源。 */
	packageRemovals?: ReadonlySet<string>;
}

function failedResult(message: string): CommandResult {
	return { ok: false, code: "partial_failure", message, reload: false };
}

async function convergeWithoutFileOperations(
	options: ApplyTransactionOptions,
): Promise<CommandResult | undefined> {
	const { agentDir, commit, config, state, plan } = options;
	const hasFileOperations = plan.toWrite.length > 0 || plan.toDelete.length > 0;
	if (hasFileOperations) return undefined;

	const baselineChanged =
		plan.nextBaseline !== null &&
		JSON.stringify(plan.nextBaseline) !== JSON.stringify(state.files);
	const commitChanged = state.lastSyncedCommit !== commit;
	const branchChanged = state.branch !== config.branch;
	if (!baselineChanged && !commitChanged && !branchChanged) {
		return {
			ok: true,
			code: "noop",
			message: "pi-sync: 已是最新。",
			reload: false,
		};
	}
	if (!plan.nextBaseline) return undefined;

	await updateState(agentDir, {
		lastSyncedCommit: commit,
		lastSyncedAt: new Date().toISOString(),
		branch: config.branch,
		files: plan.nextBaseline,
		pendingOperation: null,
	});
	return {
		ok: true,
		code: "ok",
		message:
			plan.deferred.length > 0
				? `已按你的选择推迟（等待后续同步处理）：${plan.deferred.join("、")}`
				: "同步状态已更新（无需改动文件）。",
		reload: false,
	};
}

async function restoreBackupWithMessage(
	agentDir: string,
	backup: Backup,
	lines: string[],
): Promise<void> {
	try {
		await restoreBackup(agentDir, backup);
		lines.push("已回滚到应用前的状态。");
	} catch (error) {
		lines.push(
			`回滚失败：${error instanceof Error ? error.message : "未知错误"}。` +
				`请从备份手动恢复：${backup.path}`,
		);
	}
}

async function executePackages(
	packagePlan: PackagePlan,
	agentDir: string,
	packageApproval?: PackageApproval,
	packageRemovals?: ReadonlySet<string>,
): Promise<ReconcileResult> {
	try {
		return await executePackagePlan(packagePlan, agentDir, {
			approval: packageApproval,
			removals: packageRemovals,
		});
	} catch (error) {
		return {
			installed: [],
			errors: [
				`包执行发生意外失败：${error instanceof Error ? error.message : "未知错误"}`,
			],
		};
	}
}

async function recordFailedApply(
	options: ApplyTransactionOptions,
	backup: Backup,
	packageResult: ReconcileResult,
	lines: string[],
): Promise<void> {
	try {
		await updateState(options.agentDir, {
			pendingOperation: {
				type: "apply-failed",
				startedAt: new Date().toISOString(),
				context: {
					commit: options.commit,
					reason: options.reason,
					backupPath: backup.path,
					packageErrors: packageResult.errors,
				},
			},
		});
	} catch (error) {
		lines.push(
			`无法记录待处理操作：${error instanceof Error ? error.message : "未知错误"}`,
		);
	}
}

/**
 * 执行一次无冲突、已获批准的落地事务。
 * 只有文件写入与包协调都成功后，状态才会推进。
 */
export async function executeApplyTransaction(
	options: ApplyTransactionOptions,
): Promise<CommandResult> {
	const converged = await convergeWithoutFileOperations(options);
	if (converged) return converged;

	const { agentDir, commit, reason, plan, packagePlan, packageApproval } =
		options;
	const lines: string[] = [];
	let backup: Backup;
	try {
		backup = await createBackup(agentDir, commit, reason, plan);
	} catch (error) {
		return {
			...failedResult(
				`备份失败，应用已中止：${error instanceof Error ? error.message : "未知错误"}`,
			),
			details: { backupFailed: true },
		};
	}
	lines.push(`已创建备份：${backup.timestamp}`);

	const materialized = await executeMaterialize(agentDir, plan);
	if (materialized.failed.length > 0) {
		lines.push(`错误：${materialized.failed.length} 个文件应用失败。`);
		await restoreBackupWithMessage(agentDir, backup, lines);
		lines.push(
			`失败文件：${materialized.failed.map((file) => file.file).join("、")}`,
		);
		return failedResult(lines.join("\n"));
	}
	if (materialized.written.length > 0) {
		lines.push(`已写入文件：${materialized.written.length}`);
	}
	if (materialized.deleted.length > 0) {
		lines.push(`已删除文件：${materialized.deleted.length}`);
	}
	if (plan.deferred.length > 0) {
		lines.push(
			`已按你的选择推迟（等待后续同步处理）：${plan.deferred.join("、")}`,
		);
	}

	const packageResult = await executePackages(
		packagePlan,
		agentDir,
		packageApproval,
		options.packageRemovals,
	);
	if (
		packageResult.approvalRequired?.length ||
		packageResult.errors.length > 0
	) {
		lines.push(
			`错误：包安装失败：${
				packageResult.errors.join("；") ||
				packageResult.approvalRequired?.join("、") ||
				"未知错误"
			}`,
		);
		await restoreBackupWithMessage(agentDir, backup, lines);
		await recordFailedApply(options, backup, packageResult, lines);
		return failedResult(lines.join("\n"));
	}

	if (!plan.nextBaseline) {
		lines.push("错误：应用成功后未计算出基线。");
		return failedResult(lines.join("\n"));
	}
	await updateState(agentDir, {
		lastSyncedCommit: commit,
		lastSyncedAt: new Date().toISOString(),
		branch: options.config.branch,
		lastBackup: backup.timestamp,
		files: plan.nextBaseline,
		pendingOperation: null,
	});
	// 基线落盘后才回收旧备份：此前的任何失败路径都仍需要它们回滚。
	// 清理失败不影响本次 apply 的成功，因此吞掉异常。
	await cleanupOldBackups(agentDir).catch(() => undefined);
	if (packageResult.installed.length > 0) {
		lines.push(`已安装包：${packageResult.installed.join("、")}`);
	}
	if (packageResult.removed && packageResult.removed.length > 0) {
		lines.push(`已移除包：${packageResult.removed.join("、")}`);
	}
	if (packageResult.removeWarnings && packageResult.removeWarnings.length > 0) {
		lines.push(
			`警告：${packageResult.removeWarnings.join("；")}`,
		);
	}
	return { ok: true, code: "ok", message: lines.join("\n"), reload: true };
}
