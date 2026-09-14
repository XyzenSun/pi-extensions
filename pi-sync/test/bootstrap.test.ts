import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withTestEnvironment } from "./helpers/temp-env.ts";

describe("bootstrap.sh", () => {
	const bootstrapPath = join(process.cwd(), "scripts", "bootstrap.sh");

	it("has valid bash syntax", () => {
		const result = spawnSync("bash", ["-n", bootstrapPath], {
			encoding: "utf-8",
		});
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});

	it("contains essential setup commands", () => {
		const content = readFileSync(bootstrapPath, "utf-8");

		// Should reference essential paths and commands
		expect(content).toContain("pi-git-sync");
		expect(content).toContain("config-repo");
		// Should use set -euo pipefail for safety
		expect(content).toContain("set -euo pipefail");
		// Should not contain risky eval patterns
		expect(content).not.toMatch(/\beval\b/);
	});

	it("exits gracefully when git is not available", async () => {
		await withTestEnvironment(async (environment) => {
			// Create a PATH without git
			const fakeBin = join(environment.rootDir, "no-git-bin");
			await mkdir(fakeBin, { recursive: true });

			// Write a fake pi (but no git)
			await environment.writeExecutable(
				"pi",
				["#!/bin/sh", 'echo "pi v1.0.0"', "exit 0"].join("\n"),
			);

			const result = spawnSync("bash", [bootstrapPath], {
				encoding: "utf-8",
				env: {
					...process.env,
					PATH: fakeBin,
					HOME: environment.homeDir,
				},
				timeout: 10000,
			});

			// Should fail because git is missing
			expect(result.status).not.toBe(0);
		});
	});

	it("exits gracefully when pi is not available", async () => {
		await withTestEnvironment(async (environment) => {
			const fakeBin = join(environment.rootDir, "no-pi-bin");
			await mkdir(fakeBin, { recursive: true });

			// Write a fake git (but no pi)
			await environment.writeExecutable(
				"git",
				["#!/bin/sh", 'echo "git version 2.40.0"', "exit 0"].join("\n"),
			);

			const result = spawnSync("bash", [bootstrapPath], {
				encoding: "utf-8",
				env: {
					...process.env,
					PATH: fakeBin,
					HOME: environment.homeDir,
				},
				timeout: 10000,
			});

			// Should fail because pi is missing
			expect(result.status).not.toBe(0);
		});
	});

	it("installs the extension and leaves repo initialization to /pisync", async () => {
		await withTestEnvironment(async (environment) => {
			await environment.writeExecutable(
				"git",
				[
					"#!/bin/sh",
					'if [ "$1" = "--version" ]; then echo "git version 2.40.0"; exit 0; fi',
					'echo "unexpected git command: $@" >&2',
					"exit 1",
				].join("\n"),
			);

			// Create fake pi
			await environment.writeExecutable(
				"pi",
				[
					"#!/bin/sh",
					'case "$1" in',
					'  --version) echo "pi v1.0.0"; exit 0 ;;',
					"  list) exit 0 ;;",
					'  install) echo "Package installed: $2"; exit 0 ;;',
					'  *) echo "pi: $@" >&2; exit 1 ;;',
					"esac",
				].join("\n"),
			);

			const result = spawnSync(
				"bash",
				[bootstrapPath, "git@github.com:test/pi-config.git"],
				{
					encoding: "utf-8",
					env: {
						...process.env,
						HOME: environment.homeDir,
					},
					timeout: 10000,
				},
			);

			expect(result.status).toBe(0);
			expect(result.stdout).toContain("npm:@xyzensun/pi-sync");
			expect(result.stdout).not.toMatch(/npm:@jachy\/pi-git-sync@\d/);
			expect(result.stdout).toContain("Bootstrap complete");
			expect(result.stdout).toContain(
				"Run /pisync and enter the repository URL when prompted",
			);
			expect(result.stdout).not.toContain("Cloning config repository");
		});
	});

	it("removes a versioned legacy package before installing the unversioned package", async () => {
		await withTestEnvironment(async (environment) => {
			await environment.writeExecutable(
				"git",
				[
					"#!/bin/sh",
					'if [ "$1" = "--version" ]; then echo "git version 2.40.0"; exit 0; fi',
					"exit 1",
				].join("\n"),
			);
			await environment.writeExecutable(
				"pi",
				[
					"#!/bin/sh",
					'case "$1" in',
					'  --version) echo "pi v1.0.0"; exit 0 ;;',
					'  list) echo "  npm:@xyzensun/pi-sync@0.1.16"; exit 0 ;;',
					'  remove) echo "Package removed: $2"; exit 0 ;;',
					'  install) echo "Package installed: $2"; exit 0 ;;',
					"  *) exit 1 ;;",
					"esac",
				].join("\n"),
			);

			const result = spawnSync(
				"bash",
				[bootstrapPath, "https://example.test/config.git"],
				{
					encoding: "utf-8",
					env: { ...process.env, HOME: environment.homeDir },
					timeout: 10000,
				},
			);

			expect(result.status).toBe(0);
			expect(result.stdout).toContain(
				"Package removed: npm:@xyzensun/pi-sync@0.1.16",
			);
			expect(result.stdout).toContain(
				"Package installed: npm:@xyzensun/pi-sync",
			);
			expect(result.stdout.indexOf("Package removed:")).toBeLessThan(
				result.stdout.indexOf("Package installed:"),
			);
		});
	});

	it("fails when extension installation fails", async () => {
		await withTestEnvironment(async (environment) => {
			await environment.writeExecutable(
				"git",
				[
					"#!/bin/sh",
					'if [ "$1" = "--version" ]; then echo "git version 2.40.0"; exit 0; fi',
					"exit 1",
				].join("\n"),
			);
			await environment.writeExecutable(
				"pi",
				[
					"#!/bin/sh",
					'if [ "$1" = "--version" ] || [ "$1" = "list" ]; then echo "pi v1.0.0"; exit 0; fi',
					'echo "install failed" >&2',
					"exit 42",
				].join("\n"),
			);

			const result = spawnSync(
				"bash",
				[bootstrapPath, "https://example.test/config.git"],
				{
					encoding: "utf-8",
					env: {
						...process.env,
						HOME: environment.homeDir,
					},
					timeout: 10000,
				},
			);

			expect(result.status).toBe(1);
			expect(result.stdout).not.toContain("Bootstrap complete");
			expect(result.stderr).toContain("Failed to install");
		});
	});

	it("prompts for URL when none is provided", async () => {
		await withTestEnvironment(async (environment) => {
			await environment.writeExecutable(
				"git",
				["#!/bin/sh", "echo 'git version 2.40.0'", "exit 0"].join("\n"),
			);

			await environment.writeExecutable(
				"pi",
				[
					"#!/bin/sh",
					'case "$1" in',
					'  --version) echo "pi v1.0.0"; exit 0 ;;',
					"  *) exit 0 ;;",
					"esac",
				].join("\n"),
			);

			// Run without URL, pipe empty input to simulate no URL entered
			const result = spawnSync("bash", [bootstrapPath], {
				encoding: "utf-8",
				input: "\n", // Empty input to the read prompt
				env: {
					...process.env,
					HOME: environment.homeDir,
				},
				timeout: 10000,
			});

			// Should fail because empty URL is rejected
			expect(result.status).not.toBe(0);
		});
	});
});
