/**
 * Glob 匹配与路径规范化
 *
 * 功能：
 * - minimatch glob 匹配
 * - 路径规范化（统一为 / 分隔的相对路径）
 * - 路径安全检查（.. 逃逸、绝对路径、NUL 字符、符号链接）
 *
 * 定制（design.md §3）：已移除内置 hard deny 黑名单；是否同步完全由 include 决定。
 */

// ========== 路径规范化 ==========

/**
 * 插件自排除（design.md §7 方案 A 兑底）：插件启动时注册自身安装目录前缀，
 * 内部 include/exclude 解析前即剔除——无论 include 怎么配，插件自己不能同步自己。
 * 前缀为相对 agentDir 的路径（如 extensions/pi-sync）。
 */
const hardSelfExclusions: string[] = [];

/** 注册插件自身安装目录前缀（相对同步 agent 目录）。 */
export function registerSelfExclusion(prefix: string): void {
	const normalized = normalizePath(prefix);
	if (normalized !== "" && !hardSelfExclusions.includes(normalized)) {
		hardSelfExclusions.push(normalized);
	}
}

/** 是否命中插件自身安装目录（自身或其下任意子路径）。 */
function isSelfExcluded(relativePath: string): boolean {
	const normalized = normalizePath(relativePath);
	return hardSelfExclusions.some(
		(prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
	);
}


/**
 * 将任意路径规范化为 POSIX 风格相对路径
 * - 统一分隔符为 /
 * - 去除开头的 ./
 * - 拒绝 NUL 字符
 * - 拒绝 .. 逃逸
 * - 拒绝绝对路径
 */
export function normalizePath(input: string): string {
	if (input.includes("\0")) {
		throw new Error(`路径包含 NUL 字符：${input}`);
	}

	let normalized = input.replace(/\\/g, "/");

	// 拒绝 POSIX、UNC 和 Windows 盘符绝对路径
	if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
		throw new Error(`不允许绝对路径：${input}`);
	}

	// 拒绝 .. 逃逸
	const segments = normalized.split("/");
	for (const seg of segments) {
		if (seg === "..") {
			throw new Error(`不允许路径逃逸：${input}`);
		}
	}

	// 去除 ./ 前缀和多余的 /
	normalized = normalized.replace(/^\.\//, "");
	normalized = normalized.replace(/\/+/g, "/");
	normalized = normalized.replace(/\/$/, "");

	return normalized;
}

// ========== Minimatch Glob 匹配 ==========

/**
 * 简易 glob 匹配实现。
 *
 * 支持：
 * - *  匹配任意字符（不包括 /）
 * - ** 匹配任意字符（包括 /）
 * - ?  匹配单个字符（不包括 /）
 * - 不支持字符类 [...]
 */
export function minimatch(str: string, pattern: string): boolean {
	// 确保使用 / 分隔
	const s = str.replace(/\\/g, "/");
	let p = pattern.replace(/\\/g, "/");

	// 如果 pattern 以 / 开头，从开头精确匹配
	if (p.startsWith("/")) {
		p = p.slice(1);
	}

	return minimatchRecursive(s, 0, p, 0);
}

function minimatchRecursive(
	str: string,
	si: number,
	pattern: string,
	pi: number,
): boolean {
	// 都到了末尾
	if (si === str.length && pi === pattern.length) return true;
	// pattern 结束但字符串还有内容
	if (pi === pattern.length) return false;
	// 字符串结束但 pattern 还有内容，剩余必须全是 *
	if (si === str.length) {
		while (pi < pattern.length) {
			if (pattern[pi] === "*") {
				pi++;
				if (pi < pattern.length && pattern[pi] === "*") pi++;
			} else {
				return false;
			}
		}
		return true;
	}

	const pc = pattern[pi]!;

	// ** 匹配任意内容（包括 /）
	if (pi + 1 < pattern.length && pc === "*" && pattern[pi + 1] === "*") {
		let nextPi = pi + 2;
		if (nextPi < pattern.length && pattern[nextPi] === "/") nextPi++;

		for (let i = si; i <= str.length; i++) {
			if (minimatchRecursive(str, i, pattern, nextPi)) return true;
		}
		return false;
	}

	// * 匹配任意字符（不包括 /）
	if (pc === "*") {
		for (let i = si; i <= str.length; i++) {
			if (i > si && str[i - 1] === "/") break;
			if (minimatchRecursive(str, i, pattern, pi + 1)) return true;
		}
		return false;
	}

	// ? 匹配单个字符（但不能是 /）
	if (pc === "?") {
		if (str[si] === "/") return false;
		return minimatchRecursive(str, si + 1, pattern, pi + 1);
	}

	// 普通字符：精确匹配
	if (str[si] === pc) {
		return minimatchRecursive(str, si + 1, pattern, pi + 1);
	}

	return false;
}

// ========== 白名单文件判定 ==========

/**
 * 检查文件路径是否在白名单内。
 *
 * 优先级：manifest exclude > manifest include
 * 定制：无内置黑名单，是否同步完全由 include/exclude 决定。
 *
 * @returns { allowed: boolean, reason?: string }
 */
export function isPathAllowed(
	relativePath: string,
	include: string[],
	exclude: string[],
): { allowed: boolean; reason?: string } {
	const normalized = normalizePath(relativePath);

	// 插件自身目录兜底剔除：不依赖 include/exclude 配置。
	if (isSelfExcluded(normalized)) {
		return {
			allowed: false,
			reason: "已排除：pi-sync 插件自排除（self-exclusion）",
		};
	}

	// 检查 include 白名单
	let inInclude = false;
	for (const pattern of include) {
		if (minimatch(normalized, pattern)) {
			inInclude = true;
			break;
		}
	}

	if (!inInclude) {
		return { allowed: false, reason: "不在 include 模式中" };
	}

	// 检查 exclude 列表
	for (const pattern of exclude) {
		if (minimatch(normalized, pattern)) {
			return {
				allowed: false,
				reason: `被 exclude 排除：${pattern}`,
			};
		}
	}

	return { allowed: true };
}
