/**
 * 文件清单与三方比较
 *
 * 比较三个状态：
 *   B = 上次同步基线 (state.json)
 *   L = 当前 agent 文件
 *   R = 当前 repo (sync/) 文件
 *
 * "不存在" 也作为一种值参与比较，因此可以识别创建和删除。
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import {
	isPathAllowed,
	minimatch,
	normalizePath,
} from "./glob.ts";
import type { PiSyncConfig } from "./config.ts";
import { getOperationSignal } from "../system/operation-context.ts";
import type { SyncState } from "../system/state.ts";
import {
	assertNoSymlinkComponents,
	resolveRepoSyncRoot,
} from "../system/path-safety.ts";
import { applyForComparison, hasAdapter } from "./file-adapters.ts";

// ========== 类型定义 ==========

/** 单个文件的三方比较结果 */
export type FileChangeType =
	| "no_change" // L = B, R = B
	| "local_only" // L ≠ B, R = B  → 可 capture
	| "remote_only" // L = B, R ≠ B  → 可 apply
	| "converged" // L = R, 两者均 ≠ B  → 自然收敛
	| "both_modified" // L ≠ B, R ≠ B, L ≠ R  → 冲突，停止
	| "local_created" // B 不存在, L 存在, R 不存在
	| "remote_created" // B 不存在, L 不存在, R 存在
	| "local_deleted" // B 存在, L 不存在, R = B
	| "remote_deleted" // B 存在, L = B, R 不存在
	| "both_deleted" // B 存在, L 不存在, R 不存在
	| "local_modified_remote_deleted" // B 存在, L ≠ B, R 不存在
	| "local_deleted_remote_modified"; // B 存在, L 不存在, R ≠ B

export interface FileEntry {
	/** 相对于 agent 目录（即 root）的路径 */
	relativePath: string;
	/** SHA-256 内容哈希，"absent" 表示文件不存在 */
	sha256: string;
	/** 规范化之前的 hash，用于迁移旧版 settings 基线。 */
	rawSha256?: string;
	/** 文件 mode */
	mode: number;
}

export interface FileComparison {
	relativePath: string;
	/** 变更类型 */
	changeType: FileChangeType;
	baseline: FileEntry | null;
	local: FileEntry | null;
	remote: FileEntry | null;
}

export interface InventoryResult {
	/** 所有相关文件的比较结果 */
	comparisons: FileComparison[];
	/** 分类汇总 */
	summary: {
		noChange: number;
		localOnly: number;
		remoteOnly: number;
		converged: number;
		bothModified: number;
		localCreated: number;
		remoteCreated: number;
		localDeleted: number;
		remoteDeleted: number;
	};
}

// ========== 哈希 ==========

const ABSENT_HASH = "absent";

export function sha256(content: Buffer | string): string {
	return createHash("sha256").update(content).digest("hex");
}

export async function sha256File(filePath: string): Promise<string> {
	const content = await readFile(filePath);
	return sha256(content);
}

// ========== 文件枚举 ==========

/** 返回限定某个模式匹配范围的非 glob 路径前缀。 */
function staticGlobPrefix(pattern: string): string {
	const normalized = pattern.replace(/\\/g, "/").replace(/^\/+/, "");
	const segments: string[] = [];
	for (const segment of normalized.split("/")) {
		if (segment.includes("*") || segment.includes("?")) break;
		segments.push(segment);
	}
	return segments.join("/");
}

/** 当某个模式排除了该目录及其所有可能的子项时为 true。 */
function excludesEntireTree(relativeDir: string, pattern: string): boolean {
	const normalized = pattern.replace(/\\/g, "/").replace(/^\/+/, "");
	if (!normalized.endsWith("/**")) return false;
	const treeRootPattern = normalized.slice(0, -3).replace(/\/$/, "");
	if (!treeRootPattern) return false;

	// 用去掉结尾 /** 之后的部分匹配目录，即可证明其所有子项都被排除。
	// 同时匹配完整模式，则能覆盖调用方本就位于被排除根目录之下的情况。
	return (
		minimatch(relativeDir, treeRootPattern) ||
		minimatch(relativeDir, normalized)
	);
}

