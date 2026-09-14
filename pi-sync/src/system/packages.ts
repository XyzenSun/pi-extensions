/**
 * 包声明、信任记录与协调。
 *
 * 远端 settings 是数据，不等于执行代码的许可。新增或变更的包源
 * 必须经过显式审批，才会运行 `pi install` 或 `pi remove`。
 */
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { PiSyncConfig } from "../sync/config.ts";
import { SYNC_PACKAGE_SOURCE } from "../sync/adapter-runtime.ts";
import { getOperationSignal } from "./operation-context.ts";
import { resolveRepoSyncRoot, resolveWithinRoot } from "./path-safety.ts";

const execFileAsync = promisify(execFileCb);

// ========== 类型 ==========

export interface PackageDeclaration {
	source: string;
	normalizedSource: string;
}

export interface PackageTrustStore {
	schemaVersion: 1;
	approved: Record<string, string>;
}

export interface PackagePlan {
	added: PackageDeclaration[];
	changed: Array<{ local: PackageDeclaration; remote: PackageDeclaration }>;
	unchanged: PackageDeclaration[];
	/** 在本机声明、但共享 settings 中已不存在（即传入的删除）。 */
	removed: PackageDeclaration[];
	approvalRequired: string[];
}

export interface PackageApproval {
	approvedSources: string[];
	remember?: boolean;
}

export interface PackageDiff {
	added: string[];
	removed: string[];
	changed: string[];
	unchanged: string[];
}

export interface ReconcileResult {
	installed: string[];
	errors: string[];
	approvalRequired?: string[];
	/** 后续安装失败后，成功恢复或移除的包源。 */
	rolledBack?: string[];
	/** 未能完成的回滚操作。 */
	rollbackErrors?: string[];
	/** 已用 `pi remove` 清除残留安装内容的包源。 */
	removed?: string[];
	/** 尽力而为的移除失败；本设备上可能仍残留内容。 */
	removeWarnings?: string[];
}

// ========== 安全解析 ==========

function validatePackageSource(source: unknown): string {
	if (typeof source !== "string" || source.length === 0) {
		throw new Error("包源必须是非空字符串");
	}
	if (/[\u0000-\u001f\u007f]/.test(source)) {
		throw new Error(
			`包源包含控制字符：${JSON.stringify(source)}`,
		);
	}
	if (/^(?:file:|\.\.?[\\/]|[\\/]||~[\\/])/i.test(source)) {
		throw new Error(`不允许使用本机包路径：${source}`);
	}
	if (!/^(?:npm:|git:|https?:\/\/|ssh:\/\/)/i.test(source)) {
		throw new Error(`不支持的包源：${source}`);
	}
	return source;
}

export function parsePackageDeclarations(
	settings: Record<string, unknown>,
	opts?: { skipInvalid?: boolean },
): PackageDeclaration[] {
	const raw = settings.packages;
	if (raw === undefined) return [];
	if (!Array.isArray(raw))
		throw new Error("settings.json 的 packages 必须是数组");

	const results: PackageDeclaration[] = [];
	for (const entry of raw) {
		const source =
			typeof entry === "string"
				? entry
				: typeof entry === "object" &&
						entry !== null &&
						!Array.isArray(entry) &&
						"source" in entry
					? (entry as { source?: unknown }).source
					: undefined;
		try {
			const validated = validatePackageSource(source);
			results.push({
				source: validated,
				normalizedSource: normalizePackageName(validated),
			});
		} catch (err) {
			if (!opts?.skipInvalid) throw err;
			// 设置 skipInvalid 时（用于本机 agent settings），静默跳过
			// 机器专属的本地路径。用户可能 `pi install` 了一份本地开发副本，
			// 这类内容绝不应同步到其它机器。
		}
	}
	return results;
}

async function readSettingsObject(
	path: string,
): Promise<Record<string, unknown>> {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			throw new Error("settings.json 必须包含一个 JSON 对象");
		}
		return parsed as Record<string, unknown>;
	} catch (error) {
		throw new Error(`无法解析 settings.json（${path}）：${String(error)}`);
	}
}

// ========== 信任记录 ==========

export function getPackageTrustPath(agentDir: string): string {
	return join(agentDir, ".pi-sync", "package-trust.json");
}

