/**
 * pi-sync.json schema v2 读取、校验和类型定义
 *
 * 与 v1 的关键差异：
 * - root + include/exclude glob 白名单取代 files[] 逐文件映射
 * - settings.json 作为完整共享文件，不再做 managed-key merge
 * - 配置仓库不再作为 Pi Package 安装
 */
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

// ========== Schema v2 类型 ==========

export interface PiSyncConfig {
	schemaVersion: 2;
	/** Git 分支名，默认 "main" */
	branch: string;
	/** 仓库内的同步根目录，相对路径，默认 "sync" */
	root: string;
	/** Glob 白名单，相对于 root */
	include: string[];
	/** Glob 排除列表，优先级高于 include（本定制无内置 hard deny，design.md §3） */
	exclude: string[];
	/** 删除语义："tracked" 表示只删除上次同步基线中已管理的文件 */
	delete: "tracked" | "none";
	/** pull/fetch Git 操作超时时间（毫秒） */
	pullTimeoutMs: number;
	/** 例外文件映射：路径 → adapter 声明（"direct"/内置名/用户 ./x.js） */
	special: Record<string, PiSyncSpecialEntry>;
	/** 自动同步（可选，默认关闭） */
	autoSync: PiSyncAutoSync;
}

/** special 条目的声明值：字符串（direct/内置 adapter 名）或 { adapter } 对象 */
export type PiSyncSpecialEntry = string | { adapter: string };

export interface PiSyncAutoSync {
	enabled: boolean;
	/** 检查间隔（分钟），默认 30 */
	intervalMinutes: number;
}

// ========== 加载与校验 ==========

/**
 * 加载并校验 pi-sync.json（仅支持 schema v2）
 */
export async function loadPiSyncConfig(
	repoPath: string,
): Promise<PiSyncConfig> {
	const configPath = join(repoPath, "pi-sync.json");
	let raw: Record<string, unknown>;

	try {
		const content = await readFile(configPath, "utf-8");
		raw = JSON.parse(content);
	} catch {
		throw new Error(`无法读取或解析 pi-sync.json：${configPath}`);
	}

	return validateConfig(raw);
}

/**
 * 改写 pi-sync.json 的 autoSync 开关（docs/tui-prd.md §4.1 的设置项）。
 *
 * 只动 `autoSync.enabled` 一个键，其余内容按原样保留——这个文件是用户
 * 手写的，里面的键序、缩进、注释性排版都不该被工具重排。所以这里读原始
 * JSON 文本、改一个字段、再整体写回，而不是把 validateConfig 的结果
 * 序列化回去（那会丢掉未声明的字段并重排键序）。
 *
 * 写入走"临时文件 + rename"，与 state.json 一致：中途失败不会留下半个
 * 配置文件，否则下次 loadPiSyncConfig 会直接抛错。
 *
 * 注意这是**仓库文件**，改完属于一次待推送的本机改动。调用方负责决定
 * 何时把它推出去。
 */
