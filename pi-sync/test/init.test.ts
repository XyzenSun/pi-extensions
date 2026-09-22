/**
 * End-to-end regression test for `/pisync init`.
 *
 * Reproduces first-run initialization with an empty remote and existing local
 * settings. The scaffold's placeholder settings file must not cause a bilateral
 * conflict or replace the initiating machine's package declarations.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, createConnection } from "node:net";
import {
	mkdir,
	rm,
	mkdtemp,
	readFile,
	writeFile,
	chmod,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { PiSyncCommands } from "../src/orchestration/commands.ts";
import { loadState } from "../src/system/state.ts";

const execFile = promisify(execFileCb);

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.unref();
		srv.on("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			if (addr && typeof addr === "object") {
				const port = addr.port;
				srv.close(() => resolve(port));
			} else {
				srv.close();
				reject(new Error("could not determine free port"));
			}
		});
	});
}

async function git(args: string[], opts: { cwd: string }): Promise<void> {
	await execFile("git", args, opts);
}

async function createInvalidRemote(
	workDir: string,
	name: string,
	allowPush: boolean,
): Promise<string> {
	const remote = join(workDir, `${name}.git`);
	const seed = join(workDir, `${name}-seed`);
	await mkdir(remote, { recursive: true });
	await mkdir(seed, { recursive: true });
	await git(["init", "--bare", "--initial-branch=main", remote], {
		cwd: workDir,
	});
	await git(["init", "--initial-branch=main"], { cwd: seed });
	await writeFile(join(seed, "README.md"), "# Existing repository\n");
	await git(["add", "README.md"], { cwd: seed });
	await git(["commit", "-m", "initial commit"], { cwd: seed });
	await git(["push", remote, "HEAD:main"], { cwd: seed });
	await git(["config", "daemon.receivepack", String(allowPush)], {
		cwd: remote,
	});
	return remote;
}

describe("PiSyncCommands.run setup flow (end-to-end with a real git remote)", () => {
	let workDir: string;
	let agentDir: string;
	let remoteDir: string;
	let localRepoDir: string;
	let onboardedAgentDir: string;
	let daemon: ChildProcess | null = null;
	let port: number;
	let url: string;
	let stubBinDir: string;
	let savedEnv: Record<string, string | undefined> = {};
	let tempHome: string;

	beforeAll(async () => {
		workDir = await mkdtemp(join(tmpdir(), `pisync-init-`));
		agentDir = join(workDir, "agent");
		remoteDir = join(workDir, "remote.git");
		localRepoDir = join(agentDir, "..", "config-repo");
		await mkdir(agentDir, { recursive: true });
		await mkdir(remoteDir, { recursive: true });

		// Real, *empty* bare remote.
		await git(["init", "--bare", "--initial-branch=main", remoteDir], {
			cwd: workDir,
		});
		// Allow pushes over the git:// protocol.
		await git(["config", "daemon.receivepack", "true"], { cwd: remoteDir });

		port = await freePort();
		url = `git://127.0.0.1:${port}/remote.git`;

		daemon = spawn(
			"git",
			[
				"daemon",
				`--base-path=${workDir}`,
				"--export-all",
				"--reuseaddr",
				"--listen=127.0.0.1",
				`--port=${port}`,
			],
			{ stdio: "ignore", detached: false, cwd: workDir },
		);

		// Wait until the daemon is actually accepting TCP connections. git daemon's
		// stdout/stderr wording varies by version, so probe the port directly.
		const ready = await new Promise<boolean>((resolve) => {
			const start = Date.now();
			const tick = () => {
				const sock = createConnection({ host: "127.0.0.1", port }, () => {
					sock.end();
					resolve(true);
				});
				sock.on("error", () => {
					if (Date.now() - start > 8000) resolve(false);
					else setTimeout(tick, 50);
				});
			};
			tick();
		});
		if (!ready)
			throw new Error("git daemon did not start accepting connections");

		// Stub `pi` so init's best-effort `pi install` doesn't touch the real harness.
		stubBinDir = join(workDir, "bin");
		await mkdir(stubBinDir, { recursive: true });
		const stubPi = join(stubBinDir, "pi");
		await writeFile(stubPi, "#!/bin/sh\necho pi-test\nexit 0\n");
		await chmod(stubPi, 0o755);

		// The user's global git config rewrites `git://` -> `https://`
		// (`url.https://.insteadOf=git://`), which would break the git:// daemon
		// transport.  Point git at a pristine HOME containing only a minimal
		// .gitconfig (identity for commits + `git://` enabled, no insteadOf),
		// and ignore system/global config otherwise.
		tempHome = join(workDir, "home");
		await mkdir(tempHome, { recursive: true });
		await writeFile(
			join(tempHome, ".gitconfig"),
			[
				"[user]",
				"\tname = Pi Sync Test",
				"\temail = test@example.com",
				"[init]",
				"\tdefaultBranch = main",
				"[protocol]",
				"\tgit = allow",
				"\tfile = allow",
			].join("\n") + "\n",
		);

		savedEnv = {
			PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
			GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
		};
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PATH = `${stubBinDir}:${process.env.PATH ?? ""}`;
		process.env.HOME = tempHome;
		process.env.GIT_CONFIG_NOSYSTEM = "1";
		// Force the global config to our pristine file (belt & suspenders).
		process.env.GIT_CONFIG_GLOBAL = join(tempHome, ".gitconfig");
	});

	afterAll(async () => {
		if (daemon) {
			daemon.kill("SIGTERM");
			daemon = null;
		}
		for (const k of Object.keys(savedEnv)) {
			if (savedEnv[k] === undefined) {
				delete process.env[k as keyof typeof process.env];
			} else {
				(process.env as Record<string, string | undefined>)[k] = savedEnv[k];
			}
		}
		await rm(workDir, { recursive: true, force: true });
	});

	it("captures local settings while scaffolding an empty remote", async () => {
		const sharedSettings = {
			packages: ["npm:@xyzensun/pi-sync", "npm:pi-lens", "npm:context-mode"],
		};
		const localSettings = {
			packages: [
				...sharedSettings.packages,
				"file:/machine-local/dev-extension",
			],
		};
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify(localSettings, null, 2),
			"utf-8",
		);

		const cmds = new PiSyncCommands();
		const result = await cmds.run({ gitUrl: url });

		// Setup must report overall success — NOT the misleading
		// `Init failed: Cloning ...` we used to see.
		expect(result).toMatchObject({
			ok: true,
			mode: "setup",
			phase: "complete",
			reload: true,
		});
		expect(result.message).toContain("初始化完成");
		expect(result.message).not.toContain("检测到同步冲突");
		expect(result.message).not.toMatch(/^初始化失败：/);

		// The local clone must actually contain the committed scaffold.
		expect(existsSync(join(localRepoDir, ".git"))).toBe(true);
		expect(existsSync(join(localRepoDir, "pi-sync.json"))).toBe(true);
		expect(await readFile(join(localRepoDir, "README.md"), "utf-8")).toBe(
			"# Pi 配置仓库 / Pi Configuration Repository\n\n此仓库用于在多台设备之间同步 Pi 配置。\nThis repository stores Pi configuration synchronized across your machines.\n\n由 pi-sync (npm:@xyzensun/pi-sync) 创建和维护。\nCreated and maintained by pi-sync (npm:@xyzensun/pi-sync).\n",
		);
		const scaffoldConfig = JSON.parse(
			await readFile(join(localRepoDir, "pi-sync.json"), "utf-8"),
		) as { exclude: string[] };
		expect(scaffoldConfig.exclude).toEqual(
			expect.arrayContaining([
				"extensions/**/.cache/**",
				"extensions/**/cache/**",
				"extensions/**/coverage/**",
				"extensions/**/logs/**",
				"extensions/**/temp/**",
				"extensions/**/tmp/**",
			]),
		);
		expect(
			JSON.parse(
				await readFile(join(localRepoDir, "sync/settings.json"), "utf-8"),
			),
		).toEqual(sharedSettings);
		expect(
			JSON.parse(await readFile(join(agentDir, "settings.json"), "utf-8")),
		).toEqual(localSettings);
		expect((await loadState(agentDir)).files["settings.json"]).toBeDefined();
		// HEAD must exist — i.e. a commit was really created (regression guard).
		const headLocal = (
			await execFile("git", ["rev-parse", "HEAD"], { cwd: localRepoDir })
		).stdout.trim();
		expect(headLocal).toMatch(/^[0-9a-f]{40}$/);

		// The scaffold commit must have been PUSHED to the remote bare repo.
		const headRemote = (
			await execFile("git", ["rev-parse", "refs/heads/main"], {
				cwd: remoteDir,
			})
		).stdout.trim();
		expect(headRemote).toBe(headLocal);

		// And the commit message must be the full multi-word string (regression guard).
		const msg = (
			await execFile("git", ["log", "-1", "--pretty=%B"], { cwd: localRepoDir })
		).stdout.trim();
		expect(msg).toBe("pi-sync: 初始配置脚手架（v2）");
	}, 30000);

	it("rejects an invalid setup URL before creating a repository", async () => {
		const isolatedAgentDir = join(workDir, "invalid-url", "agent");
		await mkdir(isolatedAgentDir, { recursive: true });

		const result = await new PiSyncCommands(isolatedAgentDir).run({
			gitUrl: "not a git URL",
		});

		expect(result).toMatchObject({
			ok: false,
			code: "blocked_validation",
			mode: "setup",
			phase: "preflight",
			reload: false,
		});
		expect(result.message).toContain("无效的 Git URL：not a git URL");
		expect(existsSync(join(isolatedAgentDir, "..", "config-repo"))).toBe(false);
	}, 30000);

	it("explains when a non-config repository is readable but not writable", async () => {
		await createInvalidRemote(workDir, "read-only-invalid", false);
		const isolatedAgentDir = join(workDir, "read-only-client", "agent");
		await mkdir(isolatedAgentDir, { recursive: true });

		const result = await new PiSyncCommands(isolatedAgentDir).run({
			gitUrl: `git://127.0.0.1:${port}/read-only-invalid.git`,
		});

		expect(result).toMatchObject({
			ok: false,
			mode: "setup",
			phase: "preflight",
			details: {
				reason: "invalid_config_repo",
				writeAccess: "denied",
			},
		});
		expect(result.message).toContain(
			"仓库可读，但远端拒绝了一次安全的写入权限探测。",
		);
		expect(result.message).toContain(
			"你可能选择了他人的仓库",
		);
	}, 30000);

	it("identifies a writable non-config repository as the likely wrong repository", async () => {
		await createInvalidRemote(workDir, "writable-invalid", true);
		const isolatedAgentDir = join(workDir, "writable-client", "agent");
		await mkdir(isolatedAgentDir, { recursive: true });

		const result = await new PiSyncCommands(isolatedAgentDir).run({
			gitUrl: `git://127.0.0.1:${port}/writable-invalid.git`,
		});

		expect(result).toMatchObject({
			ok: false,
			mode: "setup",
			phase: "preflight",
			details: {
				reason: "invalid_config_repo",
				writeAccess: "writable",
			},
		});
		expect(result.message).toContain(
			"这多半是选错了仓库，或该仓库非空却未初始化",
		);
	}, 30000);

	it("onboards a new device without applying the remote config until a pull runs", async () => {
		onboardedAgentDir = join(workDir, "machine-b", "agent");
		await mkdir(onboardedAgentDir, { recursive: true });

		const commands = new PiSyncCommands(onboardedAgentDir);
		const setup = await commands.run({
			gitUrl: url,
		});

		// 首次接入已有仓库：初始化只登记状态，绝不自动把远端配置落到本机。
		expect(setup.ok, setup.message).toBe(true);
		expect(setup).toMatchObject({
			ok: true,
			code: "first_pull_choice_required",
			mode: "setup",
			phase: "complete",
			reload: false,
		});
		expect(setup.message).toContain("已连接到现有配置仓库，本机配置未做任何改动。");
		// 拉取方式选择之前，远端 settings 不得出现在本机。
		expect(
			existsSync(join(onboardedAgentDir, "settings.json")),
		).toBe(false);

		// 用户选择智能化拉取（扩展层收到选择后调用 pull）：
		// 远端 settings 落地，包安装按审批执行。
		const pull = await commands.pull(undefined, {
			approvedSources: [
				"npm:@xyzensun/pi-sync",
				"npm:pi-lens",
				"npm:context-mode",
			],
		});
		expect(pull.ok, pull.message).toBe(true);
		expect(
			JSON.parse(
				await readFile(join(onboardedAgentDir, "settings.json"), "utf-8"),
			),
		).toEqual({
			packages: ["npm:@xyzensun/pi-sync", "npm:pi-lens", "npm:context-mode"],
		});

		const repeat = await commands.run();
		expect(repeat).toMatchObject({
			ok: true,
			code: "noop",
			mode: "sync",
			phase: "complete",
			reload: false,
		});
	}, 30000);
});
