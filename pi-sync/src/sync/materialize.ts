/**
 * materialize：repo → agent
 *
 * 将仓库 sync/ 目录中的文件应用到 Pi agent 目录。
 *
 * 功能：
 * - 原子单文件写入（临时文件 → fsync → rename）
 * - 支持创建、更新和删除（仅 tracked 文件）
 * - 完整备份与失败回滚
 * - 全部预校验后再执行
 *
 * v0.2: nextBaseline — 按最终预期状态构建完整基线，而非按实际写入列表增量合并
 */
import {
	readFile,
	writeFile,
	rename,
	mkdir,
	unlink,
	stat as fsStat,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { hasConflictMarkers, validateJson } from "./validate.ts";
import type { PiSyncConfig } from "./config.ts";
import type { SyncState, BaselineEntry } from "../system/state.ts";
import {
	compareFiles,
	getApplicableFiles,
	isBilateralConflict,
	sha256File,
	type FileComparison,
	type InventoryResult,
} from "./inventory.ts";
import { resolveRepoSyncRoot, resolveWithinRoot } from "../system/path-safety.ts";
import { applyToLocal, applyValidation, hasAdapter } from "./file-adapters.ts";

// ========== 类型定义 ==========

export interface MaterializeWrite {
	relativePath: string;
	content: Buffer;
	mode: number;
}

export interface MaterializePlan {
	/** 要创建/更新的文件 */
	toWrite: MaterializeWrite[];
	/** 要删除的文件 */
	toDelete: string[];
	/** 用户选择推迟到下次同步的远端变更路径 */
	deferred: string[];
	/** 冲突文件 */
	conflicts: FileComparison[];
	/** 预校验错误 */
	validationErrors: Array<{
		file: string;
		message: string;
		severity: "error" | "warning";
	}>;
	/** 是否有阻断性错误（冲突或校验错误） */
	blocked: boolean;
	/** 成功应用后的完整基线（如果 blocked 则为 null） */
	nextBaseline: Record<string, BaselineEntry> | null;
	/** 是否有状态变更（包括纯基线收敛、无文件 I/O 的情况） */
	hasStateChanges: boolean;
}

export interface MaterializeOptions {
	/** 解决冲突过程中，明确选用共享远端版本的冲突路径。 */
	useRemoteForConflicts?: ReadonlySet<string>;
	/** 用户推迟的远端路径；它们会保持 pending，直到之后某次同步。 */
	deferApplyPaths?: ReadonlySet<string>;
	/** 预先计算好的清单，可复用（需同一 agentDir/repoPath/config/state）。 */
	inventory?: InventoryResult;
	/**
	 * 整机对齐到远端（docs/tui-prd.md §4.2 的「以远端覆盖本机」）。
	 *
	 * 语义是**完全复刻远端**，因此与常规 apply 有三处不同：
	 * 1. 双边冲突不再阻断，一律取远端
	 * 2. 白名单内本机独有的文件会被删除——它们不在基线里，常规删除分支够不到
	 * 3. **不看 `config.delete`**：那个开关管的是"删除要不要跨机传播"，
	 *    而整机对齐是用户在 TUI 里显式要求的一次性动作，且确认页已逐条
	 *    列出将删除的路径。要删就真删，否则结果不可预期（PRD §4.2）。
	 *
	 * 边界不变：只作用于 include 白名单内的路径。白名单外的文件从不进入
	 * 三方比较，因此这里也永远看不到它们。
	 */
	mirrorRemote?: boolean;
}

export interface MaterializeResult {
	/** 成功写入的文件 */
	written: string[];
	/** 成功删除的文件 */
	deleted: string[];
	/** 跳过的文件 */
	skipped: string[];
	/** 失败的文件 */
	failed: Array<{ file: string; reason: string }>;
}

// ========== 原子写入 ==========

/**
 * 原子写入文件：
 * 1. 写入同目录临时文件
 * 2. 设置 mode
 * 3. rename 到目标路径
 */
export async function atomicWrite(
	targetPath: string,
	content: Buffer | string,
	mode?: number,
): Promise<void> {
	const targetDir = dirname(targetPath);
	await mkdir(targetDir, { recursive: true });

	const tmpName = `.${basename(targetPath)}.${randomBytes(4).toString("hex")}.tmp`;
	const tmpPath = join(targetDir, tmpName);

	const buffer =
		typeof content === "string" ? Buffer.from(content, "utf-8") : content;
	await writeFile(tmpPath, buffer, { mode: mode ?? 0o644 });

	try {
		await rename(tmpPath, targetPath);
	} catch {
		// rename 失败时清理临时文件
		try {
			await unlink(tmpPath);
		} catch {
			/* 忽略 */
		}
		throw new Error(`重命名失败：${tmpName} → ${basename(targetPath)}`);
	}
}

// ========== 计划生成 ==========

/**
 * 生成 apply 计划：列出需要创建、更新、删除的文件，并构建完整 nextBaseline
 */
export async function planMaterialize(
	agentDir: string,
	repoPath: string,
	config: PiSyncConfig,
	state: SyncState,
	options: MaterializeOptions = {},
): Promise<MaterializePlan> {
	const safeRoot = await resolveRepoSyncRoot(repoPath, config.root, "read");
	const inventory =
		options.inventory ?? (await compareFiles(agentDir, repoPath, config, state));
	const deferApplyPaths = options.deferApplyPaths;

	// 整机对齐到远端：把**所有有差异的路径**都标记为"取远端版本"。
	//
	// 复用 useRemoteForConflicts 这一条通道，而不是新加分支——它的既有语义
	// 恰好就是"这些路径以远端为准"，且两个方向都已处理好：
	//   远端有该文件 → 写入远端版本；远端没有 → 删除本机文件。
	// 于是"本机改了"取远端内容、"本机新建"被删掉，都自然落位。
	const forcedRemotePaths = options.mirrorRemote
		? new Set<string>([
				...(options.useRemoteForConflicts ?? []),
				...inventory.comparisons
					.filter(
						(comparison) =>
							comparison.changeType !== "no_change" &&
							comparison.changeType !== "converged",
					)
					.map((comparison) => comparison.relativePath),
			])
		: options.useRemoteForConflicts;
	const useRemoteForConflicts = forcedRemotePaths;

	const plan: MaterializePlan = {
		toWrite: [],
		toDelete: [],
		deferred: [],
		conflicts: [],
		validationErrors: [],
		blocked: false,
		nextBaseline: null,
		hasStateChanges: false,
	};

	// 收集冲突
	plan.conflicts = inventory.comparisons.filter(
		(c) =>
			isBilateralConflict(c.changeType) &&
			!useRemoteForConflicts?.has(c.relativePath),
	);

	if (plan.conflicts.length > 0) {
		plan.blocked = true;
		return plan;
	}

	// 获取需要 apply 的变更
	const applicable = inventory.comparisons.filter(
		(comp) =>
			getApplicableFiles([comp]).length > 0 ||
			useRemoteForConflicts?.has(comp.relativePath) === true,
	);

	for (const comp of applicable) {
		const relPath = comp.relativePath;

		// 用户选择推迟的远端变更：本次不落地，保持 pending 直到下次同步。
		// 冲突路径经 useRemoteForConflicts 选定远程版本时是更明确的决定，优先于推迟。
		const explicitlyResolved = useRemoteForConflicts?.has(relPath) === true;
		const deferrable =
			comp.changeType === "remote_created" ||
			comp.changeType === "remote_only" ||
			comp.changeType === "remote_deleted" ||
			comp.changeType === "both_deleted";
		if (
			!explicitlyResolved &&
			deferrable &&
			deferApplyPaths?.has(relPath) === true
		) {
			plan.deferred.push(relPath);
			continue;
		}

		const useRemoteForConflict = useRemoteForConflicts?.has(relPath) === true;
		if (
			comp.changeType === "remote_created" ||
			comp.changeType === "remote_only" ||
			(useRemoteForConflict && comp.remote !== null)
		) {
			// repo 中有新文件或更新的文件 → 写回 agent
			const repoFilePath = await resolveWithinRoot(safeRoot, relPath, "read");
			if (existsSync(repoFilePath)) {
				try {
					let content: Buffer = await readFile(repoFilePath);
					const fileStat = await fsStat(repoFilePath);

					// 冲突标记检查
					const contentStr = content.toString("utf-8");
					if (hasConflictMarkers(contentStr)) {
						plan.validationErrors.push({
							file: relPath,
							message: "包含 git 冲突标记",
							severity: "error",
						});
					}

					// JSON 校验
					if (relPath.endsWith(".json")) {
						const jsonErrors = validateJson(relPath, contentStr);
						plan.validationErrors.push(...jsonErrors);
					}

					// special 声明的 adapter 自行决定校验规则（按 special 分派，与下方
					// toLocal 的分派方式一致）；无 adapter 的文件不做内容语义校验。
					plan.validationErrors.push(
						...(
							await applyValidation(config, content, {
								agentDir,
								repoPath,
								filePath: relPath,
							})
						).map((issue) => ({ ...issue, file: relPath })),
					);

					// special 文件走 adapter.toLocal（如 settings 仓库白名单覆盖本机、
					// 保留本机白名单外键），adapter 需要本机现有内容做合并，因此只有
					// 这类文件才读本机文件；普通 include 文件（含 direct）是"仓库为权威、
					// 直接覆盖"（design.md §0），不读本机文件——避免本机同名路径是目录
					// 或不可读时在这里误报，破坏原本由 backup 阶段负责的失败处理。
					if (hasAdapter(config, relPath)) {
						const localFilePath = await resolveWithinRoot(
							agentDir,
							relPath,
							"read",
						);
						const localRaw = existsSync(localFilePath)
							? await readFile(localFilePath)
							: Buffer.alloc(0);
						content = await applyToLocal(config, content, localRaw, {
							agentDir,
							repoPath,
							filePath: relPath,
						});
					}

					plan.toWrite.push({
						relativePath: relPath,
						content,
						mode: fileStat.mode & 0o777,
					});
				} catch (err) {
					plan.validationErrors.push({
						file: relPath,
						message: `无法读取：${err instanceof Error ? err.message : "未知错误"}`,
						severity: "error",
					});
				}
			}
		} else if (
			(comp.changeType === "remote_deleted" ||
				comp.changeType === "both_deleted" ||
				(useRemoteForConflict && comp.remote === null)) &&
			// 整机对齐绕开 delete 开关与"基线须有记录"这两道限制：
			// 前者管的是"删除要不要跨机传播"，后者够不到本机新建的文件。
			// 这是用户在 TUI 里显式要求的一次性对齐，确认页已逐条列出待删路径。
			(options.mirrorRemote === true ||
				(config.delete === "tracked" && state.files[relPath]))
		) {
			// repo 中删除了已管理的文件 → agent 中也删除
			plan.toDelete.push(relPath);
		}
		// converged / no_change: 不产生文件 I/O，但需要更新基线
	}

	// 判断是否被阻断
	const blockingErrors = plan.validationErrors.filter(
		(e) => e.severity === "error",
	);
	if (blockingErrors.length > 0) {
		plan.blocked = true;
		return plan;
	}

	// 构建完整 nextBaseline（按最终预期状态）
	plan.nextBaseline = await buildNextBaseline(
		inventory,
		state,
		useRemoteForConflicts,
		deferApplyPaths,
	);
	plan.hasStateChanges = true;

	return plan;
}

// ========== nextBaseline 构建 ==========

/**
 * 构建成功 apply 后的完整基线。
 *
 * 规则：
 * - no_change、converged、remote_only、remote_created：
 *   以 repo 文件的 hash/mode 进入基线
 * - remote_deleted、both_deleted：从基线移除
 * - 用户推迟的远端变更：保留旧基线条目，使其在下次同步时重新被检测
 * - 冲突项：不生成 baseline（计划 blocked）
 * - 不在 include 中的文件：永不进入 baseline
 */
export async function buildNextBaseline(
	inventory: { comparisons: FileComparison[] },
	state: SyncState,
	useRemoteForConflicts?: ReadonlySet<string>,
	deferApplyPaths?: ReadonlySet<string>,
): Promise<Record<string, BaselineEntry>> {
	const baseline: Record<string, BaselineEntry> = {};

	for (const comp of inventory.comparisons) {
		const relPath = comp.relativePath;

		// 用户选中的远端版本即成为新基线，即使 apply 前的清单
		// 仍将其描述为双边变更。
		if (useRemoteForConflicts?.has(relPath)) {
			if (comp.remote) {
				baseline[relPath] = {
					sha256: comp.remote.sha256,
					mode: comp.remote.mode,
				};
			}
			continue;
		}

		// 用户推迟的远端变更：保留旧基线，使其保持 pending。
		if (
			deferApplyPaths?.has(relPath) === true &&
			(comp.changeType === "remote_created" ||
				comp.changeType === "remote_only" ||
				comp.changeType === "remote_deleted" ||
				comp.changeType === "both_deleted")
		) {
			if (state.files[relPath]) baseline[relPath] = state.files[relPath]!;
			continue;
		}

		switch (comp.changeType) {
			case "no_change":
			case "converged":
			case "remote_only":
			case "remote_created":
				// 以 repo 文件（最终期望状态）的 hash/mode 进入 baseline
				if (comp.remote) {
					baseline[relPath] = {
						sha256: comp.remote.sha256,
						mode: comp.remote.mode,
					};
				} else if (comp.local) {
					// remote 不存在但 local 存在且应该保持一致（converged）
					baseline[relPath] = {
						sha256: comp.local.sha256,
						mode: comp.local.mode,
					};
				} else if (state.files[relPath]) {
					// 两边都不存在但基线有记录 → 保持原基线（不应发生）
					baseline[relPath] = state.files[relPath]!;
				}
				break;

			case "remote_deleted":
			case "both_deleted":
				// 从基线中移除（不添加）
				break;

			case "local_only":
			case "local_created":
			case "local_deleted":
				// 这些是 capture 方向的操作，apply 中不应出现
				// 如果出现，保持现有基线
				if (state.files[relPath]) {
					baseline[relPath] = state.files[relPath]!;
				}
				break;

			case "both_modified":
			case "local_modified_remote_deleted":
			case "local_deleted_remote_modified":
				// 冲突情况，不应在成功计划中出现
				break;
		}
	}

	return baseline;
}

// ========== 执行 ==========

/**
 * 执行 materialize 计划
 *
 * @returns 执行结果
 */
export async function executeMaterialize(
	agentDir: string,
	plan: MaterializePlan,
): Promise<MaterializeResult> {
	const result: MaterializeResult = {
		written: [],
		deleted: [],
		skipped: [],
		failed: [],
	};

	// 1. 写入文件
	for (const item of plan.toWrite) {
		try {
			const targetPath = await getSafeAgentPath(agentDir, item.relativePath);
			await atomicWrite(targetPath, item.content, item.mode);
			result.written.push(item.relativePath);
		} catch (err) {
			result.failed.push({
				file: item.relativePath,
				reason: err instanceof Error ? err.message : "未知错误",
			});
		}
	}

	// 2. 删除文件
	for (const relPath of plan.toDelete) {
		try {
			const targetPath = await getSafeAgentPath(agentDir, relPath);
			if (existsSync(targetPath)) {
				await unlink(targetPath);
				result.deleted.push(relPath);
			} else {
				result.skipped.push(relPath);
			}
		} catch (err) {
			result.failed.push({
				file: relPath,
				reason: err instanceof Error ? err.message : "未知错误",
			});
		}
	}

	return result;
}

// ========== 辅助函数 ==========

async function getSafeAgentPath(
	agentDir: string,
	relativePath: string,
): Promise<string> {
	return resolveWithinRoot(agentDir, relativePath, "write");
}

/**
 * 从 agent 目录读取文件并计算基线 hash
 */
export async function readAgentFile(
	agentDir: string,
	relativePath: string,
): Promise<{ content: Buffer; sha256: string; mode: number } | null> {
	const fullPath = await getSafeAgentPath(agentDir, relativePath);
	if (!existsSync(fullPath)) return null;

	const content = await readFile(fullPath);
	const fileStat = await fsStat(fullPath);

	return {
		content,
		sha256: await sha256File(fullPath),
		mode: fileStat.mode & 0o777,
	};
}
