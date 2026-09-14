import { describe, it, expect } from "vitest";
import { validateConfig } from "../src/sync/config.ts";

describe("validateConfig", () => {
	it("should accept a valid v2 config", () => {
		const raw = {
			schemaVersion: 2,
			root: "sync",
			include: ["settings.json", "AGENTS.md", "extensions/**"],
			exclude: ["**/.DS_Store"],
			delete: "tracked",
		};

		const config = validateConfig(raw);
		expect(config.schemaVersion).toBe(2);
		expect(config.root).toBe("sync");
		expect(config.include).toEqual([
			"settings.json",
			"AGENTS.md",
			"extensions/**",
		]);
		expect(config.exclude).toEqual(["**/.DS_Store"]);
		expect(config.delete).toBe("tracked");
		expect(config.pullTimeoutMs).toBe(10000);
	});

	it("should throw for unsupported schemaVersion", () => {
		expect(() =>
			validateConfig({ schemaVersion: 3, include: [], files: [] }),
		).toThrow("不支持的 schemaVersion");
	});

	it("should throw for missing include array", () => {
		expect(() =>
			validateConfig({
				schemaVersion: 2,
				include: [],
			}),
		).toThrow("include 必须是非空的 glob 模式数组");
	});

	it("should throw for include patterns with ..", () => {
		expect(() =>
			validateConfig({
				schemaVersion: 2,
				include: ["../escape"],
			}),
		).toThrow('不能包含 ".."');
	});

	it("should use default branch when not specified", () => {
		const raw = {
			schemaVersion: 2,
			include: ["settings.json"],
		};

		const config = validateConfig(raw);
		expect(config.branch).toBe("main");
	});

	it("should accept custom branch", () => {
		const raw = {
			schemaVersion: 2,
			branch: "develop",
			include: ["settings.json"],
		};

		const config = validateConfig(raw);
		expect(config.branch).toBe("develop");
	});

	it("should ignore legacy security field (customization removed it)", () => {
		const raw = {
			schemaVersion: 2,
			include: ["settings.json"],
			security: { scanSecretsBeforePush: true },
		};

		const config = validateConfig(raw);
		expect(config).not.toHaveProperty("security");
	});

	it("should use defaults for optional fields", () => {
		const raw = {
			schemaVersion: 2,
			include: ["settings.json", "extensions/**"],
		};

		const config = validateConfig(raw);
		expect(config.root).toBe("sync");
		expect(config.exclude).toEqual([]);
		expect(config.delete).toBe("tracked");
		expect(config.pullTimeoutMs).toBe(10000);
	});

	it("should accept a custom pull timeout", () => {
		const config = validateConfig({
			schemaVersion: 2,
			include: ["settings.json"],
			pullTimeoutMs: 120000,
		});

		expect(config.pullTimeoutMs).toBe(120000);
	});

	it.each([0, -1, 1.5, "30000", null])(
		"should reject invalid pull timeout %s",
		(pullTimeoutMs) => {
			expect(() =>
				validateConfig({
					schemaVersion: 2,
					include: ["settings.json"],
					pullTimeoutMs,
				}),
			).toThrow("pullTimeoutMs 必须是正整数");
		},
	);

	it("should accept exclude list", () => {
		const raw = {
			schemaVersion: 2,
			include: ["**"],
			exclude: ["**/*.tmp", "**/*.log"],
		};

		const config = validateConfig(raw);
		expect(config.exclude).toEqual(["**/*.tmp", "**/*.log"]);
	});

	// ========== special（adapter 声明） ==========

	it("should default special to empty object", () => {
		const config = validateConfig({
			schemaVersion: 2,
			include: ["settings.json"],
		});
		expect(config.special).toEqual({});
	});

	it("should accept special string declarations (direct / built-in)", () => {
		const config = validateConfig({
			schemaVersion: 2,
			include: ["settings.json"],
			special: { "settings.json": "settings", "AGENTS.md": "direct" },
		});
		expect(config.special).toEqual({
			"settings.json": "settings",
			"AGENTS.md": "direct",
		});
	});

	it("should accept special object declarations (user adapter path)", () => {
		const config = validateConfig({
			schemaVersion: 2,
			include: ["settings.json"],
			special: { "settings.json": { adapter: "./my-adapter.js" } },
		});
		expect(config.special).toEqual({
			"settings.json": { adapter: "./my-adapter.js" },
		});
	});

	it.each([
		["non-object special", { special: true }],
		["array special", { special: [] }],
		["traversing key", { special: { "../x": "direct" } }],
		["absolute key", { special: { "/x": "direct" } }],
		["empty key", { special: { "": "direct" } }],
		["invalid declaration", { special: { "a.json": 42 } }],
		["null declaration", { special: { "a.json": null } }],
		["empty adapter string", { special: { "a.json": "" } }],
		["empty object adapter", { special: { "a.json": { adapter: "" } } }],
		["non-string object adapter", { special: { "a.json": { adapter: 1 } } }],
		// 用户 adapter 路径必须留在 config-repo 内（design.md §1.1）
		["traversing user adapter (string)", { special: { "a.json": "./../evil.js" } }],
		["deep traversing user adapter (string)", { special: { "a.json": "./../../../outside/evil.js" } }],
		["traversing user adapter (object)", { special: { "a.json": { adapter: "./x/../../evil.js" } } }],
	])("should reject %s", (_name, extra) => {
		expect(() =>
			validateConfig({
				schemaVersion: 2,
				include: ["settings.json"],
				...extra,
			}),
		).toThrow("pi-sync.json");
	});

	it("should keep accepting nested user adapter paths inside the repo", () => {
		const config = validateConfig({
			schemaVersion: 2,
			include: ["a.json"],
			special: { "a.json": "./adapters/sort.js" },
		});
		expect(config.special).toEqual({ "a.json": "./adapters/sort.js" });
	});

	// ========== autoSync ==========

	it("should default autoSync to disabled with 30-minute interval", () => {
		const config = validateConfig({
			schemaVersion: 2,
			include: ["settings.json"],
		});
		expect(config.autoSync).toEqual({ enabled: false, intervalMinutes: 30 });
	});

	it("should accept an enabled autoSync with custom interval", () => {
		const config = validateConfig({
			schemaVersion: 2,
			include: ["settings.json"],
			autoSync: { enabled: true, intervalMinutes: 60 },
		});
		expect(config.autoSync).toEqual({ enabled: true, intervalMinutes: 60 });
	});

	it.each([
		["non-object autoSync", { autoSync: true }],
		["non-boolean enabled", { autoSync: { enabled: "yes" } }],
		["interval below minimum", { autoSync: { enabled: true, intervalMinutes: 1 } }],
		["non-integer interval", { autoSync: { intervalMinutes: 30.5 } }],
		["string interval", { autoSync: { intervalMinutes: "30" } }],
	])("should reject invalid autoSync: %s", (_name, extra) => {
		expect(() =>
			validateConfig({
				schemaVersion: 2,
				include: ["settings.json"],
				...extra,
			}),
		).toThrow("pi-sync.json");
	});

	it("should reject invalid root with ..", () => {
		expect(() =>
			validateConfig({
				schemaVersion: 2,
				root: "../escape",
				include: ["settings.json"],
			}),
		).toThrow("root 必须是相对路径");
	});
});
