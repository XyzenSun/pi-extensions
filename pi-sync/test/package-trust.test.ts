import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reconcilePackages } from "./helpers/reconcile.ts";
import { PiSyncCommands } from "../src/orchestration/commands.ts";
import { sha256 } from "../src/sync/inventory.ts";
import { loadState, saveState } from "../src/system/state.ts";
import { createPiSyncConfig, createSyncState } from "./helpers/factories.ts";
import { runGit } from "./helpers/git-fixture.ts";
import { withTestEnvironment } from "./helpers/temp-env.ts";

async function writeSettings(repoDir: string, agentDir: string, remote: unknown, local: unknown): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(join(repoDir, "sync"), { recursive: true });
  await writeFile(join(repoDir, "sync/settings.json"), JSON.stringify({ packages: remote }), "utf-8");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: local }), "utf-8");
}

describe.sequential("package trust and approval", () => {
  it("blocks an unapproved remote package without invoking pi", async () => {
    await withTestEnvironment(async (environment) => {
      const logPath = join(environment.rootDir, "pi.log");
      await environment.writeExecutable("pi", [
        "#!/bin/sh",
        `echo called >> '${logPath}'`,
        "exit 0",
      ].join("\n"));
      await writeSettings(environment.repoDir, environment.agentDir, ["npm:untrusted-package@1.0.0"], []);

      const result = await reconcilePackages(
        environment.repoDir,
        environment.agentDir,
        createPiSyncConfig({ include: ["settings.json"] }),
      );

      expect(result.approvalRequired).toEqual(["npm:untrusted-package@1.0.0"]);
      expect(result.installed).toEqual([]);
      await expect(readFile(logPath, "utf-8")).rejects.toThrow();
    });
  });

  it("uses one approval for object and string declarations and can remember it", async () => {
    await withTestEnvironment(async (environment) => {
      await environment.writeExecutable("pi", [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo pi-test; exit 0; fi",
        "printf '%s|%s\\n' \"$1\" \"$2\" >> \"$PI_TEST_LOG\"",
        "exit 0",
      ].join("\n"));
      process.env.PI_TEST_LOG = join(environment.rootDir, "pi.log");
      await writeSettings(environment.repoDir, environment.agentDir, [{ source: "npm:trusted-object@1.0.0" }], []);

      const first = await reconcilePackages(
        environment.repoDir,
        environment.agentDir,
        createPiSyncConfig({ include: ["settings.json"] }),
        { approval: { approvedSources: ["npm:trusted-object@1.0.0"], remember: true } },
      );
      expect(first.installed).toEqual(["npm:trusted-object@1.0.0"]);

      const second = await reconcilePackages(
        environment.repoDir,
        environment.agentDir,
        createPiSyncConfig({ include: ["settings.json"] }),
      );
      expect(second.approvalRequired).toBeUndefined();
      delete process.env.PI_TEST_LOG;
    });
  });

  it("rejects local path and control-character sources", async () => {
    await withTestEnvironment(async (environment) => {
      await writeSettings(environment.repoDir, environment.agentDir, ["file:///tmp/evil"], []);
      await expect(reconcilePackages(
        environment.repoDir,
        environment.agentDir,
        createPiSyncConfig({ include: ["settings.json"] }),
      )).rejects.toThrow("不允许使用本机包路径");
    });
  });

  it("writes settings before installing and rolls back on installation failure", async () => {
    await withTestEnvironment(async (environment) => {
      const remoteSettings = JSON.stringify({
        theme: "remote",
        packages: ["npm:broken-package@1.0.0"],
      });
      const localSettings = JSON.stringify({ theme: "local", packages: [] });
      const observedSettingsPath = join(environment.rootDir, "settings-at-install.json");

      await mkdir(join(environment.repoDir, "sync"), { recursive: true });
      await writeFile(join(environment.repoDir, "pi-sync.json"), JSON.stringify(createPiSyncConfig({ include: ["settings.json"] })), "utf-8");
      await writeFile(join(environment.repoDir, "sync/settings.json"), remoteSettings, "utf-8");
      await runGit(environment.repoDir, ["init", "-b", "main"]);
      await runGit(environment.repoDir, ["config", "user.name", "test"]);
      await runGit(environment.repoDir, ["config", "user.email", "test@example.com"]);
      await runGit(environment.repoDir, ["add", "."]);
      await runGit(environment.repoDir, ["commit", "-m", "remote settings"]);
      await writeFile(join(environment.agentDir, "settings.json"), localSettings, "utf-8");
      await saveState(environment.agentDir, createSyncState({
        repoPath: environment.repoDir,
        files: { "settings.json": { sha256: sha256(localSettings), mode: 0o644 } },
      }));
      await environment.writeExecutable("pi", [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo pi-test; exit 0; fi",
        `if [ "$1" = "install" ]; then cp "$PI_CODING_AGENT_DIR/settings.json" '${observedSettingsPath}'; exit 7; fi`,
        "exit 0",
      ].join("\n"));

      const result = await new PiSyncCommands(environment.agentDir).apply(
        environment.repoDir,
        { approvedSources: ["npm:broken-package@1.0.0"] },
      );
      const state = await loadState(environment.agentDir);

      expect(result.reload).toBe(false);
      expect(result.message).toContain("包安装失败");
      expect(await readFile(observedSettingsPath, "utf-8")).toBe(remoteSettings);
      expect(await readFile(join(environment.agentDir, "settings.json"), "utf-8")).toBe(localSettings);
      expect(state.pendingOperation?.type).toBe("apply-failed");
      expect(state.files["settings.json"]?.sha256).toBe(sha256(localSettings));
    });
  });
});
