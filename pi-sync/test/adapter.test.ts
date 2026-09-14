import { describe, it, expect } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import {
	resolveAdapter,
	transformToRepository,
	transformToLocal,
	normalizeForComparisonWithAdapter,
	validateWithAdapter,
	AdapterError,
	SYNC_PACKAGE_SOURCE,
} from "../src/sync/adapter-runtime.ts";
import type { AdapterContext, FileAdapter } from "../src/sync/adapter-runtime.ts";
import { settingsAdapter } from "../src/sync/settings-adapter.ts";
import type { PiSyncConfig } from "../src/sync/config.ts";
import { createPiSyncConfig } from "./helpers/factories.ts";

function makeConfig(special: PiSyncConfig["special"]): PiSyncConfig {
	return createPiSyncConfig({ special });
}

function makeContext(
	overrides: Partial<AdapterContext> = {},
): AdapterContext {
	return {
		agentDir: "/tmp/agent",
		repoPath: "/tmp/repo",
		filePath: "settings.json",
		...overrides,
	};
}

describe("resolveAdapter", () => {
	const cache = new Map<string, FileAdapter>();

	it("treats missing or direct declarations as direct", async () => {
		expect(await resolveAdapter("/tmp/repo", undefined, cache)).toBe("direct");
		expect(await resolveAdapter("/tmp/repo", "direct", cache)).toBe("direct");
		expect(await resolveAdapter("/tmp/repo", { adapter: "direct" }, cache)).toBe(
			"direct",
		);
	});

	it("resolves the built-in settings adapter by name", async () => {
		const adapter = await resolveAdapter("/tmp/repo", "settings", cache);
		expect(adapter).not.toBe("direct");
		expect(adapter).toMatchObject({
			toRepository: expect.any(Function),
			toLocal: expect.any(Function),
			normalizeForComparison: expect.any(Function),
			validate: expect.any(Function),
		});
	});

	it("rejects unknown adapter names", async () => {
		await expect(
			resolveAdapter("/tmp/repo", "no-such-adapter", cache),
		).rejects.toBeInstanceOf(AdapterError);
	});

	it("loads a user adapter file relative to the repo", async () => {
		const dir = await mkdtemp();
		await writeFile(
			join(dir, "my-adapter.js"),
			`export default { toRepository: (b) => Buffer.from("custom:" + b.toString("utf-8")) };`,
			"utf-8",
		);
		try {
			const adapter = await resolveAdapter(
				dir,
				{ adapter: "./my-adapter.js" },
				cache,
			);
			expect(adapter).not.toBe("direct");
			const out = await (adapter as {
				toRepository: (b: Buffer) => Buffer;
			}).toRepository(Buffer.from("x"));
			expect(out.toString("utf-8")).toBe("custom:x");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reports a clear error for a missing user adapter", async () => {
		const dir = await mkdtemp();
		try {
			await expect(
				resolveAdapter(dir, "./missing.js", cache),
			).rejects.toBeInstanceOf(AdapterError);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reports a clear error for an invalid adapter export shape", async () => {
		const dir = await mkdtemp();
		await writeFile(join(dir, "bad.js"), `export default 42;`, "utf-8");
		try {
			await expect(
				resolveAdapter(dir, "./bad.js", cache),
			).rejects.toThrow("必须导出一个对象");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("adapter three-way transforms", () => {
	const config = makeConfig({ "settings.json": "settings" });

	it("toRepository projects to whitelist only", async () => {
		const local = Buffer.from(
			JSON.stringify({
				theme: "dark",
				defaultProvider: "anthropic",
				packages: ["npm:@xyzensun/pi-sync"],
				trackingId: "secret-device-id",
				lastChangelogVersion: "0.84.2",
				sessionDir: "/tmp/xyz",
			}),
			"utf-8",
		);
		const out = await transformToRepository(
			local,
			makeContext(),
			settingsAdapter,
		);
		const parsed = JSON.parse(out.toString("utf-8"));
		expect(parsed).toEqual({
			theme: "dark",
			defaultProvider: "anthropic",
			packages: ["npm:@xyzensun/pi-sync"],
		});
	});

	it("toLocal merges remote whitelist keys over local non-whitelisted keys", async () => {
		const repo = Buffer.from(
			JSON.stringify({ theme: "light", retry: { enabled: true } }),
			"utf-8",
		);
		const local = Buffer.from(
			JSON.stringify({
				theme: "dark",
				trackingId: "local-tracker",
				sessionDir: "/home/me/sessions",
				shellPath: "/bin/zsh",
			}),
			"utf-8",
		);
		const out = await transformToLocal(repo, local, makeContext(), settingsAdapter);
		const parsed = JSON.parse(out.toString("utf-8"));
		expect(parsed).toEqual({
			theme: "light",
			retry: { enabled: true },
			trackingId: "local-tracker",
			sessionDir: "/home/me/sessions",
			shellPath: "/bin/zsh",
			// 仓库侧没有 packages 时也补上自身声明，否则本机 pull 后加载不到本扩展
			packages: [SYNC_PACKAGE_SOURCE],
		});
	});

	it("normalizeForComparison is stable across device-local key differences", async () => {
		const deviceA = Buffer.from(
			JSON.stringify({ theme: "dark", trackingId: "A", sessionDir: "/a" }),
			"utf-8",
		);
		const deviceB = Buffer.from(
			JSON.stringify({ trackingId: "B", sessionDir: "/b", theme: "dark" }),
			"utf-8",
		);
		const a = await normalizeForComparisonWithAdapter(
			deviceA,
			makeContext(),
			settingsAdapter,
		);
		const b = await normalizeForComparisonWithAdapter(
			deviceB,
			makeContext(),
			settingsAdapter,
		);
		expect(a.toString("utf-8")).toBe(b.toString("utf-8"));
	});

	it("degrades to direct bytes when the adapter lacks a function", async () => {
		const partial = { toRepository: (b: Buffer) => b };
		const out = await transformToLocal(
			Buffer.from("raw"),
			Buffer.from("local"),
			makeContext(),
			partial,
		);
		expect(out.toString("utf-8")).toBe("raw");
	});

	it("passes the adapter context through", async () => {
		let seen: AdapterContext | undefined;
		const spy = {
			normalizeForComparison: (_c: Buffer, ctx: AdapterContext) => {
				seen = ctx;
				return Buffer.from("norm");
			},
		};
		const ctx = makeContext({ filePath: "models.json", agentDir: "/a", repoPath: "/r" });
		await normalizeForComparisonWithAdapter(Buffer.from("x"), ctx, spy);
		expect(seen).toEqual(ctx);
	});
});

describe("settings adapter validation direction", () => {
	it("reports non-portable package sources as errors", async () => {
		const content = Buffer.from(
			JSON.stringify({ packages: ["file:/opt/plugin", { source: "~/dev/x" }] }),
			"utf-8",
		);
		const issues = await validateWithAdapter(
			content,
			makeContext(),
			settingsAdapter,
		);
		expect(issues).toEqual([
			{ message: expect.stringContaining("file:/opt/plugin"), severity: "error" },
			{ message: expect.stringContaining("~/dev/x"), severity: "error" },
		]);
	});

	it("accepts portable package sources in both entry shapes", async () => {
		const content = Buffer.from(
			JSON.stringify({
				packages: [
					SYNC_PACKAGE_SOURCE,
					"git:github.com/acme/tool@v1",
					{ source: "https://example.com/pkg.tgz" },
				],
			}),
			"utf-8",
		);
		expect(
			await validateWithAdapter(content, makeContext(), settingsAdapter),
		).toEqual([]);
	});

	it("stays silent on invalid JSON and on a missing packages array", async () => {
		// 非法 JSON 由 validateJson 报，这里重复报只会让用户看两遍同一个问题
		expect(
			await validateWithAdapter(
				Buffer.from("{not json", "utf-8"),
				makeContext(),
				settingsAdapter,
			),
		).toEqual([]);
		expect(
			await validateWithAdapter(
				Buffer.from(JSON.stringify({ theme: "dark" }), "utf-8"),
				makeContext(),
				settingsAdapter,
			),
		).toEqual([]);
	});

	it("returns no issues for adapters that omit the validate direction", async () => {
		const partial = { toRepository: (b: Buffer) => b };
		expect(
			await validateWithAdapter(Buffer.from("x"), makeContext(), partial),
		).toEqual([]);
		expect(
			await validateWithAdapter(Buffer.from("x"), makeContext(), "direct"),
		).toEqual([]);
	});
});

describe("settings adapter injects its own package declaration", () => {
	// 三个方向都注入，防止同步插件把自己同步没了导致再也同步不回来。
	it("adds the sync package when pushing settings that omit it", async () => {
		const local = Buffer.from(
			JSON.stringify({ theme: "dark", packages: ["npm:pi-lens"] }),
			"utf-8",
		);
		const out = await transformToRepository(local, makeContext(), settingsAdapter);
		expect(JSON.parse(out.toString("utf-8")).packages).toEqual([
			"npm:pi-lens",
			SYNC_PACKAGE_SOURCE,
		]);
	});

	it("adds the sync package when pulling settings that omit it", async () => {
		const repo = Buffer.from(
			JSON.stringify({ theme: "light", packages: ["npm:pi-lens"] }),
			"utf-8",
		);
		const out = await transformToLocal(
			repo,
			Buffer.from("{}", "utf-8"),
			makeContext(),
			settingsAdapter,
		);
		expect(JSON.parse(out.toString("utf-8")).packages).toEqual([
			"npm:pi-lens",
			SYNC_PACKAGE_SOURCE,
		]);
	});

	it("does not append a duplicate when the declaration is already present", async () => {
		for (const declared of [
			SYNC_PACKAGE_SOURCE,
			{ source: SYNC_PACKAGE_SOURCE },
		]) {
			const local = Buffer.from(
				JSON.stringify({ packages: [declared] }),
				"utf-8",
			);
			const out = await transformToRepository(
				local,
				makeContext(),
				settingsAdapter,
			);
			expect(JSON.parse(out.toString("utf-8")).packages).toEqual([declared]);
		}
	});

	it("normalizes both sides alike so a one-sided declaration is not a difference", async () => {
		// 比较方向若不注入，一侧有一侧无会让每次三方比较都判为差异
		const withPackage = Buffer.from(
			JSON.stringify({ theme: "dark", packages: [SYNC_PACKAGE_SOURCE] }),
			"utf-8",
		);
		const withoutPackage = Buffer.from(
			JSON.stringify({ theme: "dark" }),
			"utf-8",
		);
		const a = await normalizeForComparisonWithAdapter(
			withPackage,
			makeContext(),
			settingsAdapter,
		);
		const b = await normalizeForComparisonWithAdapter(
			withoutPackage,
			makeContext(),
			settingsAdapter,
		);
		expect(a.toString("utf-8")).toBe(b.toString("utf-8"));
	});
});

describe("built-in settings adapter (direct unit coverage)", () => {
	it("handles invalid JSON by falling back to raw bytes", async () => {
		const raw = Buffer.from("{not json", "utf-8");
		expect((await settingsAdapter.toRepository?.(raw, makeContext()))?.toString("utf-8")).toBe(
			"{not json",
		);
	});
});

// 示例自定义 adapter（examples/json-sort-adapter.js）端到端可用性
describe("example custom adapter (examples/json-sort-adapter.js)", () => {
	it("loads via resolveAdapter and applies three-way transforms", async () => {
		const repoDir = await mkdtemp();
		try {
			// 复制示例 adapter 到“仓库根”，模拟用户 ./xxx.js 声明
			const exampleSource = await import(
				"node:fs/promises"
			).then(({ readFile }) =>
				readFile(
					new URL("../examples/json-sort-adapter.js", import.meta.url),
					"utf-8",
				),
			);
			await writeFile(join(repoDir, "json-sort-adapter.js"), exampleSource, "utf-8");

			const cache = new Map<string, FileAdapter>();
			const adapter = await resolveAdapter(
				repoDir,
				"./json-sort-adapter.js",
				cache,
			);
			expect(adapter).not.toBe("direct");
			const ctx = makeContext({ repoPath: repoDir, filePath: "some.json" });

			// toRepository：顶层键排序
			const local = Buffer.from(JSON.stringify({ zebra: 1, alpha: 2 }, null, 2), "utf-8");
			const repo = await transformToRepository(local, ctx, adapter);
			expect(Object.keys(JSON.parse(repo.toString("utf-8")))).toEqual(["alpha", "zebra"]);

			// toLocal：仓库为准，保留本机额外键
			const localExtra = Buffer.from(
				JSON.stringify({ alpha: 2, localOnly: "keep" }, null, 2),
				"utf-8",
			);
			const applied = await transformToLocal(repo, localExtra, ctx, adapter);
			const appliedObj = JSON.parse(applied.toString("utf-8"));
			expect(appliedObj.alpha).toBe(2);
			expect(appliedObj.localOnly).toBe("keep");

			// normalizeForComparison：键序无关
			const hashA = await normalizeForComparisonWithAdapter(
				Buffer.from(JSON.stringify({ b: 1, a: 2 })),
				ctx,
				adapter,
			);
			const hashB = await normalizeForComparisonWithAdapter(
				Buffer.from(JSON.stringify({ a: 2, b: 1 })),
				ctx,
				adapter,
			);
			expect(hashA.toString("utf-8")).toBe(hashB.toString("utf-8"));
		} finally {
			await rm(repoDir, { recursive: true, force: true });
		}
	});
});

async function mkdtemp(): Promise<string> {
	const dir = join(tmpdir(), `adapter-test-${randomBytes(6).toString("hex")}`);
	await mkdir(dir, { recursive: true });
	return dir;
}

