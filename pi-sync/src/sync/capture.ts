/**
 * capture：agent → repo
 *
 * 将 agent 中的本地变更复制到配置仓库的 sync/ 目录。
 *
 * 流程：
 * 1. 扫描 agent 和 repo 的白名单文件集合
 * 2. 根据基线检测双边修改
 * 3. 双边修改时停止，不覆盖任一方
 * 4. 把仅本地修改复制到 repo
 * 5. 把 agent 中对已管理文件的删除反映到 repo
 * 6. 校验捕获结果
 */
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { PiSyncConfig } from "./config.ts";
import type { SyncState } from "../system/state.ts";
import {
	compareFiles,
	getCapturableFiles,
	isBilateralConflict,
	sha256File,
	type FileComparison,
} from "./inventory.ts";
import { normalizePath, isPathAllowed } from "./glob.ts";
import { resolveRepoSyncRoot, resolveWithinRoot } from "../system/path-safety.ts";
import { applyToRepository } from "./file-adapters.ts";

export interface CaptureResult {
	/** 已捕获的文件路径 */
	captured: string[];
	/** 已删除的文件路径 */
	deleted: string[];
	/** 用户选择保留在本机、未捕获的文件路径（存在时才填充） */
	keptLocal?: string[];
	/** 错误 */
	errors: Array<{ file: string; message: string }>;
	/** 是否有双边冲突 */
	hasConflicts: boolean;
	/** 冲突详情 */
	conflicts: FileComparison[];
}

/**
 * 仓库独有的新增：本机从来没有这个文件，只有仓库那边新建了。
 *
 * 常规 capture 从不处理它（属于 apply 方向），但整机对齐到本机时必须
 * 从仓库删掉——"远端变成本机的样子"意味着仓库多出来的东西不能留。
 *
 * 刻意只认 `remote_created`（判定表 #3：B=∅ L=∅ R=存在）。相邻两种都不是：
 * - `remote_only`（#12：B 存在 L=B R≠B）是"仓库改了本机也有的文件"，
 *   本机那份还在，该做的是用本机内容覆盖回去，走下面的捕获分支
 * - `remote_deleted`（#8）是"仓库已经删了"，没有文件可删
 */
function isRepoOnlyChange(changeType: FileComparison["changeType"]): boolean {
	return changeType === "remote_created";
}

/**
 * 将 agent 变更捕获到 repo 工作树（不访问网络、不 commit、不 push）
 */
