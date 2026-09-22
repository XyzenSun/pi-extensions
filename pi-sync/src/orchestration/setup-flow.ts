import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadPiSyncConfig } from "../sync/config.ts";
import {
	GitCommandError,
	ensureConfiguredBranch,
	gitCommit,
	gitExec,
	gitFastForward,
	gitFetch,
	gitProbe,
	gitPushHeadToBranch,
	gitRenameBranch,
} from "../system/git.ts";
import type { PiSyncConfig } from "../sync/config.ts";
import type { ResultCode } from "./operation-result.ts";
import type { PackageApproval } from "../system/packages.ts";
import { loadState, updateState } from "../system/state.ts";
import type { SyncState } from "../system/state.ts";

export interface SetupFlowResult {
	message: string;
	needsReload: boolean;
	ok: boolean;
	code?: ResultCode;
	details?: unknown;
	level: "info" | "warning" | "error";
}

interface InitialCaptureResult {
	hasConflicts: boolean;
	conflicts: Array<{ relativePath: string }>;
	errors: Array<{ file: string; message: string }>;
	captured: string[];
	deleted: string[];
}

interface SetupApplyResult {
	message: string;
	reload: boolean;
	ok: boolean;
	code?: ResultCode;
	details?: unknown;
}

export interface SetupFlowDependencies {
	captureInitialLocalConfig: (
		repoPath: string,
		config: PiSyncConfig,
	) => Promise<InitialCaptureResult>;
	createRepositoryBaseline: (
		repoPath: string,
		config: PiSyncConfig,
		state: SyncState,
	) => Promise<SyncState>;
	applyCurrent: (
		repoPath: string,
		config: PiSyncConfig,
		state: SyncState,
		reason: string,
		packageApproval?: PackageApproval,
	) => Promise<SetupApplyResult>;
	getDeviceBranchName: () => Promise<string>;
	pushMainAndDeviceBranches: (
		repoPath: string,
		branch: string,
	) => Promise<unknown>;
}

export interface SetupFlowOptions {
	agentDir: string;
	gitUrl: string;
	repoPath: string;
	force: boolean;
	packageApproval?: PackageApproval;
	onProgress?: (message: string) => void;
	dependencies: SetupFlowDependencies;
}

/**
 * 在命令外观层取得生命周期锁之后执行首次初始化。
 * 本阶段只负责仓库准备与首次应用；有意不引入命令外观层，也不管理锁的归属。
 */