export async function loadPackageTrust(
	agentDir: string,
): Promise<PackageTrustStore> {
	const path = getPackageTrustPath(agentDir);
	if (!existsSync(path)) return { schemaVersion: 1, approved: {} };
	try {
		const parsed = JSON.parse(
			await readFile(path, "utf-8"),
		) as Partial<PackageTrustStore>;
		if (
			parsed.schemaVersion !== 1 ||
			typeof parsed.approved !== "object" ||
			parsed.approved === null
		) {
			throw new Error("信任记录的 schema 无效");
		}
		return { schemaVersion: 1, approved: { ...parsed.approved } };
	} catch (error) {
		throw new Error(`无法读取包信任记录：${String(error)}`);
	}
}

export async function savePackageTrust(
	agentDir: string,
	store: PackageTrustStore,
): Promise<void> {
	const path = getPackageTrustPath(agentDir);
	const temp = join(dirname(path), `.package-trust-${randomUUID()}.tmp`);
	await mkdir(dirname(path), { recursive: true });
	try {
		await writeFile(temp, JSON.stringify(store, null, 2), "utf-8");
		await rename(temp, path);
	} finally {
		await import("node:fs/promises")
			.then(({ rm }) => rm(temp, { force: true }))
			.catch(() => undefined);
	}
}

// ========== 计划 ==========

export function planPackageChanges(
	localSettings: Record<string, unknown>,
	remoteSettings: Record<string, unknown>,
	trustStore: PackageTrustStore,
): PackagePlan {
	const local = parsePackageDeclarations(localSettings, { skipInvalid: true });
	const remote = parsePackageDeclarations(remoteSettings);
	const localMap = new Map(
		local.map((entry) => [entry.normalizedSource, entry]),
	);
	const added = remote.filter((entry) => !localMap.has(entry.normalizedSource));
	const changed: Array<{
		local: PackageDeclaration;
		remote: PackageDeclaration;
	}> = [];
	const unchanged: PackageDeclaration[] = [];

	for (const remoteEntry of remote) {
		const localEntry = localMap.get(remoteEntry.normalizedSource);
		if (localEntry) {
			if (localEntry.source === remoteEntry.source) {
				unchanged.push(remoteEntry);
			} else {
				changed.push({ local: localEntry, remote: remoteEntry });
			}
		}
	}

	const required = [
		...added.map((entry) => entry.source),
		...changed.map((entry) => entry.remote.source),
	]
		.filter((source) => !isBuiltInTrustedSource(source))
		.filter(
			(source) => trustStore.approved[normalizePackageName(source)] !== source,
		);
	const remoteMap = new Map(
		remote.map((entry) => [entry.normalizedSource, entry]),
	);
	const removed = local.filter(
		(entry) => !remoteMap.has(entry.normalizedSource),
	);
	return {
		added,
		changed,
		unchanged,
		removed,
		approvalRequired: [...new Set(required)],
	};
}

export function approvePackagePlan(
	plan: PackagePlan,
	approval: PackageApproval,
): { approved: boolean; missing: string[] } {
	const approved = new Set(approval.approvedSources);
	const missing = plan.approvalRequired.filter(
		(source) => !approved.has(source),
	);
	return { approved: missing.length === 0, missing };
}

/**
 * 读取两份 settings 文件并构建包计划，期间不调用 Pi。
 * 调用方可以在落地 settings 之前先执行本函数，从而保证在远端的包声明
 * 进入 agent 目录之前，审批总是已经取得。
 */
export async function preparePackagePlan(
	repoPath: string,
	agentDir: string,
	config: PiSyncConfig,
): Promise<PackagePlan> {
	const safeRoot = await resolveRepoSyncRoot(repoPath, config.root, "read");
	const repoSettingsPath = await resolveWithinRoot(
		safeRoot,
		"settings.json",
		"read",
	);
	const localSettingsPath = await resolveWithinRoot(
		agentDir,
		"settings.json",
		"read",
	);
	const repoSettings = await readSettingsObject(repoSettingsPath);
	const localSettings = await readSettingsObject(localSettingsPath);
	const trust = await loadPackageTrust(agentDir);
	return planPackageChanges(localSettings, repoSettings, trust);
}

// ========== 差异计算 ==========

