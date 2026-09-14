/**
 * 文件级 adapter 门面：供 capture / materialize / inventory 共用。
 *
 * special 语义（design.md §0 三层模型）：
 * - 仅 `special[path]` 显式声明的文件才走 adapter：字符串内置名（如 "settings"）
 *   或 { adapter } 对象；显式 "direct" 与未声明等价——退化为字节直覆盖；
 * - include 中的文件一律"仓库为权威、直接覆盖"，**不存在按文件名隐式启用的
 *   默认 adapter**（settings.json 也不例外：要白名单投影必须在 special 中声明，
 *   脚手架生成的 pi-sync.json 已带 `"settings.json": "settings"`）。
 *
 * 同一 special 声明的 adapter 解析结果缓存在进程级 Map 中（一次加载多次使用），
 * 用户 adapter 文件只在首次访问时被 import 执行。
 */
import {
	resolveAdapter,
	transformToLocal,
	transformToRepository,
	normalizeForComparisonWithAdapter,
	validateWithAdapter,
	AdapterError,
	type AdapterContext,
	type AdapterSpec,
	type AdapterValidationIssue,
	type FileAdapter,
} from "./adapter-runtime.ts";
import type { PiSyncConfig, PiSyncSpecialEntry } from "./config.ts";

export type {
	AdapterContext,
	AdapterSpec,
	AdapterValidationIssue,
	FileAdapter,
	AdapterError,
};

const adapterCache = new Map<string, FileAdapter>();

/** 清空进程内 adapter 模块缓存（测试隔离用） */
export function clearAdapterCache(): void {
	adapterCache.clear();
}

/** 该路径是否实际有 adapter（未声明 / 显式 "direct" → false） */
export function hasAdapter(
	config: PiSyncConfig,
	relativePath: string,
): boolean {
	const declaration = config.special[relativePath];
	if (declaration === undefined) return false;
	const value =
		typeof declaration === "string" ? declaration : declaration.adapter;
	return value !== "direct";
}

/** 解析并缓存 special 声明的 adapter（无 adapter → direct） */
export async function resolveFileAdapter(
	repoPath: string,
	config: PiSyncConfig,
	relativePath: string,
): Promise<AdapterSpec> {
	if (!hasAdapter(config, relativePath)) return "direct";
	return resolveAdapter(repoPath, config.special[relativePath], adapterCache);
}

/**
 * push 方向转换（capture 用）。无 adapter / direct → 原样字节。
 */
export async function applyToRepository(
	config: PiSyncConfig,
	local: Buffer,
	ctx: AdapterContext,
): Promise<Buffer> {
	if (!hasAdapter(config, ctx.filePath)) return local;
	const adapter = await resolveFileAdapter(
		ctx.repoPath,
		config,
		ctx.filePath,
	);
	return transformToRepository(local, ctx, adapter);
}

/**
 * pull 方向转换（materialize 用）。无 adapter / direct → 仓库字节原样。
 */
export async function applyToLocal(
	config: PiSyncConfig,
	repo: Buffer,
	local: Buffer,
	ctx: AdapterContext,
): Promise<Buffer> {
	if (!hasAdapter(config, ctx.filePath)) return repo;
	const adapter = await resolveFileAdapter(
		ctx.repoPath,
		config,
		ctx.filePath,
	);
	return transformToLocal(repo, local, ctx, adapter);
}

/**
 * 比较方向规范化（inventory 用）。无 adapter / direct → 原样字节。
 */
export async function applyForComparison(
	config: PiSyncConfig,
	content: Buffer,
	ctx: AdapterContext,
): Promise<Buffer> {
	if (!hasAdapter(config, ctx.filePath)) return content;
	const adapter = await resolveFileAdapter(
		ctx.repoPath,
		config,
		ctx.filePath,
	);
	return normalizeForComparisonWithAdapter(content, ctx, adapter);
}

/**
 * 校验方向（validate / apply 前预检用）。无 adapter / direct → 无问题。
 */
export async function applyValidation(
	config: PiSyncConfig,
	content: Buffer,
	ctx: AdapterContext,
): Promise<AdapterValidationIssue[]> {
	if (!hasAdapter(config, ctx.filePath)) return [];
	const adapter = await resolveFileAdapter(
		ctx.repoPath,
		config,
		ctx.filePath,
	);
	return validateWithAdapter(content, ctx, adapter);
}

export { resolveAdapter };
export type { PiSyncSpecialEntry };