export async function executeSetupFlow(
	options: SetupFlowOptions,
): Promise<SetupFlowResult> {
	const {
		agentDir,
		gitUrl,
		repoPath,
		force,
		packageApproval,
		onProgress,
		dependencies,
	} = options;
	const {
		captureInitialLocalConfig,
		createRepositoryBaseline,
		applyCurrent,
		getDeviceBranchName,
		pushMainAndDeviceBranches,
	} = dependencies;

	try {
		const lines: string[] = [];
		let capturedInitialLocalConfig = false;
		let initialCapturedFiles = new Set<string>();

		onProgress?.("正在检查本机仓库……");

		if (existsSync(repoPath) && existsSync(join(repoPath, ".git"))) {
			if (force) {
				onProgress?.("正在移除已存在的仓库（--force）……");
				lines.push("已指定 --force —— 正在移除已存在的仓库并重新克隆……");
				const { rm } = await import("node:fs/promises");
				await rm(repoPath, { recursive: true, force: true });
			} else {
				const existingProbe = await gitProbe(repoPath, [
					"remote",
					"get-url",
					"origin",
				]);
				const existingUrl = existingProbe.stdout.trim();

				if (!urlsMatch(existingUrl, gitUrl)) {
					return {
						message:
							`${repoPath} 处已存在配置仓库。\n` +
							`现有远端：${existingUrl}\n提供的 URL：${gitUrl}\n` +
							"若要更换，请先移除现有仓库：rm -rf ~/.pi/config-repo\n" +
							"移除或修复现有仓库后再运行 /pisync。",
						needsReload: false,
						ok: false,
						level: "error",
					};
				}
				lines.push(`${repoPath} 处已存在配置仓库。`);
			}
		}

		if (!existsSync(repoPath) || !existsSync(join(repoPath, ".git"))) {
			onProgress?.(`正在克隆 ${gitUrl}……`);
			lines.push(`正在克隆 ${gitUrl}……`);
			await mkdir(join(repoPath, ".."), { recursive: true });

			onProgress?.("正在检查远端连通性……");
			const preflight = await gitProbe(
				process.cwd(),
				["ls-remote", "--", gitUrl],
				{
					timeout: 30000,
				},
			);
			if (!preflight.ok) {
				return {
					message:
						`克隆失败：无法访问 ${gitUrl}\n${preflight.stderr.trim() || preflight.stdout.trim()}\n\n` +
						"请检查 URL、网络，以及（对 SSH URL 而言）密钥能否通过认证。",
					needsReload: false,
					ok: false,
					level: "error",
				};
			}

			try {
				await gitExec(join(repoPath, ".."), ["clone", "--", gitUrl, repoPath], {
					timeout: 60000,
				});
			} catch (cloneErr) {
				if (existsSync(repoPath)) {
					const { rm } = await import("node:fs/promises");
					await rm(repoPath, { recursive: true, force: true });
				}
				let msg = "未知错误";
				if (cloneErr instanceof GitCommandError) {
					msg = cloneErr.stderr || cloneErr.stdout || cloneErr.message;
				} else if (cloneErr instanceof Error) {
					msg = cloneErr.message;
				}
				return {
					message: `克隆失败：\n${msg}`,
					needsReload: false,
					ok: false,
					level: "error",
				};
			}
			if (!existsSync(join(repoPath, ".git"))) {
				return {
					message: "克隆已完成，但未找到 .git 目录。",
					needsReload: false,
					ok: false,
					level: "error",
				};
			}
			lines.push("克隆完成。");
		}

		onProgress?.("正在拉取最新变更……");
		await gitFetch(repoPath).catch(() => {});

		onProgress?.("正在分析仓库状态……");
		const repoState = await detectRepoState(repoPath);

		if (force || repoState === "empty") {
			if (force && repoState !== "empty") {
				onProgress?.("正在清空已存在的仓库内容（--force）……");
				lines.push("已指定 --force —— 正在清空已存在的仓库内容……");
				await clearRepoContents(repoPath);
				await gitExec(repoPath, ["add", "-A"]);
				await gitExec(repoPath, [
					"commit",
					"-m",
					"pi-sync: 重建前强制清空",
					"--allow-empty",
				]);
			}

			onProgress?.("正在生成配置结构脚手架……");
			lines.push(
				`${force && repoState !== "empty" ? "强制重建" : "空仓库"} —— 正在生成配置结构脚手架（schema v2）……`,
			);
			await scaffoldConfigRepoV2(repoPath);
			const scaffoldConfig = await loadPiSyncConfig(repoPath);
			const initialCapture = await captureInitialLocalConfig(
				repoPath,
				scaffoldConfig,
			);
			if (initialCapture.hasConflicts || initialCapture.errors.length > 0) {
				const details = initialCapture.hasConflicts
					? initialCapture.conflicts
							.map((conflict) => conflict.relativePath)
							.join("、")
					: initialCapture.errors
							.map((error) => `${error.file}：${error.message}`)
							.join("\n");
				return {
					message: `首次捕获本机配置失败：${details}`,
					needsReload: false,
					ok: false,
					code: "blocked_conflict",
					level: "error",
				};
			}
			initialCapturedFiles = new Set(initialCapture.captured);
			capturedInitialLocalConfig =
				initialCapture.captured.length > 0 || initialCapture.deleted.length > 0;
			if (capturedInitialLocalConfig) {
				lines.push(
					`已将 ${initialCapture.captured.length} 个本机配置文件捕获到新仓库。`,
				);
			}

			onProgress?.("正在提交脚手架与本机配置……");
			await gitCommit(repoPath, "pi-sync: 初始配置脚手架（v2）");

			onProgress?.("正在推送到远端……");
			await gitRenameBranch(repoPath, scaffoldConfig.branch);
			try {
				const pushArgs = force
					? ["push", "--force", "origin", scaffoldConfig.branch]
					: ["push", "origin", scaffoldConfig.branch];
				if (force) {
					await gitExec(repoPath, pushArgs);
					await gitPushHeadToBranch(repoPath, await getDeviceBranchName());
				} else {
					await pushMainAndDeviceBranches(repoPath, scaffoldConfig.branch);
				}
				lines.push(
					`脚手架已提交，并推送到 origin/${scaffoldConfig.branch} 与当前设备分支。`,
				);
			} catch (err) {
				await updateState(agentDir, { repoPath });
				const detail = err instanceof Error ? err.message : "未知错误";
				return {
					message:
						`${lines.join("\n")}\n\n` +
						"脚手架已在本机提交，但推送失败。\n" +
						"请先解决远端问题，然后运行 /pisync。\n" +
						`详情：${detail}`,
					needsReload: false,
					ok: false,
					level: "warning",
				};
			}
			lines.push("");
		} else if (repoState === "invalid") {
			onProgress?.("正在检查仓库写入权限……");
			const writeAccess = await probeRepoWriteAccess(repoPath);
			const accessHint = getRepoWriteAccessHint(writeAccess);
			return {
				message:
					`${gitUrl} 处的仓库已有提交，但不是有效的 pi-sync 配置仓库。\n` +
					"pi-sync 配置仓库的根目录必须有 pi-sync.json。\n" +
					accessHint +
					"请改用一个你有写入权限的空仓库以自动生成脚手架，或确保该仓库包含有效的 pi-sync.json。\n\n" +
					"修复或更换仓库后，再次运行 /pisync。",
				needsReload: false,
				ok: false,
				details: { reason: "invalid_config_repo", writeAccess },
				level: "error",
			};
		} else {
			onProgress?.("正在拉取最新内容……");
			lines.push("检测到有效的同步仓库 —— 正在拉取最新内容……");
			const existingConfig = await loadPiSyncConfig(repoPath);
			await gitFetch(repoPath, { timeout: existingConfig.pullTimeoutMs });
			await ensureConfiguredBranch(repoPath, existingConfig.branch);
			const { pulled } = await gitFastForward(repoPath, existingConfig.branch, {
				timeout: existingConfig.pullTimeoutMs,
			});
			lines.push(pulled ? "已更新到最新。" : "已是最新。");

			// 接入已有仓库到此为止：只完成 clone 与状态登记，绝不把远端配置
			// 落到本机。智能化拉取与以远端覆盖本机对本机独有文件的处理截然
			// 不同（保留 vs 删除），首次接入必须由用户当场选择。这里返回
			// first_pull_choice_required，由扩展层弹选择框后再走对应链路。
			onProgress?.("正在保存状态……");
			await updateState(agentDir, { repoPath });
			lines.push("");
			lines.push("已连接到现有配置仓库，本机配置未做任何改动。");
			lines.push("请选择首次拉取方式：智能化拉取，或以远端覆盖本机。");
			return {
				message: lines.join("\n"),
				needsReload: false,
				ok: true,
				code: "first_pull_choice_required",
				level: "info",
			};
		}

		onProgress?.("正在保存状态……");
		await updateState(agentDir, { repoPath });

		onProgress?.("正在将配置应用到 agent……");
		const config = await loadPiSyncConfig(repoPath);
		let state = await loadState(agentDir);
		if (initialCapturedFiles.size > 0) {
			const repositoryBaseline = await createRepositoryBaseline(
				repoPath,
				config,
				state,
			);
			state = {
				...state,
				files: Object.fromEntries(
					Object.entries(repositoryBaseline.files).filter(([relativePath]) =>
						initialCapturedFiles.has(relativePath),
					),
				),
			};
		}
		const applyResult = await applyCurrent(
			repoPath,
			config,
			state,
			"init",
			packageApproval,
		);
		lines.push(applyResult.message);

		if (!applyResult.ok) {
			return {
				message: lines.join("\n"),
				needsReload: false,
				ok: false,
				code: applyResult.code,
				details: applyResult.details,
				level: applyResult.code === "approval_required" ? "warning" : "error",
			};
		}

		lines.push("");
		lines.push("初始化完成！你的配置已同步。");
		lines.push("日常同步操作请使用 /pisync。");
		return {
			message: lines.join("\n"),
			needsReload: applyResult.reload || capturedInitialLocalConfig,
			ok: true,
			level: "info",
		};
	} catch (err) {
		return {
			message: `初始化失败：${err instanceof Error ? err.message : "未知错误"}`,
			needsReload: false,
			ok: false,
			level: "error",
		};
	}
}