export async function getPackageDiff(
	repoPath: string,
	agentDir: string,
	config: PiSyncConfig,
): Promise<PackageDiff> {
	const safeRoot = await resolveRepoSyncRoot(repoPath, config.root, "read");
	const repoSettingsPath = await resolveWithinRoot(
		safeRoot,
		"settings.json",
		"read",
	);
	const localSettingsPath = await resolveWithinRoot(
		agentDir,
		"settings.json",
		"read",
	);
	const repoPackages = parsePackageDeclarations(
		await readSettingsObject(repoSettingsPath),
	);
	const localPackages = parsePackageDeclarations(
		await readSettingsObject(localSettingsPath),
		{ skipInvalid: true },
	);
	const repoSet = new Set(repoPackages.map((entry) => entry.normalizedSource));
	const localSet = new Set(
		localPackages.map((entry) => entry.normalizedSource),
	);

	const added = repoPackages
		.filter((entry) => !localSet.has(entry.normalizedSource))
		.map((entry) => entry.source);
	const removed = localPackages
		.filter((entry) => !repoSet.has(entry.normalizedSource))
		.map((entry) => entry.source);
	const unchanged = repoPackages
		.filter(
			(entry) =>
				localSet.has(entry.normalizedSource) &&
				localPackages.some((local) => local.source === entry.source),
		)
		.map((entry) => entry.source);
	const changed: string[] = [];
	for (const remote of repoPackages) {
		const local = localPackages.find(
			(entry) => entry.normalizedSource === remote.normalizedSource,
		);
		if (local && local.source !== remote.source) changed.push(remote.source);
	}
	return { added, removed, changed, unchanged };
}

// ========== 执行 ==========

export interface PackageExecutionOptions {
	approval?: PackageApproval;
	/** 用户已确认要清除其残留安装内容的包源。 */
	removals?: ReadonlySet<string>;
	signal?: AbortSignal;
}

interface PackageAction {
	source: string;
	previousSource?: string;
}

interface RollbackResult {
	rolledBack: string[];
	errors: string[];
}

async function rollbackPackageActions(
	actions: PackageAction[],
	agentDir: string,
): Promise<RollbackResult> {
	const rolledBack: string[] = [];
	const errors: string[] = [];
	const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };

	for (const action of [...actions].reverse()) {
		try {
			await execFileAsync(
				"pi",
				["remove", normalizePackageName(action.source)],
				{
					env,
					timeout: 60000,
				},
			);
			rolledBack.push(action.source);
		} catch (error) {
			errors.push(`移除 ${action.source}：${String(error)}`);
		}

		if (
			action.previousSource &&
			!isBuiltInTrustedSource(action.previousSource)
		) {
			try {
				await execFileAsync("pi", ["install", action.previousSource], {
					env,
					timeout: 120000,
				});
				rolledBack.push(action.previousSource);
			} catch (error) {
				errors.push(`恢复 ${action.previousSource}：${String(error)}`);
			}
		}
	}

	return { rolledBack, errors };
}

/**
 * 执行事先准备好的包计划。本函数有意不读写 settings.json：
 * 调用方应先落地 settings，再调用本函数，并且只有在其成功之后
 * 才持久化同步状态。
 */
