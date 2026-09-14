/**
 * 内置 settings adapter：settings.json 字段白名单投影 + 便携包源过滤
 *
 * 行为（design.md §2.1 + 上游 settings-portability 语义合并）：
 * - toRepository（push）：只保留白名单顶层键；packages 内仅同步便携包源
 *   （npm:/git:/https:/ssh: 等），file:/本地路径等本机源不污染共享仓库。
 * - toLocal（pull）：仓库覆盖白名单内键，保留本机白名单外键原值（合并），
 *   并把本机独有的非便携包源回填回本机 settings（不丢本地插件）。
 * - normalizeForComparison（hash）：投影到白名单 + 剥离非便携包后规范化，
 *   设备差异字段与纯本机包源变化不参与跨机比较。
 * - validate：只做包源便携性检查，判定标准复用 isPortablePackageSource，
 *   不再有第二套按前缀猜测的规则。
 *
 * 三个转换方向都强制注入插件自身包声明（见 ensureSyncPackage）：比较方向也必须注入，
 * 否则一侧有一侧无会让每次比较都判为差异。
 */
import {
	SYNC_PACKAGE_SOURCE,
	type AdapterValidationIssue,
	type FileAdapter,
} from "./adapter-runtime.ts";

// ========== 白名单清单（单一定义，三向共用，导出供测试/文档对照） ==========

/**
 * 同步（进仓库）白名单：设备无关配置偏好。
 * 白名单外顶层键（含未来 pi 新增字段）一律不进仓库、不被覆盖。
 */
export const SETTINGS_WHITELIST: readonly string[] = [
	"defaultProvider",
	"defaultModel",
	"defaultThinkingLevel",
	"thinkingBudgets",
	"theme",
	"retry",
	"compaction",
	"branchSummary",
	"warnings",
	"transport",
	"steeringMode",
	"followUpMode",
	"httpIdleTimeoutMs",
	"websocketConnectTimeoutMs",
	"enabledModels",
	"defaultTools",
	"doubleEscapeAction",
	"treeFilterMode",
	"editorPaddingX",
	"outputPad",
	"autocompleteMaxVisible",
	"showHardwareCursor",
	"markdown",
	"terminal",
	"images",
	"tuiMode",
	"fullscreenExitOutput",
	"fullscreenScrollbar",
	"packages",
];

export const SETTINGS_WHITELIST_SET: ReadonlySet<string> = new Set(
	SETTINGS_WHITELIST,
);

// ========== 工具 ==========

function parseSettings(content: Buffer): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(content.toString("utf-8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** 投影到白名单（仅保留白名单内且确实存在的键） */
export function projectToWhitelist(
	settings: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(settings).filter(([key]) => SETTINGS_WHITELIST_SET.has(key)),
	);
}

/** 取本机白名单外的键（设备相关/元数据），用于 pull 合并时保留 */
function pickNonWhitelisted(
	settings: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(settings).filter(
			([key]) => !SETTINGS_WHITELIST_SET.has(key),
		),
	);
}

/** 从包条目中取出源字符串（支持 string 与 {source} 两种形态） */
function packageSource(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		typeof (value as { source?: unknown }).source === "string"
	) {
		return (value as { source: string }).source;
	}
	return undefined;
}

/** 该包源是否可跨机同步（与上游 settings-portability 语义一致） */
export function isPortablePackageSource(source: string): boolean {
	if (typeof source !== "string" || source.length === 0) return false;
	if (/[\u0000-\u001f\u007f]/.test(source)) return false;
	if (/^(?:file:|\.\.?[\\/]|[\\/]|~[\\/])/i.test(source)) return false;
	return /^(?:npm:|git:|https?:\/\/|ssh:\/\/)/i.test(source);
}

/** 若 packages 含非便携源则返回过滤后的副本；全便携则返回 null（无需改写） */
function stripNonPortablePackages(
	settings: Record<string, unknown>,
): Record<string, unknown> | null {
	if (!Array.isArray(settings.packages)) return null;
	const portable = settings.packages.filter((entry) => {
		const source = packageSource(entry);
		return source !== undefined && isPortablePackageSource(source);
	});
	if (portable.length === settings.packages.length) return null;
	return { ...settings, packages: portable };
}