export function isValidSetupGitUrl(url: string): boolean {
	if (/^git@[\w.-]+:[\w./-]+(\.git)?$/.test(url)) return true;
	if (/^https?:\/\/[\w.-]+(:\d+)?\/[\w./-]+(\.git)?$/.test(url)) return true;
	if (/^ssh:\/\/git@[\w.-]+(:\d+)?\/[\w./-]+(\.git)?$/.test(url)) return true;
	if (/^git:\/\/[\w.-]+(:\d+)?\/[\w./-]+(\.git)?$/.test(url)) return true;
	return false;
}

async function detectRepoState(
	repoPath: string,
): Promise<"empty" | "valid" | "invalid"> {
	const probe = await gitProbe(repoPath, ["rev-list", "--count", "HEAD"]);
	if (!probe.ok || parseInt(probe.stdout.trim(), 10) === 0) return "empty";
	return existsSync(join(repoPath, "pi-sync.json")) ? "valid" : "invalid";
}

type RepoWriteAccess = "writable" | "denied" | "unknown";

function getRepoWriteAccessHint(writeAccess: RepoWriteAccess): string {
	switch (writeAccess) {
		case "denied":
			return (
				"仓库可读，但远端拒绝了一次安全的写入权限探测。\n" +
				"你可能选择了他人的仓库，或使用了没有 push 权限的账号。\n"
			);
		case "writable":
			return "写入权限正常，因此这多半是选错了仓库，或该仓库非空却未初始化。\n";
		default:
			return "无法确认写入权限。请检查仓库 URL 是否正确，以及你的账号能否向其 push。\n";
	}
}

