import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { FailureInjector, InjectedFailure } from "./helpers/failure-injection.ts";
import { createPiSyncConfig, createSyncState } from "./helpers/factories.ts";
import { createGitFixture, runGit } from "./helpers/git-fixture.ts";
import { FakeCommandContext, FakeExtensionApi } from "./helpers/fake-pi.ts";
import { withTestEnvironment } from "./helpers/temp-env.ts";

describe.sequential("test infrastructure", () => {
  it("creates isolated configuration and state fixtures", () => {
    expect(createPiSyncConfig({ branch: "sync-test" })).toMatchObject({
        schemaVersion: 2,
        branch: "sync-test",
        special: {},
        autoSync: { enabled: false, intervalMinutes: 30 },
      });
    expect(createSyncState({ repoPath: "/tmp/repo", files: { "settings.json": { sha256: "a", mode: 0o644 } } }))
      .toMatchObject({
        schemaVersion: 3,
        repoPath: "/tmp/repo",
        files: { "settings.json": { sha256: "a", mode: 0o644 } },
      });
  });

  it("isolates process environment and removes temporary files", async () => {
    const originalHome = process.env.HOME;

    await withTestEnvironment(async (environment) => {
      expect(process.env.HOME).toBe(environment.homeDir);
      expect(process.env.PI_CODING_AGENT_DIR).toBe(environment.agentDir);
      await environment.writeAgentFile("skills/example.md", "# Example\n");
      expect(await readFile(`${environment.agentDir}/skills/example.md`, "utf-8")).toBe("# Example\n");
    });

    expect(process.env.HOME).toBe(originalHome);
  });

  it("creates an offline Git remote with two configured clones", async () => {
    await withTestEnvironment(async (environment) => {
      const fixture = await createGitFixture(environment.rootDir);
      await fixture.writeAndCommit(fixture.deviceAPath, "sync/settings.json", "{}\n");
      await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
      await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);

      expect(await readFile(`${fixture.deviceBPath}/sync/settings.json`, "utf-8")).toBe("{}\n");
    });
  });

  it("records deterministic injected failures", () => {
    const injector = new FailureInjector();
    injector.failOn("write", 2);

    injector.checkpoint("write");
    expect(() => injector.checkpoint("write")).toThrow(InjectedFailure);
    expect(injector.calls).toEqual(["write#1", "write#2"]);
  });

  it("records extension registrations and command context effects", async () => {
    const api = new FakeExtensionApi();
    const context = new FakeCommandContext("rpc");
    api.registerCommand("example", { handler: async (_args, ctx) => ctx.ui.notify("done", "info") });
    api.on("session_start", (_event, ctx: FakeCommandContext) => ctx.ui.setStatus("pi-sync", undefined));

    await api.commands.get("example")?.handler(undefined, context);
    await api.emit("session_start", {}, context);

    expect(context.ui.notifications).toEqual([{ message: "done", level: "info" }]);
    expect(context.ui.statusUpdates).toEqual([{ key: "pi-sync", value: undefined }]);
  });
});
