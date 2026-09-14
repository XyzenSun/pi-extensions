import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureChanges, verifyCapture } from "../src/sync/capture.ts";
import { sha256 } from "../src/sync/inventory.ts";
import { createPiSyncConfig, createSyncState } from "./helpers/factories.ts";
import { withTestEnvironment } from "./helpers/temp-env.ts";

describe.sequential("captureChanges", () => {
  it("captures local creates without initializing, committing, or pushing Git", async () => {
    await withTestEnvironment(async (environment) => {
      await environment.writeAgentFile("themes/dark.json", '{ "name": "dark" }\n');

      const result = await captureChanges(
        environment.agentDir,
        environment.repoDir,
        createPiSyncConfig({ include: ["themes/**"] }),
        createSyncState({ repoPath: environment.repoDir }),
      );

      expect(result).toMatchObject({ captured: ["themes/dark.json"], deleted: [], errors: [], hasConflicts: false });
      expect(await readFile(join(environment.repoDir, "sync/themes/dark.json"), "utf-8"))
        .toBe('{ "name": "dark" }\n');
      expect(existsSync(join(environment.repoDir, ".git"))).toBe(false);
    });
  });

	it("keeps user-selected local extension changes out of the shared repository", async () => {
		await withTestEnvironment(async (environment) => {
			const relativePath = "extensions/local-only/index.ts";
			await environment.writeAgentFile(relativePath, "export default {}\n");

			const result = await captureChanges(
				environment.agentDir,
				environment.repoDir,
				createPiSyncConfig({ include: ["extensions/**"] }),
				createSyncState({ repoPath: environment.repoDir }),
				{ keepLocalPaths: new Set([relativePath]) },
			);

			expect(result).toMatchObject({
				captured: [],
				keptLocal: [relativePath],
				errors: [],
				hasConflicts: false,
			});
			expect(existsSync(join(environment.repoDir, `sync/${relativePath}`))).toBe(false);
		});
	});

  it("propagates only tracked local deletions to the repository", async () => {
    await withTestEnvironment(async (environment) => {
      const relativePath = "prompts/obsolete.md";
      await environment.writeRepoFile(`sync/${relativePath}`, "base\n");

      const result = await captureChanges(
        environment.agentDir,
        environment.repoDir,
        createPiSyncConfig({ include: ["prompts/**"] }),
        createSyncState({
          repoPath: environment.repoDir,
          files: { [relativePath]: { sha256: sha256("base\n"), mode: 0o644 } },
        }),
      );

      expect(result).toMatchObject({ captured: [], deleted: [relativePath], errors: [], hasConflicts: false });
      expect(existsSync(join(environment.repoDir, `sync/${relativePath}`))).toBe(false);
    });
  });

  it("does not overwrite either side of a bilateral conflict", async () => {
    await withTestEnvironment(async (environment) => {
      const relativePath = "skills/review/SKILL.md";
      await environment.writeAgentFile(relativePath, "local\n");
      await environment.writeRepoFile(`sync/${relativePath}`, "remote\n");

      const result = await captureChanges(
        environment.agentDir,
        environment.repoDir,
        createPiSyncConfig({ include: ["skills/**"] }),
        createSyncState({
          repoPath: environment.repoDir,
          files: { [relativePath]: { sha256: sha256("base\n"), mode: 0o644 } },
        }),
      );

      expect(result.hasConflicts).toBe(true);
      expect(result.conflicts).toMatchObject([{ relativePath, changeType: "both_modified" }]);
      expect(await readFile(join(environment.repoDir, `sync/${relativePath}`), "utf-8")).toBe("remote\n");
      expect(await readFile(join(environment.agentDir, relativePath), "utf-8")).toBe("local\n");
    });
  });
});

describe.sequential("verifyCapture", () => {
  it("reports matching, mismatching, missing, and unsafe paths without escaping either root", async () => {
    await withTestEnvironment(async (environment) => {
      await environment.writeAgentFile("themes/dark.json", "same\n");
      await environment.writeRepoFile("sync/themes/dark.json", "same\n");
      await environment.writeAgentFile("themes/light.json", "local\n");
      await environment.writeRepoFile("sync/themes/light.json", "remote\n");

      const result = await verifyCapture(
        environment.agentDir,
        environment.repoDir,
        createPiSyncConfig({ include: ["themes/**"] }),
        ["themes/dark.json", "themes/light.json", "themes/missing.json", "../outside.json"],
      );

      expect(result).toEqual([
        { file: "themes/dark.json", match: true },
        { file: "themes/light.json", match: false },
        { file: "themes/missing.json", match: false, error: "有一侧缺少该文件" },
        { file: "../outside.json", match: false, error: expect.stringContaining("不允许路径逃逸") },
      ]);
    });
  });
});