export async function captureChanges(
	agentDir: string,
	repoPath: string,
	config: PiSyncConfig,
	state: SyncState,
	options?: {
		preferLocalOnConflicts?: boolean;
		/** 用户选择只保留在本机的文件路径：本次不捕获，保持 pending。 */
		keepLocalPaths?: ReadonlySet<string>;
		/**
		 * 整机对齐到本机（docs/tui-prd.md §4.2 的「以本机覆盖远端」）。
		 *
		 * 语义是**远端变成本机当前的样子**，因此与常规 capture 有两处不同：
		 * 1. 双边冲突不再阻断，一律取本机（隐含 preferLocalOnConflicts）
		 * 2. 白名单内仓库独有的文件会被删除——常规 capture 没有这个分支，
		 *    它只删"本机删过的已管理文件"
		 *
		 * 与 mirrorRemote 一样**不看 `config.delete`**：那个开关管的是
		 * "删除要不要跨机传播"，而整机对齐是用户在 TUI 里显式要求的一次性
		 * 动作，确认页已逐条列出待删路径。要删就真删（决策见 v0.2.0.md D10）。
		 *
		 * 边界不变：只作用于 include 白名单内的路径。
		 */
		mirrorLocal?: boolean;
	},
): Promise<CaptureResult> {
	const safeRoot = await resolveRepoSyncRoot(repoPath, config.root, "write");
	const inventory = await compareFiles(agentDir, repoPath, config, state);

	const result: CaptureResult = {
		captured: [],
		deleted: [],
		keptLocal: [],
		errors: [],
		hasConflicts: false,
		conflicts: [],
	};

	// 整机对齐到本机隐含"冲突取本机"：远端要变成本机的样子，
	// 双边冲突自然不该再阻断。
	const preferLocal =
		options?.preferLocalOnConflicts === true || options?.mirrorLocal === true;

	// 1. 检查双边冲突
	const bilateralConflicts = inventory.comparisons.filter((c) =>
		isBilateralConflict(c.changeType),
	);
	if (bilateralConflicts.length > 0 && !preferLocal) {
		result.hasConflicts = true;
		result.conflicts = bilateralConflicts;
		return result;
	}

	// 2. 处理仅本地变更。冲突分支以当前设备的版本为准，保留其完整修改。
	const capturable = preferLocal
		? inventory.comparisons.filter(
				(c) =>
					c.changeType === "local_only" ||
					c.changeType === "local_created" ||
					c.changeType === "local_deleted" ||
					isBilateralConflict(c.changeType) ||
					// 整机对齐额外要处理两类仓库侧变更，常规 capture 都不碰：
					//   remote_created → 仓库独有，删掉
					//   remote_only    → 仓库改了本机也有的文件，用本机内容盖回去
					(options?.mirrorLocal === true &&
						(isRepoOnlyChange(c.changeType) ||
							c.changeType === "remote_only")),
			)
		: getCapturableFiles(inventory.comparisons);

	for (const comp of capturable) {
		try {
			const relPath = comp.relativePath;

			// 用户选择只保留在本机的路径：不推送到共享仓库，保持 pending。
			// 双边冲突不适用（用户冲突决定优先）。
			if (
				options?.keepLocalPaths?.has(relPath) === true &&
				(comp.changeType === "local_only" ||
					comp.changeType === "local_created" ||
					comp.changeType === "local_deleted")
			) {
				(result.keptLocal ??= []).push(relPath);
				continue;
			}

			// 白名单检查
			const allowed = isPathAllowed(relPath, config.include, config.exclude);
			if (!allowed.allowed) {
				continue; // 不在白名单内，静默跳过
			}

			const repoFilePath = await resolveWithinRoot(safeRoot, relPath, "write");
			const agentFilePath = await resolveWithinRoot(agentDir, relPath, "read");

			if (
				comp.changeType === "local_deleted" ||
				comp.changeType === "local_deleted_remote_modified" ||
				// 整机对齐：仓库独有的文件要删掉，否则远端不等于本机。
				// 刻意不看 config.delete，理由见 options.mirrorLocal 的说明。
				(options?.mirrorLocal === true && isRepoOnlyChange(comp.changeType))
			) {
				// agent 中删除了，repo 中也删除
				if (existsSync(repoFilePath)) {
					await unlink(repoFilePath);
					result.deleted.push(relPath);
				}
			} else if (
				comp.changeType === "local_only" ||
				comp.changeType === "local_created" ||
				isBilateralConflict(comp.changeType) ||
				// 整机对齐：仓库单方面改过的文件，用本机内容盖回去。
				(options?.mirrorLocal === true && comp.changeType === "remote_only")
			) {
				// agent 中有新内容或修改，复制到 repo。
				// 三元组中的 local_deleted_remote_modified 已被上一分支按删除处理，
				// 走不到这里，故此处等价于 both_modified / local_modified_remote_deleted。
				if (existsSync(agentFilePath)) {
					const raw = await readFile(agentFilePath);
					// special 文件走 adapter.toRepository（如 settings 白名单投影），
					// 其余文件（含 direct）字节原样捕获。
					const content = await applyToRepository(config, raw, {
						agentDir,
						repoPath,
						filePath: relPath,
					});

					await mkdir(dirname(repoFilePath), { recursive: true });
					await writeFile(repoFilePath, content);
					result.captured.push(relPath);
				}
			}
		} catch (err) {
			result.errors.push({
				file: comp.relativePath,
				message: err instanceof Error ? err.message : "未知错误",
			});
		}
	}

	return result;
}

/**
 * 验证捕获结果的一致性
 * 确保 repo 中已捕获的文件与 agent 源文件一致
 */
export async function verifyCapture(
	agentDir: string,
	repoPath: string,
	config: PiSyncConfig,
	files: string[],
): Promise<Array<{ file: string; match: boolean; error?: string }>> {
	const safeRoot = await resolveRepoSyncRoot(repoPath, config.root, "read");
	const results: Array<{ file: string; match: boolean; error?: string }> = [];

	for (const relPath of files) {
		try {
			const normalizedPath = normalizePath(relPath);
			if (normalizedPath === "") throw new Error("路径不能为空");
			const agentPath = await resolveWithinRoot(
				agentDir,
				normalizedPath,
				"read",
			);
			const repoPath_ = await resolveWithinRoot(
				safeRoot,
				normalizedPath,
				"read",
			);

			if (!existsSync(agentPath) || !existsSync(repoPath_)) {
				results.push({
					file: relPath,
					match: false,
					error: "有一侧缺少该文件",
				});
				continue;
			}

			const agentHash = await sha256File(agentPath);
			const repoHash = await sha256File(repoPath_);
			results.push({ file: relPath, match: agentHash === repoHash });
		} catch (err) {
			results.push({
				file: relPath,
				match: false,
				error: err instanceof Error ? err.message : "未知错误",
			});
		}
	}

	return results;
}