/** 保证 packages[] 含同步插件自身。缺失则追加，避免插件把自己同步没了。 */
function ensureSyncPackage(
	settings: Record<string, unknown>,
): Record<string, unknown> {
	if (!Array.isArray(settings.packages)) {
		// packages 不是数组（缺失或类型异常）时视为不存在，直接以只含自身的数组重建
		return { ...settings, packages: [SYNC_PACKAGE_SOURCE] };
	}
	const alreadyDeclared = settings.packages.some(
		(entry) => packageSource(entry) === SYNC_PACKAGE_SOURCE,
	);
	// 已存在时返回同一对象引用，让调用方的 jsonEqual 短路判断仍能识别"无改写"
	if (alreadyDeclared) return settings;
	return { ...settings, packages: [...settings.packages, SYNC_PACKAGE_SOURCE] };
}

/** 本机独有的非便携包条目（用于 pull 后回填，避免丢本地开发插件） */
function localOnlyNonPortable(
	local: Record<string, unknown>,
	remote: Record<string, unknown>,
): unknown[] {
	if (!Array.isArray(local.packages)) return [];
	const remoteList = Array.isArray(remote.packages) ? remote.packages : [];
	const seen = new Set(remoteList.map((entry) => JSON.stringify(entry)));
	return local.packages.filter((entry) => {
		const source = packageSource(entry);
		if (source === undefined || isPortablePackageSource(source)) return false;
		return !seen.has(JSON.stringify(entry));
	});
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, canonicalize(entry)]),
	);
}

/** JSON 值深等（对象键序无关） */
function jsonEqual(left: unknown, right: unknown): boolean {
	return (
		JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
	);
}

function serializePretty(settings: Record<string, unknown>): Buffer {
	return Buffer.from(`${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

// ========== Adapter 实现 ==========

export const settingsAdapter: FileAdapter = {
	/** push：白名单投影 + 剥非便携包源 + 注入自身包声明；无变化时保持原字节。 */
	toRepository(local) {
		const settings = parseSettings(local);
		if (!settings) return local;
		const projected = projectToWhitelist(settings);
		const stripped = stripNonPortablePackages(projected);
		const target = ensureSyncPackage(stripped ?? projected);
		if (jsonEqual(target, settings)) return local;
		return serializePretty(target);
	},

	/**
	 * pull：仓库覆盖白名单内键；保留本机白名单外键原值；
	 * 本机独有的非便携包源回填合并（本地开发插件不丢）。无合并需要时保持仓库原字节。
	 */
	toLocal(repo, local) {
		const remote = parseSettings(repo);
		if (!remote) return repo;
		const localParsed = parseSettings(local);
		const remoteProjected = projectToWhitelist(remote);
		const localOnly = localOnlyNonPortable(localParsed ?? {}, remoteProjected);
		const merged = ensureSyncPackage({
			...pickNonWhitelisted(localParsed ?? {}),
			...remoteProjected,
			...(localOnly.length > 0
				? {
						packages: [
							...(Array.isArray(remoteProjected.packages)
								? remoteProjected.packages
								: []),
							...localOnly,
						],
					}
				: {}),
		});
		if (jsonEqual(merged, remote)) return repo;
		return serializePretty(merged);
	},

	/** hash：投影到白名单 + 剥非便携包 + 注入自身包声明后规范化（键序无关） */
	normalizeForComparison(content) {
		const settings = parseSettings(content);
		if (!settings) return content;
		const projected = projectToWhitelist(settings);
		const stripped = stripNonPortablePackages(projected) ?? projected;
		return Buffer.from(JSON.stringify(canonicalize(ensureSyncPackage(stripped))));
	},

	/**
	 * 校验：只查包源便携性。非便携源（file:/相对路径/绝对路径/~）在别的机器上
	 * 必然指向不存在的位置，属于阻断级问题。
	 */
	validate(content) {
		const settings = parseSettings(content);
		// 非法 JSON 由 validateJson 统一报错，这里静默跳过避免重复
		if (!settings) return [];
		if (!Array.isArray(settings.packages)) return [];

		const issues: AdapterValidationIssue[] = [];
		for (const entry of settings.packages) {
			const source = packageSource(entry);
			if (source !== undefined && isPortablePackageSource(source)) continue;
			issues.push({
				message: `不可便携的包源：${source ?? JSON.stringify(entry)}。请改用 npm:/git:/https:/ssh:。`,
				severity: "error",
			});
		}
		return issues;
	},
};
