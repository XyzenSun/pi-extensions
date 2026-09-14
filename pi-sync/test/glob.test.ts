import { describe, expect, it } from "vitest";
import {
	isPathAllowed,
	minimatch,
	normalizePath,
} from "../src/sync/glob.ts";

describe("normalizePath", () => {
	it("normalizes Windows separators, leading dot segments, duplicate separators, and trailing separators", () => {
		expect(normalizePath("./skills\\review//prompt.md/")).toBe(
			"skills/review/prompt.md",
		);
	});

	it.each([
		"/etc/passwd",
		"\\\\server\\share\\secret",
		"C:\\Users\\agent\\settings.json",
		"C:/Users/agent/settings.json",
		"../escape",
		"skills/../escape",
		"settings.json\0.tmp",
	])("rejects unsafe path %j", (path) => {
		expect(() => normalizePath(path)).toThrow();
	});
});

describe("glob matching and precedence", () => {
	it("matches nested paths without treating a single-star pattern as recursive", () => {
		expect(minimatch("skills/review/SKILL.md", "skills/**/SKILL.md")).toBe(
			true,
		);
		expect(minimatch("skills/review/SKILL.md", "skills/*.md")).toBe(false);
		expect(minimatch("themes/a.json", "themes/?.json")).toBe(true);
	});

	it("matches root-level files with a recursive prefix", () => {
		expect(minimatch("settings.json", "**/settings.json")).toBe(true);
	});

	it("gives exclude precedence over include; no built-in deny exists", () => {
		// 无内置黑名单，auth.json 只要在 include 中即可通过
		expect(isPathAllowed("auth.json", ["**"], [])).toMatchObject({
			allowed: true,
		});
		expect(
			isPathAllowed(
				"extensions/demo/node_modules/pkg/index.js",
				["extensions/**"],
				[],
			),
		).toMatchObject({ allowed: true });
		expect(
			isPathAllowed("extensions/debug.log", ["extensions/**"], ["**/*.log"]),
		).toMatchObject({
			allowed: false,
			reason: "被 exclude 排除：**/*.log",
		});
		expect(
			isPathAllowed("prompts/review.md", ["extensions/**"], []),
		).toMatchObject({
			allowed: false,
			reason: "不在 include 模式中",
		});
	});

	it("filters allowlisted files without a deny concept", () => {
		expect(
			isPathAllowed(
				"skills/review/SKILL.md",
				["skills/**", "themes/**", "auth.json"],
				["**/*.log"],
			),
		).toEqual({ allowed: true });
		expect(
			isPathAllowed("skills/tmp.log", ["skills/**", "themes/**"], ["**/*.log"]),
		).toMatchObject({ allowed: false });
	});
});