export async function executePackagePlan(
	plan: PackagePlan,
	agentDir: string,
	options: PackageExecutionOptions = {},
): Promise<ReconcileResult> {
	const result: ReconcileResult = { installed: [], errors: [] };
	const signal = options.signal ?? getOperationSignal();
	const removals = options.removals;
	const toRemove =
		removals === undefined
			? []
			: plan.removed.filter(
					(entry) =>
						!isBuiltInTrustedSource(entry.source) && removals.has(entry.source),
			);

	if (plan.approvalRequired.length > 0) {
		const approval = options.approval;
		if (!approval || !approvePackagePlan(plan, approval)) {
			result.approvalRequired = plan.approvalRequired;
			result.errors.push(
				`安装前需要包审批：${plan.approvalRequired.join("、")}`,
			);
			return result;
		}
	}

	const toInstall = [
		...plan.added.map((entry) => entry.source),
		...plan.changed.map((entry) => entry.remote.source),
	].filter((source) => !isBuiltInTrustedSource(source));
	if (toInstall.length === 0 && toRemove.length === 0) return result;

	if (!(await isPiCliAvailable(signal))) {
		const manualCommands = [
			...toInstall.map((pkg) => `pi install ${pkg}`),
			...toRemove.map((entry) => `pi remove ${normalizePackageName(entry.source)}`),
		];
		result.errors.push(
			signal?.aborted
				? "包安装已取消。"
				: `pi CLI 不可用。请手动执行：${manualCommands.join("; ")}`,
		);
		return result;
	}

	const actions: PackageAction[] = [];
	for (const source of toInstall) {
		if (signal?.aborted) {
			result.errors.push("包安装已取消。");
			break;
		}
		const changed = plan.changed.find(
			(entry) => entry.remote.source === source,
		);
		const action: PackageAction = {
			source,
			previousSource: changed?.local.source,
		};

		try {
			if (changed) {
				await execFileAsync("pi", ["remove", normalizePackageName(source)], {
					env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
					timeout: 60000,
					signal,
				}).catch((error: unknown) => {
					if (signal?.aborted) throw error;
				});
			}
			await execFileAsync("pi", ["install", source], {
				env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
				timeout: 120000,
				signal,
			});
			result.installed.push(source);
		} catch (error) {
			result.errors.push(
				signal?.aborted
					? `处理 ${source} 时包安装已取消。`
					: `安装 ${source} 失败：${String(error)}`,
			);
		}
		actions.push(action);
		if (signal?.aborted) break;
	}

	if (result.errors.length > 0 && !signal?.aborted) {
		const rollback = await rollbackPackageActions(actions, agentDir);
		if (rollback.rolledBack.length > 0) result.rolledBack = rollback.rolledBack;
		if (rollback.errors.length > 0) {
			result.rollbackErrors = rollback.errors;
			result.errors.push(
				...rollback.errors.map((message) => `回滚失败：${message}`),
			);
		}
	}

	// 只有在所有请求的安装都完成之后，才提交"记住"的审批。
	// 一次失败的安装绝不能悄悄扩大信任记录。
	if (
		result.errors.length === 0 &&
		options.approval?.remember &&
		plan.approvalRequired.length > 0
	) {
		const trust = await loadPackageTrust(agentDir);
		for (const source of plan.approvalRequired) {
			trust.approved[normalizePackageName(source)] = source;
		}
		await savePackageTrust(agentDir, trust);
	}

	// 卸载已确认的残留内容。某个包在本设备上从未安装过是常见情况，
	// 因此这里的失败只作为警告，绝不阻塞同步。
	if (result.errors.length === 0 && toRemove.length > 0) {
		const removed: string[] = [];
		const removeWarnings: string[] = [];
		for (const entry of toRemove) {
			if (signal?.aborted) {
				removeWarnings.push(
					`处理 ${entry.source} 时移除已取消。`,
				);
				continue;
			}
			try {
				await execFileAsync("pi", ["remove", normalizePackageName(entry.source)], {
					env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
					timeout: 60000,
					signal,
				});
				removed.push(entry.source);
			} catch (error) {
				removeWarnings.push(`无法移除 ${entry.source}：${String(error)}`);
			}
		}
		if (removed.length > 0) result.removed = removed;
		if (removeWarnings.length > 0) result.removeWarnings = removeWarnings;
	}

	return result;
}


async function isPiCliAvailable(signal?: AbortSignal): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync("pi", ["--version"], {
			timeout: 10000,
			signal,
		});
		return stdout.trim().length > 0;
	} catch {
		return false;
	}
}

function isBuiltInTrustedSource(source: string): boolean {
	// 同步开始之前，正在运行的本扩展就已经安装好了。
	return source === SYNC_PACKAGE_SOURCE;
}

function normalizePackageName(pkg: string): string {
	const npmMatch = pkg.match(/^npm:(.+?)(?:@[\d.].*)?$/);
	if (npmMatch) return npmMatch[1]!;
	const gitMatch = pkg.match(/^(?:git:)?(.+?)(?:@.+)?$/);
	if (gitMatch) {
		let name = gitMatch[1]!;
		name = name.replace(/^https?:\/\//, "");
		name = name.replace(/^ssh:\/\//, "");
		return name;
	}
	return pkg;
}
