import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withOperationSignal } from "../src/orchestration/operation-context.ts";
import {
	executePackagePlan,
	preparePackagePlan,
} from "../src/system/packages.ts";
import { createPiSyncConfig } from "./helpers/factories.ts";
import { reconcilePackages } from "./helpers/reconcile.ts";
import { withTestEnvironment } from "./helpers/temp-env.ts";

async function writeSettings(
	repoDir: string,
	agentDir: string,
	remotePackages: string[],
	localPackages: string[],
): Promise<void> {
	await mkdir(join(repoDir, "sync"), { recursive: true });
	await writeFile(
		join(repoDir, "sync/settings.json"),
		JSON.stringify({ packages: remotePackages }),
		"utf-8",
	);
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({ packages: localPackages }),
		"utf-8",
	);
}

describe.sequential("package reconciliation", () => {
	it("removes only user-confirmed leftover package sources", async () => {
		await withTestEnvironment(async (environment) => {
			const logPath = join(environment.rootDir, "pi.log");
			process.env.PI_TEST_LOG = logPath;
			await environment.writeExecutable(
				"pi",
				[
					"#!/bin/sh",
					'if [ "$1" = "--version" ]; then echo pi-test; exit 0; fi',
					'printf \'%s|%s\\n\' "$1" "$2" >> "$PI_TEST_LOG"',
					"exit 0",
				].join("\n"),
			);
			await writeSettings(
				environment.repoDir,
				environment.agentDir,
				[],
				["npm:remove-me", "npm:keep-me"],
			);
			const config = createPiSyncConfig({ include: ["settings.json"] });
			const plan = await preparePackagePlan(
				environment.repoDir,
				environment.agentDir,
				config,
			);

			expect(plan.removed.map((entry) => entry.source)).toEqual([
				"npm:remove-me",
				"npm:keep-me",
			]);
			const result = await executePackagePlan(plan, environment.agentDir, {
				removals: new Set(["npm:remove-me"]),
			});

			expect(result).toMatchObject({
				installed: [],
				errors: [],
				removed: ["npm:remove-me"],
			});
			const log = await readFile(logPath, "utf-8");
			expect(log).toContain("remove|remove-me");
			expect(log).not.toContain("remove|keep-me");
			delete process.env.PI_TEST_LOG;
		});
	});

	it("passes package sources as a single argv value without shell interpolation", async () => {
		await withTestEnvironment(async (environment) => {
			const logPath = join(environment.rootDir, "pi.log");
			const markerPath = join(environment.rootDir, "injected");
			const source = `npm:example;touch-${markerPath}`;
			process.env.PI_TEST_LOG = logPath;
			await environment.writeExecutable(
				"pi",
				[
					"#!/bin/sh",
					'if [ "$1" = "--version" ]; then echo pi-test; exit 0; fi',
					'printf \'%s|%s\\n\' "$1" "$2" >> "$PI_TEST_LOG"',
					"exit 0",
				].join("\n"),
			);
			await writeSettings(
				environment.repoDir,
				environment.agentDir,
				[source],
				[],
			);

			const result = await reconcilePackages(
				environment.repoDir,
				environment.agentDir,
				createPiSyncConfig({ include: ["settings.json"] }),
				{ approval: { approvedSources: [source] } },
			);

			expect(result).toEqual({ installed: [source], errors: [] });
			expect(await readFile(logPath, "utf-8")).toContain(`install|${source}`);
			expect(existsSync(markerPath)).toBe(false);
			delete process.env.PI_TEST_LOG;
		});
	});

	it.skipIf(process.platform === "win32")(
		"cancels an active package installation through the operation signal",
		async () => {
			await withTestEnvironment(async (environment) => {
				const source = "npm:slow-package@1";
				await environment.writeExecutable(
					"pi",
					[
						"#!/bin/sh",
						'if [ "$1" = "--version" ]; then echo pi-test; exit 0; fi',
						'if [ "$1" = "install" ]; then sleep 30; fi',
						"exit 0",
					].join("\n"),
				);
				await writeSettings(
					environment.repoDir,
					environment.agentDir,
					[source],
					[],
				);
				const controller = new AbortController();
				const startedAt = Date.now();
				const execution = withOperationSignal(controller.signal, () =>
					reconcilePackages(
						environment.repoDir,
						environment.agentDir,
						createPiSyncConfig({ include: ["settings.json"] }),
						{ approval: { approvedSources: [source] } },
					),
				);
				setTimeout(() => controller.abort(), 50);

				const result = await execution;

				expect(Date.now() - startedAt).toBeLessThan(1_000);
				expect(result.errors).toContainEqual(
					expect.stringContaining("包安装已取消"),
				);
			});
		},
	);

	it("reinstalls changed sources and reports install failures without throwing", async () => {
		await withTestEnvironment(async (environment) => {
			const logPath = join(environment.rootDir, "pi.log");
			process.env.PI_TEST_LOG = logPath;
			await environment.writeExecutable(
				"pi",
				[
					"#!/bin/sh",
					'if [ "$1" = "--version" ]; then echo pi-test; exit 0; fi',
					'printf \'%s|%s\\n\' "$1" "$2" >> "$PI_TEST_LOG"',
					'if [ "$1" = "install" ] && [ "$2" = "npm:broken@2" ]; then exit 7; fi',
					"exit 0",
				].join("\n"),
			);
			await writeSettings(
				environment.repoDir,
				environment.agentDir,
				["npm:changed@2", "npm:broken@2"],
				["npm:changed@1"],
			);

			const result = await reconcilePackages(
				environment.repoDir,
				environment.agentDir,
				createPiSyncConfig({ include: ["settings.json"] }),
				{ approval: { approvedSources: ["npm:changed@2", "npm:broken@2"] } },
			);

			expect(result.installed).toEqual(["npm:changed@2"]);
			expect(result.errors).toEqual([
				expect.stringContaining("安装 npm:broken@2 失败"),
			]);
			const log = await readFile(logPath, "utf-8");
			expect(log).toContain("install|npm:broken@2");
			expect(log).toContain("remove|broken");
			expect(log).toContain("remove|changed");
			expect(log).toContain("install|npm:changed@2");
			expect(log).toContain("install|npm:changed@1");
			expect(result.rolledBack).toEqual(
				expect.arrayContaining([
					"npm:broken@2",
					"npm:changed@2",
					"npm:changed@1",
				]),
			);
			delete process.env.PI_TEST_LOG;
		});
	});

	it("reports rollback errors when the previous package cannot be restored", async () => {
		await withTestEnvironment(async (environment) => {
			await environment.writeExecutable(
				"pi",
				[
					"#!/bin/sh",
					'if [ "$1" = "--version" ]; then echo pi-test; exit 0; fi',
					'if [ "$1" = "install" ] && [ "$2" = "npm:changed@2" ]; then exit 7; fi',
					'if [ "$1" = "install" ] && [ "$2" = "npm:changed@1" ]; then exit 8; fi',
					"exit 0",
				].join("\n"),
			);
			await writeSettings(
				environment.repoDir,
				environment.agentDir,
				["npm:changed@2"],
				["npm:changed@1"],
			);

			const result = await reconcilePackages(
				environment.repoDir,
				environment.agentDir,
				createPiSyncConfig({ include: ["settings.json"] }),
				{ approval: { approvedSources: ["npm:changed@2"] } },
			);

			expect(result.errors[0]).toContain("安装 npm:changed@2 失败");
			expect(result.rollbackErrors).toEqual([
				expect.stringContaining("恢复 npm:changed@1"),
			]);
			expect(result.errors).toContainEqual(
				expect.stringContaining("回滚失败"),
			);
		});
	});

	it("reports failed removal when a built-in package change cannot roll back", async () => {
		await withTestEnvironment(async (environment) => {
			await environment.writeExecutable(
				"pi",
				[
					"#!/bin/sh",
					'if [ "$1" = "--version" ]; then echo pi-test; exit 0; fi',
					'if [ "$1" = "remove" ]; then exit 9; fi',
					'if [ "$1" = "install" ] && [ "$2" = "npm:@xyzensun/pi-sync@2" ]; then exit 7; fi',
					"exit 0",
				].join("\n"),
			);
			await writeSettings(
				environment.repoDir,
				environment.agentDir,
				["npm:@xyzensun/pi-sync@2"],
				["npm:@xyzensun/pi-sync"],
			);

			const result = await reconcilePackages(
				environment.repoDir,
				environment.agentDir,
				createPiSyncConfig({ include: ["settings.json"] }),
				{ approval: { approvedSources: ["npm:@xyzensun/pi-sync@2"] } },
			);

			expect(result.rollbackErrors).toEqual([
				expect.stringContaining("移除 npm:@xyzensun/pi-sync@2"),
			]);
			expect(result.rolledBack).toBeUndefined();
		});
	});

	it("restores the previous source even when removing the failed package fails", async () => {
		await withTestEnvironment(async (environment) => {
			await environment.writeExecutable(
				"pi",
				[
					"#!/bin/sh",
					'if [ "$1" = "--version" ]; then echo pi-test; exit 0; fi',
					'if [ "$1" = "remove" ]; then exit 9; fi',
					'if [ "$1" = "install" ] && [ "$2" = "npm:changed@2" ]; then exit 7; fi',
					'if [ "$1" = "install" ] && [ "$2" = "npm:changed@1" ]; then exit 0; fi',
					"exit 0",
				].join("\n"),
			);
			await writeSettings(
				environment.repoDir,
				environment.agentDir,
				["npm:changed@2"],
				["npm:changed@1"],
			);

			const result = await reconcilePackages(
				environment.repoDir,
				environment.agentDir,
				createPiSyncConfig({ include: ["settings.json"] }),
				{ approval: { approvedSources: ["npm:changed@2"] } },
			);

			expect(result.rollbackErrors).toEqual([
				expect.stringContaining("移除 npm:changed@2"),
			]);
			expect(result.rolledBack).toContain("npm:changed@1");
		});
	});

	it("reports an error when the pi CLI is not available", async () => {
		await withTestEnvironment(async (environment) => {
			// Make a pi script that doesn't support --version
			await environment.writeExecutable(
				"pi",
				["#!/bin/sh", "echo 'pi: command not understood'", "exit 127"].join(
					"\n",
				),
			);
			await writeSettings(
				environment.repoDir,
				environment.agentDir,
				["npm:some-package"],
				[],
			);

			const result = await reconcilePackages(
				environment.repoDir,
				environment.agentDir,
				createPiSyncConfig({ include: ["settings.json"] }),
				{ approval: { approvedSources: ["npm:some-package"] } },
			);

			// Should gracefully report the failure, not throw
			expect(result.installed).toEqual([]);
			expect(result.errors.length).toBeGreaterThan(0);
			expect(result.errors[0]).toContain("pi CLI 不可用");
		});
	});

	it("reports an error when pi --version returns non-zero", async () => {
		await withTestEnvironment(async (environment) => {
			await environment.writeExecutable(
				"pi",
				["#!/bin/sh", "echo 'something is broken'", "exit 1"].join("\n"),
			);
			await writeSettings(
				environment.repoDir,
				environment.agentDir,
				["npm:some-package"],
				[],
			);

			const result = await reconcilePackages(
				environment.repoDir,
				environment.agentDir,
				createPiSyncConfig({ include: ["settings.json"] }),
				{ approval: { approvedSources: ["npm:some-package"] } },
			);

			expect(result.errors.length).toBeGreaterThan(0);
			expect(result.errors[0]).toContain("pi CLI 不可用");
		});
	});

	it("handles settings.json without a packages field", async () => {
		await withTestEnvironment(async (environment) => {
			await mkdir(join(environment.repoDir, "sync"), { recursive: true });
			await writeFile(
				join(environment.repoDir, "sync/settings.json"),
				JSON.stringify({ theme: "dark" }),
				"utf-8",
			);
			await writeFile(
				join(environment.agentDir, "settings.json"),
				JSON.stringify({ theme: "dark" }),
				"utf-8",
			);

			const result = await reconcilePackages(
				environment.repoDir,
				environment.agentDir,
				createPiSyncConfig({ include: ["settings.json"] }),
			);

			expect(result.installed).toEqual([]);
			expect(result.errors).toEqual([]);
		});
	});

	it("does not install packages already present locally", async () => {
		await withTestEnvironment(async (environment) => {
			const logPath = join(environment.rootDir, "pi.log");
			process.env.PI_TEST_LOG = logPath;
			await environment.writeExecutable(
				"pi",
				[
					"#!/bin/sh",
					'if [ "$1" = "--version" ]; then echo pi-test; exit 0; fi',
					'printf \'%s|%s\\n\' "$1" "$2" >> "$PI_TEST_LOG"',
					"exit 0",
				].join("\n"),
			);

			await writeSettings(
				environment.repoDir,
				environment.agentDir,
				["npm:already-installed"],
				["npm:already-installed"],
			);

			const result = await reconcilePackages(
				environment.repoDir,
				environment.agentDir,
				createPiSyncConfig({ include: ["settings.json"] }),
			);

			expect(result.installed.length).toBe(0);
			expect(result.errors.length).toBe(0);

			delete process.env.PI_TEST_LOG;
		});
	});
});
