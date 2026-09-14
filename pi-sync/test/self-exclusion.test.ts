/**
 * 插件自排除（design.md §7 方案 A）单测。
 *
 * - 注册自身目录前缀后，即使 include 显式包含，该目录下文件也被剔除（hard 兜底）；
 * - 未注册时行为不变（不影响其他 extension 的同步）；
 * - 脚手架默认 exclude 含 extensions/pi-sync/**。
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
	registerSelfExclusion,
	isPathAllowed,
} from "../src/sync/glob.ts";
import { validateConfig } from "../src/sync/config.ts";

// isPathAllowed 是纯函数，hard self-exclusion 前缀是模块级状态；
// 测试后无法“注销”，因此只做只加前缀的验证，且放入独立 describe 不影响其他文件。
describe("plugin self-exclusion (design.md §7)", () => {
	beforeEach(() => {
		// 避免重复注册影响断言计数；注册本身幂等。
		registerSelfExclusion("extensions/pi-sync");
	});

	it("excludes the plugin's own directory even when include explicitly matches it", () => {
		const result = isPathAllowed("extensions/pi-sync/index.ts", ["extensions/**"], []);
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("self-exclusion");
	});

	it("excludes nested plugin files and caches", () => {
		expect(
			isPathAllowed("extensions/pi-sync/.cache/x", ["extensions/**"], []).allowed,
		).toBe(false);
		expect(
			isPathAllowed("extensions/pi-sync/src/core.ts", ["extensions/**"], []).allowed,
		).toBe(false);
	});

	it("leaves other extensions untouched", () => {
		expect(
			isPathAllowed("extensions/other-tool/index.ts", ["extensions/**"], []).allowed,
		).toBe(true);
		expect(
			isPathAllowed("extensions/pi-sync-helper/x.ts", ["extensions/**"], []).allowed,
		).toBe(true);
	});

	it("scaffold default excludes the plugin directory (extensions/pi-sync/**)", () => {
		const config = validateConfig({
			schemaVersion: 2,
			branch: "main",
			root: "sync",
			include: ["settings.json", "extensions/**"],
			exclude: ["extensions/pi-sync/**"],
			special: { "settings.json": "settings" },
			autoSync: { enabled: false, intervalMinutes: 30 },
		});
		expect(config.exclude).toContain("extensions/pi-sync/**");
		expect(
			isPathAllowed(
				"extensions/pi-sync/index.ts",
				config.include,
				config.exclude,
			).allowed,
		).toBe(false);
	});
});