/** 避免深入那些不可能产生允许文件的目录树。 */
function canContainAllowedFile(
	relativeDir: string,
	config: PiSyncConfig,
): boolean {
	if (config.exclude.some((pattern) => excludesEntireTree(relativeDir, pattern))) {
		return false;
	}

	return config.include.some((pattern) => {
		const prefix = staticGlobPrefix(pattern);
		return (
			prefix.length === 0 ||
			prefix === relativeDir ||
			prefix.startsWith(`${relativeDir}/`) ||
			relativeDir.startsWith(`${prefix}/`)
		);
	});
}

async function enumerateFiles(
	dir: string,
	baseDir: string,
	config: PiSyncConfig,
	signal?: AbortSignal,
	adapterCtx?: { agentDir: string; repoPath: string },
): Promise<FileEntry[]> {
	const entries: FileEntry[] = [];

	async function walk(currentDir: string) {
		signal?.throwIfAborted();
		if (!existsSync(currentDir)) return;

		let dirEntries;
		try {
			dirEntries = await readdir(currentDir, { withFileTypes: true });
		} catch {
			signal?.throwIfAborted();
			return;
		}

		for (const entry of dirEntries) {
			signal?.throwIfAborted();
			const fullPath = join(currentDir, entry.name);
			const relPath = normalizePath(relative(baseDir, fullPath));

			if (entry.name.startsWith(".") && entry.name !== ".gitignore") {
				continue;
			}

			const fileAllowed = isPathAllowed(
				relPath,
				config.include,
				config.exclude,
			).allowed;
			const descendantAllowed = canContainAllowedFile(relPath, config);

			if (entry.isSymbolicLink()) {
				if (fileAllowed || descendantAllowed) {
					throw new Error(`拒绝将符号链接纳入清单：${fullPath}`);
				}
				continue;
			}
			if (entry.isDirectory()) {
				if (descendantAllowed) await walk(fullPath);
				continue;
			}
			if (!entry.isFile() || !fileAllowed) continue;

			try {
				const fileStat = await stat(fullPath);
				signal?.throwIfAborted();
				if (
					adapterCtx &&
					hasAdapter(config, relPath)
				) {
					// special 文件：先做 adapter.normalizeForComparison 再算 hash，
					// 使设备差异字段不参与三方比较（避免假冲突）。
					const rawContent = await readFile(fullPath);
					signal?.throwIfAborted();
					entries.push({
						relativePath: relPath,
						sha256: sha256(
							await applyForComparison(config, rawContent, {
								agentDir: adapterCtx.agentDir,
								repoPath: adapterCtx.repoPath,
								filePath: relPath,
							}),
						),
						rawSha256: sha256(rawContent),
						mode: fileStat.mode & 0o777,
					});
				} else {
					entries.push({
						relativePath: relPath,
						sha256: await sha256File(fullPath),
						mode: fileStat.mode & 0o777,
					});
					signal?.throwIfAborted();
				}
			} catch {
				signal?.throwIfAborted();
				// 跳过无法读取的文件，保持既有的清单行为。
			}
		}
	}

	await walk(dir);
	return entries;
}

// ========== 清单生成 ==========

/**
 * 生成 agent 和 repo 的文件清单并进行三方比较
 *
 * @param agentDir Pi agent 目录
 * @param repoPath 配置仓库本地路径
 * @param config pi-sync.json 配置
 * @param state 当前同步基线
 */
