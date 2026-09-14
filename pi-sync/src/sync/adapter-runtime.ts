/**
 * Adapter 运行时：加载与分发 special 文件的自定义转换逻辑
 *
 * 架构（design.md §1）：
 * - special[file] 的声明值解析：字符串 "direct" / 内置 adapter 名（如 "settings"）
 *   或对象 { adapter: "settings" | "./x.js" }
 * - 用户 adapter 是 pi-sync.json 旁的 JS 文件（相对路径解析），导出一个可选三函数
 *   对象（toRepository/toLocal/normalizeForComparison），缺省函数退化为 direct
 * - 用户适配器优先于内置：同名时显式 "./x.js" 路径声明的用户文件覆盖内置实现
 *
 * 同步调用约定（design.md §4 patch 表）：
 *   push 方向（capture）   → transformToRepository(local, ctx, adapter)
 *   pull 方向（materialize）→ transformToLocal(repo, local, ctx, adapter)
 *   三方比较（inventory）  → normalizeForComparisonWithAdapter(content, ctx, adapter)
 *   校验方向（validate/apply 前）→ validateWithAdapter(content, ctx, adapter)
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PiSyncSpecialEntry } from "./config.ts";

/** 同步插件自身的 npm 包源。settings adapter 保证它始终在 packages[] 中，
    否则某台机器 pull 后加载不到本扩展，就再也无法同步回来。 */
export const SYNC_PACKAGE_SOURCE = "npm:@xyzensun/pi-sync";

/** adapter 报告的单条同步适用性问题（file 字段由调用方按当前路径补齐） */
export interface AdapterValidationIssue {
	message: string;
	severity: "error" | "warning";
}

export interface FileAdapter {
	/** 推送：本机内容 → 仓库内容（剥离设备相关/隐私） */
	toRepository?(
		local: Buffer,
		ctx: AdapterContext,
	): Buffer | Promise<Buffer>;
	/** 拉取：仓库内容 → 本机内容（回填设备相关字段） */
	toLocal?(
		repo: Buffer,
		local: Buffer,
		ctx: AdapterContext,
	): Buffer | Promise<Buffer>;
	/** 比较：规范化后内容，用于三方 hash（两设备差异不产生假冲突） */
	normalizeForComparison?(
		content: Buffer,
		ctx: AdapterContext,
	): Buffer | Promise<Buffer>;
	/** 校验：返回该文件的同步适用性问题（空数组表示无问题） */
	validate?(
		content: Buffer,
		ctx: AdapterContext,
	): AdapterValidationIssue[] | Promise<AdapterValidationIssue[]>;
}

export interface AdapterContext {
	/** Pi agent 目录（~/.pi/agent） */
	agentDir: string;
	/** config-repo 本地路径 */
	repoPath: string;
	/** 相对路径（如 settings.json），相对 agent 目录 / repo sync root */
	filePath: string;
}

export type AdapterSpec = "direct" | FileAdapter;

interface NormalizedDeclaration {
	value: string;
	userPath?: string;
}

/**
 * 规范化 special 声明。返回 null 表示未声明或显式 "direct"（两者都按 direct 处理）。
 * 形如 "./x.js"（含 ./ 前缀）视为用户 adapter 文件；其余视为内置 adapter 名。
 */
function normalizeDeclaration(
	declaration: PiSyncSpecialEntry | undefined,
): NormalizedDeclaration | null {
	if (declaration === undefined) return null;
	const value =
		typeof declaration === "string" ? declaration : declaration.adapter;
	if (value === "direct") return null;
	return { value, userPath: value.startsWith("./") ? value : undefined };
}

export class AdapterError extends Error {
	constructor(
		message: string,
		readonly filePath: string,
		readonly adapterName: string,
	) {
		super(message);
		this.name = "AdapterError";
	}
}

/** 内置 adapter 注册表。settings 内置实现惰性 import（见 settings-adapter.ts）。 */
const DEFAULT_ADAPTERS = new Map<string, () => Promise<FileAdapter>>([
	["settings", () => import("./settings-adapter.ts").then((m) => m.settingsAdapter)],
]);

function cacheKeyFor(declaration: NormalizedDeclaration): string {
	return declaration.userPath ?? `builtin:${declaration.value}`;
}