/**
 * 请远端在不更新任何 ref 的前提下校验一次 push，用于区分“仅可读的公开仓库”
 * 与“当前账号确实能用于 pi-sync 的仓库”。策略类失败保持 "unknown"，
 * 以免误报为认证问题。
 */
async function probeRepoWriteAccess(
	repoPath: string,
): Promise<RepoWriteAccess> {
	const probe = await gitProbe(
		repoPath,
		[
			"push",
			"--dry-run",
			"--porcelain",
			"origin",
			"HEAD:refs/heads/pi-sync-write-access-check",
		],
		{ timeout: 30000 },
	);
	if (probe.ok) return "writable";

	const output = `${probe.stderr}\n${probe.stdout}`;
	return /access denied|permission denied|permission to .* denied|authentication failed|write access (?:to repository )?not granted|could not read from remote repository|repository not found|not authorized|not permitted|http[^\n]*403/i.test(
		output,
	)
		? "denied"
		: "unknown";
}

async function scaffoldConfigRepoV2(repoPath: string): Promise<void> {
	const { mkdir: makeDir, writeFile } = await import("node:fs/promises");
	for (const dir of [
		"sync",
		"sync/extensions",
		"sync/skills",
		"sync/prompts",
		"sync/themes",
	]) {
		await makeDir(join(repoPath, dir), { recursive: true });
	}
	const piSync = {
		schemaVersion: 2,
		branch: "main",
		root: "sync",
		include: [
			"settings.json",
			"AGENTS.md",
			"SYSTEM.md",
			"APPEND_SYSTEM.md",
			"keybindings.json",
			"extensions/**",
			"skills/**",
			"prompts/**",
			"themes/**",
		],
		exclude: [
			"**/.DS_Store",
			"**/*.tmp",
			"**/*.log",
			"extensions/pi-sync/**",
			"extensions/**/.cache/**",
			"extensions/**/cache/**",
			"extensions/**/coverage/**",
			"extensions/**/logs/**",
			"extensions/**/temp/**",
			"extensions/**/tmp/**",
		],
		delete: "tracked",
		pullTimeoutMs: 10000,
		special: { "settings.json": "settings" },
	};
	await writeFile(
		join(repoPath, "pi-sync.json"),
		JSON.stringify(piSync, null, 2),
		"utf-8",
	);
	await writeFile(
		join(repoPath, "sync", "settings.json"),
		JSON.stringify({ packages: ["npm:@xyzensun/pi-sync"] }, null, 2),
		"utf-8",
	);
	const readmePath = join(repoPath, "README.md");
	if (!existsSync(readmePath)) {
		await writeFile(
			readmePath,
			"# Pi 配置仓库 / Pi Configuration Repository\n\n此仓库用于在多台设备之间同步 Pi 配置。\nThis repository stores Pi configuration synchronized across your machines.\n\n由 pi-sync (npm:@xyzensun/pi-sync) 创建和维护。\nCreated and maintained by pi-sync (npm:@xyzensun/pi-sync).\n",
			"utf-8",
		);
	}
	await writeFile(
		join(repoPath, ".gitignore"),
		"# 本机状态\n.pi-sync/\n",
		"utf-8",
	);
}

function urlsMatch(a: string, b: string): boolean {
	const normalize = (url: string) =>
		url
			.replace(/^https?:\/\//, "")
			.replace(/^ssh:\/\/git@/, "")
			.replace(/^git@/, "")
			.replace(/\.git$/, "")
			.replace(/:\d+\//, "/")
			.toLowerCase();
	return normalize(a) === normalize(b);
}

export async function clearRepoContents(repoPath: string): Promise<void> {
	if (!existsSync(repoPath)) return;
	try {
		const { readdir, rm } = await import("node:fs/promises");
		const entries = await readdir(repoPath, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name === ".git") continue;
			try {
				await rm(join(repoPath, entry.name), { recursive: true, force: true });
			} catch {
				// 尽力而为的清理，保持既有的清空仓库行为。
			}
		}
	} catch {
		// 尽力而为的清理，保持既有的清空仓库行为。
	}
}