export async function compareFiles(
	agentDir: string,
	repoPath: string,
	config: PiSyncConfig,
	state: SyncState,
): Promise<InventoryResult> {
	const signal = getOperationSignal();
	signal?.throwIfAborted();
	const safeRepoRoot = await resolveRepoSyncRoot(repoPath, config.root, "read");
	await assertNoSymlinkComponents(agentDir);
	signal?.throwIfAborted();
	const syncRoot = safeRepoRoot.path;

	// 在遍历过程中就应用清单过滤，使被排除的包目录树永远不会被 stat
	// 或计算 hash（在 Windows 上尤其昂贵）。
	const adapterCtx = { agentDir, repoPath };
	const [agentFiles, repoFiles] = await Promise.all([
		enumerateFiles(agentDir, agentDir, config, signal, adapterCtx),
		enumerateFiles(syncRoot, syncRoot, config, signal, adapterCtx),
	]);

	// 构建索引：相对路径 → FileEntry
	const agentIndex = new Map<string, FileEntry>();
	for (const f of agentFiles) {
		agentIndex.set(f.relativePath, f);
	}

	const repoIndex = new Map<string, FileEntry>();
	for (const f of repoFiles) {
		repoIndex.set(f.relativePath, f);
	}

	// 收集所有相关路径（白名单内的 agent 文件 + 所有 repo 文件 + 基线中已管理的文件）
	const allPaths = new Set<string>();

	// 白名单内的 agent 文件
	for (const f of agentFiles) {
		const result = isPathAllowed(
			f.relativePath,
			config.include,
			config.exclude,
		);
		if (result.allowed) {
			allPaths.add(f.relativePath);
		}
	}

	// 所有 repo sync/ 中的文件（repo 中的文件默认受白名单管理）
	for (const f of repoFiles) {
		const result = isPathAllowed(
			f.relativePath,
			config.include,
			config.exclude,
		);
		if (result.allowed) {
			allPaths.add(f.relativePath);
		}
	}

	// 基线中已管理但可能已被删除的文件
	for (const relPath of Object.keys(state.files)) {
		if (isPathAllowed(relPath, config.include, config.exclude).allowed) {
			allPaths.add(relPath);
		}
	}

	// 对每个路径进行三方比较
	const comparisons: FileComparison[] = [];

	for (const relPath of allPaths) {
		const baseline = state.files[relPath]
			? {
					relativePath: relPath,
					sha256: state.files[relPath]!.sha256,
					mode: state.files[relPath]!.mode,
				}
			: null;
		const local = agentIndex.get(relPath) ?? null;
		const remote = repoIndex.get(relPath) ?? null;

		const changeType = classifyChange(baseline, local, remote);
		comparisons.push({
			relativePath: relPath,
			changeType,
			baseline,
			local,
			remote,
		});
	}

	// 排序：变更类型优先，然后按路径
	comparisons.sort((a, b) => {
		const priorityOrder: FileChangeType[] = [
			"both_modified",
			"local_modified_remote_deleted",
			"local_deleted_remote_modified",
			"local_only",
			"remote_only",
			"local_created",
			"remote_created",
			"local_deleted",
			"remote_deleted",
			"both_deleted",
			"converged",
			"no_change",
		];
		const aIdx = priorityOrder.indexOf(a.changeType);
		const bIdx = priorityOrder.indexOf(b.changeType);
		if (aIdx !== bIdx) return aIdx - bIdx;
		return a.relativePath.localeCompare(b.relativePath);
	});

	// 汇总
	const summary = {
		noChange: 0,
		localOnly: 0,
		remoteOnly: 0,
		converged: 0,
		bothModified: 0,
		localCreated: 0,
		remoteCreated: 0,
		localDeleted: 0,
		remoteDeleted: 0,
	};

	for (const c of comparisons) {
		switch (c.changeType) {
			case "no_change":
				summary.noChange++;
				break;
			case "local_only":
				summary.localOnly++;
				break;
			case "remote_only":
				summary.remoteOnly++;
				break;
			case "converged":
				summary.converged++;
				break;
			case "both_modified":
				summary.bothModified++;
				break;
			case "local_created":
				summary.localCreated++;
				break;
			case "remote_created":
				summary.remoteCreated++;
				break;
			case "local_deleted":
				summary.localDeleted++;
				break;
			case "remote_deleted":
				summary.remoteDeleted++;
				break;
		}
	}

	return { comparisons, summary };
}

// ========== 变更分类 ==========

/**
 * 根据三方状态分类变更类型
 */