/**
 * 解析 special 声明为可执行 adapter：
 * - direct / 未声明 → "direct"（字节原样）
 * - 用户 "./x.js" → 加载 pi-sync.json 旁的 JS 文件（带模块缓存）
 * - 内置名 → 内置实现；未知名 → AdapterError
 */
export async function resolveAdapter(
	repoPath: string,
	declaration: PiSyncSpecialEntry | undefined,
	moduleCache: Map<string, FileAdapter>,
): Promise<AdapterSpec> {
	const normalized = normalizeDeclaration(declaration);
	if (!normalized) return "direct";

	const cacheKey = cacheKeyFor(normalized);
	const cached = moduleCache.get(cacheKey);
	if (cached) return cached;

	if (normalized.userPath) {
		// 用户 adapter 只接受 "./x.js" 形式（normalizeDeclaration 已保证），且
		// config.ts 校验时已拒绝 ".." 与绝对路径，因此这里总是相对 repoPath 解析。
		const filePath = join(repoPath, normalized.userPath);
		try {
			const imported = (await import(pathToFileURL(filePath).href)) as {
				default?: unknown;
			};
			const mod = imported.default ?? imported;
			if (!mod || typeof mod !== "object" || Array.isArray(mod)) {
				throw new AdapterError(
					`自定义 adapter ${normalized.userPath} 必须导出一个对象，其中可选包含 toRepository/toLocal/normalizeForComparison 函数。`,
					normalized.userPath,
					normalized.value,
				);
			}
			const adapter = mod as Record<string, unknown>;
			for (const fn of [
				"toRepository",
				"toLocal",
				"normalizeForComparison",
				"validate",
			] as const) {
				const candidate = adapter[fn];
				if (candidate !== undefined && typeof candidate !== "function") {
					throw new AdapterError(
						`自定义 adapter ${normalized.userPath} 导出的 "${fn}" 必须是函数。`,
						normalized.userPath,
						normalized.value,
					);
				}
			}
			const fileAdapter = mod as FileAdapter;
			moduleCache.set(cacheKey, fileAdapter);
			return fileAdapter;
		} catch (error) {
			if (error instanceof AdapterError) throw error;
			throw new AdapterError(
				`加载自定义 adapter ${normalized.userPath} 失败：${error instanceof Error ? error.message : "未知错误"}`,
				normalized.userPath,
				normalized.value,
			);
		}
	}

	const loader = DEFAULT_ADAPTERS.get(normalized.value);
	if (!loader) {
		throw new AdapterError(
			`未知的 adapter "${normalized.value}"。支持："settings" 或 "./relative-adapter.js" 形式的路径。`,
			normalized.value,
			normalized.value,
		);
	}
	const adapter = await loader();
	moduleCache.set(cacheKey, adapter);
	return adapter;
}

// ========== 三向转换入口（缺省退化 direct） ==========

/** push 方向：本机内容 → 仓库内容（缺省 / direct：字节原样） */
export async function transformToRepository(
	local: Buffer,
	ctx: AdapterContext,
	adapter: AdapterSpec,
): Promise<Buffer> {
	if (adapter === "direct") return local;
	const fn = adapter.toRepository;
	return fn ? fn(local, ctx) : local;
}

/** pull 方向：仓库内容 → 本机内容（缺省 / direct：仓库字节原样覆盖） */
export async function transformToLocal(
	repo: Buffer,
	local: Buffer,
	ctx: AdapterContext,
	adapter: AdapterSpec,
): Promise<Buffer> {
	if (adapter === "direct") return repo;
	const fn = adapter.toLocal;
	return fn ? fn(repo, local, ctx) : repo;
}

/** 比较方向：三方 hash 的规范化内容（缺省 / direct：原样字节） */
export async function normalizeForComparisonWithAdapter(
	content: Buffer,
	ctx: AdapterContext,
	adapter: AdapterSpec,
): Promise<Buffer> {
	if (adapter === "direct") return content;
	const fn = adapter.normalizeForComparison;
	return fn ? fn(content, ctx) : content;
}

/** 校验方向：adapter 报告的同步适用性问题（缺省 / direct：不校验） */
export async function validateWithAdapter(
	content: Buffer,
	ctx: AdapterContext,
	adapter: AdapterSpec,
): Promise<AdapterValidationIssue[]> {
	if (adapter === "direct") return [];
	const fn = adapter.validate;
	return fn ? fn(content, ctx) : [];
}
