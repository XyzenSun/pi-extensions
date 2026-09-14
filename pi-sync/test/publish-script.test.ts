import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { withTestEnvironment } from "./helpers/temp-env.ts";

const publishScript = join(process.cwd(), "scripts", "publish.mjs");

async function setUpPackage(
	environment: Parameters<typeof withTestEnvironment>[0] extends (
		environment: infer T,
	) => Promise<unknown>
		? T
		: never,
) {
	await environment.writeExecutable(
		"npm",
		[
			"#!/bin/sh",
			'echo "$@" >> "$NPM_LOG"',
			'if [ "$1" = "view" ]; then',
			'  case "$NPM_VIEW_RESULT" in',
			'    published) echo "0.0.1" ;;',
			'    missing) echo "npm error code E404" >&2; exit 1 ;;',
			'    *) echo "npm error code E503" >&2; exit 1 ;;',
			"  esac",
			"fi",
		].join("\n"),
	);
	await environment.writeRepoFile(
		"package.json",
		JSON.stringify({ name: "example-package", version: "0.0.1" }),
	);
}

function publish(
	environment: { repoDir: string; rootDir: string },
	viewResult: string,
) {
	const logPath = join(environment.rootDir, "npm.log");
	return {
		result: spawnSync(process.execPath, [publishScript, "patch"], {
			cwd: environment.repoDir,
			encoding: "utf8",
			env: { ...process.env, NPM_LOG: logPath, NPM_VIEW_RESULT: viewResult },
		}),
		logPath,
	};
}

describe("publish.mjs", () => {
	it("publishes an unpublished current version without incrementing it", async () => {
		await withTestEnvironment(async (environment) => {
			await setUpPackage(environment);
			const { result, logPath } = publish(environment, "missing");

			expect(result.status).toBe(0);
			expect(result.stdout).toContain(
				"example-package@0.0.1 is not published; publishing it without incrementing.",
			);
			expect((await readFile(logPath, "utf8")).trim().split("\n")).toEqual([
				"view example-package@0.0.1 version --json",
				"publish --access public",
			]);
		});
	});

	it("increments the version when the current version is already published", async () => {
		await withTestEnvironment(async (environment) => {
			await setUpPackage(environment);
			const { result, logPath } = publish(environment, "published");

			expect(result.status).toBe(0);
			expect(result.stdout).toContain(
				"example-package@0.0.1 is already published; incrementing patch.",
			);
			expect((await readFile(logPath, "utf8")).trim().split("\n")).toEqual([
				"view example-package@0.0.1 version --json",
				"version patch",
				"publish --access public",
			]);
		});
	});

	it("fails instead of guessing when the registry check is unavailable", async () => {
		await withTestEnvironment(async (environment) => {
			await setUpPackage(environment);
			const { result, logPath } = publish(environment, "unavailable");

			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("Could not determine whether");
			expect((await readFile(logPath, "utf8")).trim().split("\n")).toEqual([
				"view example-package@0.0.1 version --json",
			]);
		});
	});
});