function classifyChange(
	baseline: FileEntry | null,
	local: FileEntry | null,
	remote: FileEntry | null,
): FileChangeType {
	const storedBaselineHash = baseline?.sha256 ?? ABSENT_HASH;
	const lHash = local?.sha256 ?? ABSENT_HASH;
	const rHash = remote?.sha256 ?? ABSENT_HASH;
	// 旧版 settings 基线使用原始字节。若某一侧仍与那些字节一致，
	// 则改用该侧可便携的规范化 hash 来比较基线。
	let bHash = storedBaselineHash;
	if (storedBaselineHash === local?.rawSha256) bHash = lHash;
	else if (storedBaselineHash === remote?.rawSha256) bHash = rHash;

	// 都不存在 —— 不应出现，但防止边界情况
	if (lHash === ABSENT_HASH && rHash === ABSENT_HASH && bHash === ABSENT_HASH) {
		return "no_change";
	}

	// 无变化
	if (lHash === bHash && rHash === bHash) {
		return "no_change";
	}

	// 基线中不存在的情况
	if (bHash === ABSENT_HASH) {
		if (lHash !== ABSENT_HASH && rHash === ABSENT_HASH) return "local_created";
		if (lHash === ABSENT_HASH && rHash !== ABSENT_HASH) return "remote_created";
		if (lHash !== ABSENT_HASH && rHash !== ABSENT_HASH) {
			return lHash === rHash ? "converged" : "both_modified";
		}
		// 都不存在 —— 已在上方处理
		return "no_change";
	}

	// 基线中存在的情况
	if (lHash === ABSENT_HASH && rHash === ABSENT_HASH) return "both_deleted";
	if (lHash === ABSENT_HASH && rHash === bHash) return "local_deleted";
	if (lHash === bHash && rHash === ABSENT_HASH) return "remote_deleted";
	if (lHash === ABSENT_HASH && rHash !== bHash)
		return "local_deleted_remote_modified";
	if (lHash !== bHash && rHash === ABSENT_HASH)
		return "local_modified_remote_deleted";

	// 两边都存在
	if (lHash !== bHash && rHash === bHash) return "local_only";
	if (lHash === bHash && rHash !== bHash) return "remote_only";
	if (lHash !== bHash && rHash !== bHash) {
		return lHash === rHash ? "converged" : "both_modified";
	}

	return "no_change";
}

// ========== 辅助 ==========

/** 该变更类型是否为双边冲突：两侧都相对基线发生了变化且无法自动收敛 */
export function isBilateralConflict(changeType: FileChangeType): boolean {
	return (
		changeType === "both_modified" ||
		changeType === "local_modified_remote_deleted" ||
		changeType === "local_deleted_remote_modified"
	);
}

/**
 * 检查是否存在双边修改（阻止 capture/apply 的条件）
 */
export function hasBilateralConflicts(comparisons: FileComparison[]): boolean {
	return comparisons.some((c) => isBilateralConflict(c.changeType));
}

/**
 * 检查 agent 是否有未捕获的本地修改
 */
export function hasLocalChanges(comparisons: FileComparison[]): boolean {
	return comparisons.some(
		(c) =>
			c.changeType === "local_only" ||
			c.changeType === "local_created" ||
			c.changeType === "local_deleted" ||
			c.changeType === "local_modified_remote_deleted",
	);
}

/**
 * 获取需要 capture 的文件（仅本地变更）
 */
export function getCapturableFiles(
	comparisons: FileComparison[],
): FileComparison[] {
	return comparisons.filter(
		(c) =>
			c.changeType === "local_only" ||
			c.changeType === "local_created" ||
			c.changeType === "local_deleted",
	);
}

/**
 * 获取需要 apply 的文件（仅远端/仓库变更）
 */
export function getApplicableFiles(
	comparisons: FileComparison[],
): FileComparison[] {
	return comparisons.filter(
		(c) =>
			c.changeType === "remote_only" ||
			c.changeType === "remote_created" ||
			c.changeType === "remote_deleted" ||
			c.changeType === "both_deleted" ||
			c.changeType === "converged",
	);
}