export async function setAutoSyncEnabled(
	repoPath: string,
	enabled: boolean,
): Promise<void> {
	const configPath = join(repoPath, "pi-sync.json");
	const content = await readFile(configPath, "utf-8");
	const raw = JSON.parse(content) as Record<string, unknown>;

	const previous =
		typeof raw.autoSync === "object" && raw.autoSync !== null
			? (raw.autoSync as Record<string, unknown>)
			: {};
	raw.autoSync = { ...previous, enabled };

	// 先校验再落盘：避免把一个读不回来的配置写进仓库。
	validateConfig(raw);

	const temporaryPath = `${configPath}.${randomBytes(4).toString("hex")}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
	try {
		await rename(temporaryPath, configPath);
	} catch (error) {
		await unlink(temporaryPath).catch(() => undefined);
		throw error;
	}
}

/**
 * 校验配置对象（schema v2）
 */
export function validateConfig(raw: Record<string, unknown>): PiSyncConfig {
	const version = raw.schemaVersion;
	if (version !== 2) {
		throw new Error(
			`不支持的 schemaVersion：${version}。当前版本的 pi-sync 要求 schemaVersion 为 2。` +
				`若你使用的是 v1 配置，请迁移到新格式。`,
		);
	}

	const isUnsafeRelativePath = (value: string): boolean =>
		value.includes("\0") ||
		value.startsWith("/") ||
		value.startsWith("\\") ||
		/^[A-Za-z]:/.test(value) ||
		value.split(/[\\/]/).includes("..");

	// branch
	const branch = raw.branch ?? "main";
	if (
		typeof branch !== "string" ||
		branch.trim() === "" ||
		branch !== branch.trim() ||
		branch.startsWith("-") ||
		/[\0-\x1f\x7f]/.test(branch)
	) {
		throw new Error(
			"pi-sync.json：branch 必须是有效且非空的 git branch 名。",
		);
	}

	// root
	const root = raw.root ?? "sync";
	if (typeof root !== "string" || root === "" || isUnsafeRelativePath(root)) {
		throw new Error(
			"pi-sync.json：root 必须是相对路径，且不能包含 '..'。",
		);
	}

	const validatePattern = (
		pattern: unknown,
		field: "include" | "exclude",
	): string => {
		if (
			typeof pattern !== "string" ||
			pattern === "" ||
			isUnsafeRelativePath(pattern)
		) {
			throw new Error(
				`pi-sync.json：${field} 中的模式 "${String(pattern)}" 无效。模式必须是相对路径，且不能包含 ".."。`,
			);
		}
		return pattern;
	};

	// include
	const include = raw.include;
	if (!Array.isArray(include) || include.length === 0) {
		throw new Error(
			"pi-sync.json：include 必须是非空的 glob 模式数组。",
		);
	}
	const validatedInclude = include.map((pattern) =>
		validatePattern(pattern, "include"),
	);

	// exclude
	const exclude = raw.exclude;
	if (exclude !== undefined && !Array.isArray(exclude)) {
		throw new Error("pi-sync.json：exclude 必须是 glob 模式数组。");
	}
	const validatedExclude = (exclude ?? []).map((pattern) =>
		validatePattern(pattern, "exclude"),
	);

	// delete
	const del = raw.delete;
	if (del !== undefined && del !== "tracked" && del !== "none") {
		throw new Error('pi-sync.json：delete 必须是 "tracked" 或 "none"。');
	}

	// pull/fetch 操作的超时时间
	const pullTimeoutMs =
		raw.pullTimeoutMs === undefined ? 10000 : raw.pullTimeoutMs;
	if (
		typeof pullTimeoutMs !== "number" ||
		!Number.isInteger(pullTimeoutMs) ||
		pullTimeoutMs <= 0
	) {
		throw new Error("pi-sync.json：pullTimeoutMs 必须是正整数。");
	}

	// 定制：security 配置项已移除（无 hard deny / 无秘密扫描，design.md §3）。
	// 旧配置中的 security 字段不再校验、直接忽略。

	// special：路径 → adapter 声明（字符串或 { adapter } 对象）。
	// adapter 值若是用户文件路径（"./x.js"），必须留在 config-repo 内：pi-sync.json
	// 会同步到每台机器，若允许 ".." 逃逸，一份被改坏的清单就能让其它设备执行仓库外
	// 任意 JS（design.md §1.1 约定 adapter 位于 pi-sync.json 旁）。
	// 绝对路径不带 "./" 前缀，不会被识别为用户文件，运行时按未知内置名拒绝。
	const validateAdapterDeclaration = (
		adapter: string,
		label: string,
	): string => {
		if (adapter.trim() === "") {
			throw new Error(`pi-sync.json：${label} 必须是非空字符串。`);
		}
		if (adapter.startsWith("./") && isUnsafeRelativePath(adapter)) {
			throw new Error(
				`pi-sync.json：${label} "${adapter}" 必须留在 config-repo 内（不能包含 ".." 路径段）。`,
			);
		}
		return adapter;
	};
	const specialRaw = raw.special;
	if (
		specialRaw !== undefined &&
		(typeof specialRaw !== "object" ||
			specialRaw === null ||
			Array.isArray(specialRaw))
	) {
		throw new Error("pi-sync.json：special 必须是路径到 adapter 的映射对象。");
	}
	const special: Record<string, PiSyncSpecialEntry> = {};
	for (const [filePath, declaration] of Object.entries(specialRaw ?? {})) {
		if (isUnsafeRelativePath(filePath) || filePath === "") {
			throw new Error(
				`pi-sync.json：special 的键 "${filePath}" 必须是不含 ".." 的相对路径。`,
			);
		}
		if (typeof declaration === "string") {
			special[filePath] = validateAdapterDeclaration(
				declaration,
				`special["${filePath}"] 的 adapter 名`,
			);
		} else if (
			declaration &&
			typeof declaration === "object" &&
			!Array.isArray(declaration)
		) {
			const adapter = (declaration as { adapter?: unknown }).adapter;
			if (typeof adapter !== "string") {
				throw new Error(
					`pi-sync.json：special["${filePath}"].adapter 必须是非空字符串。`,
				);
			}
			special[filePath] = {
				adapter: validateAdapterDeclaration(
					adapter,
					`special["${filePath}"].adapter`,
				),
			};
		} else {
			throw new Error(
				`pi-sync.json：special["${filePath}"] 必须是字符串或 { adapter } 对象。`,
			);
		}
	}

	// autoSync：{ enabled, intervalMinutes }
	const autoSyncRaw = raw.autoSync;
	if (
		autoSyncRaw !== undefined &&
		(typeof autoSyncRaw !== "object" ||
			autoSyncRaw === null ||
			Array.isArray(autoSyncRaw))
	) {
		throw new Error("pi-sync.json：autoSync 必须是对象。");
	}
	const autoSyncRecord = (autoSyncRaw ?? {}) as Record<string, unknown>;
	const autoSyncEnabled = autoSyncRecord.enabled;
	if (autoSyncEnabled !== undefined && typeof autoSyncEnabled !== "boolean") {
		throw new Error("pi-sync.json：autoSync.enabled 必须是布尔值。");
	}
	const intervalMinutes =
		autoSyncRecord.intervalMinutes === undefined
			? 30
			: autoSyncRecord.intervalMinutes;
	if (
		typeof intervalMinutes !== "number" ||
		!Number.isInteger(intervalMinutes) ||
		intervalMinutes < 5
	) {
		throw new Error(
			"pi-sync.json：autoSync.intervalMinutes 必须是不小于 5 的整数（默认 30）。",
		);
	}

	return {
		schemaVersion: 2,
		branch,
		root,
		include: validatedInclude,
		exclude: validatedExclude,
		delete: (del as "tracked" | "none" | undefined) ?? "tracked",
		pullTimeoutMs,
		special,
		autoSync: {
			enabled: autoSyncEnabled ?? false,
			intervalMinutes,
		},
	};
}
