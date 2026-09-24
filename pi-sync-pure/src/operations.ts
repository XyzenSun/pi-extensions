import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LocalState, PiSyncConfig, SyncPaths } from "./config.ts";
import { loadConfig, saveLocalState, writeDefaultConfig } from "./config.ts";
import { capture, type MirrorResult } from "./capture.ts";
import { materialize } from "./materialize.ts";
import {
  aheadBehind,
  changedPaths,
  cloneRepository,
  currentRemoteUrl,
  ensureValidBranchName,
  fetchOrigin,
  git,
  listConflictedPaths,
  listClaimableBranches,
  localBranchExists,
  remoteBranchExists,
  stageAndCommit,
} from "./git.ts";
import { withSyncLock } from "./lock.ts";

export type MergeStrategy = "ours" | "theirs" | undefined;

export interface OperationContext {
  paths: SyncPaths;
  state: LocalState;
}

export interface OperationResult {
  message: string;
  changedFiles?: string[];
  packagesMayHaveChanged?: boolean;
}

export async function initializeRepository(
  paths: SyncPaths,
  remoteUrl: string,
  deviceName: string,
  claimedBranch?: string,
  chooseClaim?: (branches: string[]) => Promise<string | null | undefined>,
  forceNewBranch = false,
): Promise<{ state: LocalState; result: OperationResult }> {
  return withSyncLock(async () => {
    if (existsSync(paths.repoPath)) throw new Error(`配置仓库目录已存在: ${paths.repoPath}`);
    if (!remoteUrl.trim()) throw new Error("remote URL 不能为空。");
    await mkdir(dirname(paths.repoPath), { recursive: true });
    await cloneRepository(remoteUrl, paths.repoPath);
    const configPath = join(paths.repoPath, "pi-sync.json");
    await fetchOrigin(paths.repoPath);

    const remoteClaimableBranches = await listClaimableBranches(paths.repoPath);

    // --new 表示强制新建设备分支, 不进入认领流程; 分支名的唯一性由用户自己确保。
    const selectedClaim = forceNewBranch
      ? null
      : claimedBranch ?? (remoteClaimableBranches.length > 0 ? await chooseClaim?.(remoteClaimableBranches) : undefined);
    if (remoteClaimableBranches.length > 0 && !claimedBranch && selectedClaim === undefined && !chooseClaim) {
      throw new Error(`远端存在其他分支: ${remoteClaimableBranches.join(", ")}。请通过认领参数接管其一, 或使用 --new 强制新建。`);
    }
    if (remoteClaimableBranches.length > 0 && chooseClaim && selectedClaim === undefined) {
      throw new Error("初始化已取消。");
    }
    const createNewBranch = selectedClaim === null;
    const selectedBranch = requireBranchName(typeof selectedClaim === "string" ? selectedClaim : deviceName);
    if (claimedBranch && !remoteClaimableBranches.includes(selectedBranch)) {
      throw new Error(`远端不存在可认领的分支: ${selectedBranch}`);
    }
    await ensureValidBranchName(paths.repoPath, selectedBranch);
    if (!remoteClaimableBranches.includes(selectedBranch) && !createNewBranch && await localBranchExists(paths.repoPath, selectedBranch)) {
      throw new Error(`本地设备分支已存在: ${selectedBranch}`);
    }
    if (remoteClaimableBranches.includes(selectedBranch)) {
      await git(paths.repoPath, ["checkout", "--force", "-B", selectedBranch, `origin/${selectedBranch}`]);
    } else {
      // 新建一律 orphan 空分支, 不基于 main: 设备分支与 main 之间没有隐含继承,
      // 内容交换只能通过显式的 push/merge-down/publish/align。
      await git(paths.repoPath, ["checkout", "--orphan", selectedBranch]);
      await git(paths.repoPath, ["clean", "-fdx"]);
      await scaffoldRepository(paths.repoPath);
    }
    if (await localBranchExists(paths.repoPath, "main")) {
      await git(paths.repoPath, ["branch", "-D", "main"]);
    }
    if (!existsSync(configPath)) await scaffoldRepository(paths.repoPath);

    // init 只负责建立身份: clone、建分支、写状态文件。要不要把本机配置 push 到
    // 设备分支、要不要从远端恢复, 是 push/recover 的职责——否则迁移场景下落后的
    // 本机配置会顶掉设备分支, recover 就拿不到远端的好配置了。
    const claimingExistingBranch = remoteClaimableBranches.includes(selectedBranch);
    const state = { remoteUrl, deviceBranch: selectedBranch };
    if (claimingExistingBranch) {
      await saveLocalState(paths.statePath, state);
      return {
        state,
        result: {
          message: `已认领设备分支 ${selectedBranch}。/pisync push 将远程分支覆盖为本机当前配置; /pisync recover 将本机恢复为远程仓库数据。`,
        },
      };
    }
    // 新建路径: scaffold 的配置引导需要一个初始提交让 orphan 分支真正诞生 (仅本地 commit, 不推送)。
    await stageAndCommit(paths.repoPath, "Initialize pi-sync-pure device branch");
    await saveLocalState(paths.statePath, state);
    return {
      state,
      result: {
        message: `初始化完成。当前远程分支为空, 建议 /pisync push 推送备份本机配置。`,
      },
    };
  });
}

/**
 * 把本机现状存档到设备分支: capture → commit → push -f。
 * 所有 merge/publish 前都先走这一步, 保证未存档的改动永远不会被后续操作覆盖丢失。
 * pushTarget 用于 publish 这类推到其他分支的变体。
 */
async function archiveLocal(context: OperationContext, config: PiSyncConfig, message: string, pushTarget?: string): Promise<{ committed: boolean; mirror: MirrorResult }> {
  const mirror = await capture(context.paths.agentDir, context.paths.repoPath, config);
  const committed = await stageAndCommit(context.paths.repoPath, message);
  const refspec = pushTarget === undefined ? "HEAD" : `HEAD:${pushTarget}`;
  await git(context.paths.repoPath, ["push", "-f", "origin", refspec], { timeoutMs: 120_000 });
  return { committed, mirror };
}

/** 把仓库内容应用回本机 agent 目录, 返回受影响文件与 packages 声明是否可能变化。 */
async function applyRepositoryToAgent(context: OperationContext, config: PiSyncConfig) {
  const packagesBefore = await packageDeclaration(context.paths.agentDir);
  const mirror = await materialize(context.paths.repoPath, context.paths.agentDir, config);
  const packagesAfter = await packageDeclaration(context.paths.agentDir);
  return {
    changedFiles: [...mirror.copied, ...mirror.deleted],
    packagesMayHaveChanged: packagesBefore !== packagesAfter,
  };
}

export async function push(context: OperationContext): Promise<OperationResult> {
  return withSyncLock(async () => {
    const config = await loadConfig(context.paths.repoPath);
    const { committed, mirror } = await archiveLocal(context, config, "Sync Pi configuration");
    return {
      message: committed ? `已推送到 ${context.state.deviceBranch}。` : `没有文件变化，已确认远端分支 ${context.state.deviceBranch} 最新。`,
      changedFiles: [...mirror.copied, ...mirror.deleted],
    };
  });
}

export async function recover(context: OperationContext, requestedBranch?: string): Promise<OperationResult> {
  return withSyncLock(async () => {
    await fetchOrigin(context.paths.repoPath);
    let deviceBranch = context.state.deviceBranch;
    if (requestedBranch) {
      deviceBranch = requireBranchName(requestedBranch);
      if (!(await remoteBranchExists(context.paths.repoPath, deviceBranch))) {
        throw new Error(`远端分支不存在: ${deviceBranch}`);
      }
      await git(context.paths.repoPath, ["checkout", "-B", deviceBranch, `origin/${deviceBranch}`]);
    }
    await git(context.paths.repoPath, ["reset", "--hard", `origin/${deviceBranch}`]);
    const config = await loadConfig(context.paths.repoPath);
    const applied = await applyRepositoryToAgent(context, config);
    if (deviceBranch !== context.state.deviceBranch) {
      context.state.deviceBranch = deviceBranch;
      await saveLocalState(context.paths.statePath, context.state);
    }
    return {
      message: `已从 ${deviceBranch} 恢复本机配置。`,
      ...applied,
    };
  });
}

export async function publish(context: OperationContext, targetBranch = "main"): Promise<OperationResult> {
  return withSyncLock(async () => {
    const config = await loadConfig(context.paths.repoPath);
    const { committed } = await archiveLocal(context, config, "Sync Pi configuration before publishing", targetBranch);
    return {
      message: `${committed ? "已提交并" : "本机无新改动, 已"}强制发布 ${context.state.deviceBranch} 到 ${targetBranch}。`,
    };
  });
}

export async function align(context: OperationContext, sourceBranch = "main"): Promise<OperationResult> {
  return withSyncLock(async () => {
    await fetchOrigin(context.paths.repoPath);
    if (!(await remoteBranchExists(context.paths.repoPath, sourceBranch))) throw new Error(`远端分支不存在: ${sourceBranch}`);
    await git(context.paths.repoPath, ["reset", "--hard", `origin/${sourceBranch}`]);
    const config = await loadConfig(context.paths.repoPath);
    const applied = await applyRepositoryToAgent(context, config);
    return {
      message: `已用 origin/${sourceBranch} 覆盖本机分支 ${context.state.deviceBranch}。`,
      ...applied,
    };
  });
}

export async function mergeUp(context: OperationContext, targetBranch = "main", strategy?: MergeStrategy): Promise<OperationResult> {
  return withSyncLock(async () => {
    // 先存档本机改动再操作目标分支: 设备分支是本机现状的镜像, merge 前先 push
    // 保证任何后续失败都不会丢失未存档的改动。
    const config = await loadConfig(context.paths.repoPath);
    await archiveLocal(context, config, "Sync Pi configuration before merge-up");
    await fetchOrigin(context.paths.repoPath);

    const originalBranch = context.state.deviceBranch;
    if (await localBranchExists(context.paths.repoPath, targetBranch)) {
      await git(context.paths.repoPath, ["checkout", targetBranch]);
      await git(context.paths.repoPath, ["reset", "--hard", `origin/${targetBranch}`]);
    } else if (await remoteBranchExists(context.paths.repoPath, targetBranch)) {
      await git(context.paths.repoPath, ["checkout", "-b", targetBranch, `origin/${targetBranch}`]);
    } else {
      throw new Error(`远端分支不存在: ${targetBranch}; 请先使用 /pisync publish ${targetBranch} 创建。`);
    }

    try {
      await mergeBranch(context.paths.repoPath, originalBranch, strategy);
      await git(context.paths.repoPath, ["push", "origin", targetBranch], { timeoutMs: 120_000 });
    } catch (error) {
      throw await abortAndFormatMergeError(context.paths.repoPath, error);
    } finally {
      // 目标分支只是临时 checkout, 用完即删, 本地长期只驻留设备分支。
      if (await localBranchExists(context.paths.repoPath, originalBranch)) {
        await git(context.paths.repoPath, ["checkout", originalBranch]).catch(() => undefined);
      }
      if (await localBranchExists(context.paths.repoPath, targetBranch)) {
        await git(context.paths.repoPath, ["branch", "-D", targetBranch]).catch(() => undefined);
      }
    }
    return { message: `已将 ${originalBranch} 合并到 ${targetBranch} 并推送。` };
  });
}

export async function mergeDown(context: OperationContext, sourceBranch = "main", strategy?: MergeStrategy): Promise<OperationResult> {
  return withSyncLock(async () => {
    // 先存档本机改动再合并: 未 push 的改动一旦被后续 materialize 覆盖,
    // 就再也无法找回, 所以 merge 前必须先落进设备分支历史。
    const config = await loadConfig(context.paths.repoPath);
    await archiveLocal(context, config, "Sync Pi configuration before merge-down");
    await fetchOrigin(context.paths.repoPath);
    if (!(await remoteBranchExists(context.paths.repoPath, sourceBranch))) throw new Error(`远端分支不存在: ${sourceBranch}`);
    try {
      await mergeBranch(context.paths.repoPath, `origin/${sourceBranch}`, strategy);
    } catch (error) {
      throw await abortAndFormatMergeError(context.paths.repoPath, error);
    }
    const applied = await applyRepositoryToAgent(context, config);
    return {
      message: `已将 origin/${sourceBranch} 合并到 ${context.state.deviceBranch}。`,
      ...applied,
    };
  });
}

export async function changeRemote(context: OperationContext, remoteUrl: string): Promise<OperationResult> {
  return withSyncLock(async () => {
    if (!remoteUrl.trim()) throw new Error("remote URL 不能为空。");
    const previousUrl = await currentRemoteUrl(context.paths.repoPath);
    await git(context.paths.repoPath, ["remote", "set-url", "origin", remoteUrl]);
    try {
      await fetchOrigin(context.paths.repoPath);
    } catch (error) {
      await git(context.paths.repoPath, ["remote", "set-url", "origin", previousUrl]);
      throw new Error(`新 remote 验证失败, 已回滚到原 URL。${error instanceof Error ? ` ${error.message}` : ""}`);
    }
    context.state.remoteUrl = remoteUrl;
    await saveLocalState(context.paths.statePath, context.state);
    return { message: `origin 已更新并验证: ${remoteUrl}` };
  });
}

export async function renameDevice(context: OperationContext, requestedName: string): Promise<OperationResult> {
  return withSyncLock(async () => {
    const oldBranch = context.state.deviceBranch;
    const newBranch = requireBranchName(requestedName);
    await fetchOrigin(context.paths.repoPath);
    await ensureValidBranchName(context.paths.repoPath, newBranch);
    if (oldBranch === newBranch) throw new Error("新分支名与当前设备分支相同。");
    if (await localBranchExists(context.paths.repoPath, newBranch)) throw new Error(`本地分支已存在: ${newBranch}`);
    await git(context.paths.repoPath, ["branch", "-m", oldBranch, newBranch]);
    try {
      await git(context.paths.repoPath, ["push", "-f", "origin", newBranch], { timeoutMs: 120_000 });
    } catch (error) {
      await git(context.paths.repoPath, ["branch", "-m", newBranch, oldBranch]).catch(() => undefined);
      throw error;
    }
    context.state.deviceBranch = newBranch;
    await saveLocalState(context.paths.statePath, context.state);
    return { message: `设备分支已改名为 ${newBranch}。远端旧分支 ${oldBranch} 保留不删除。` };
  });
}

export async function status(context: OperationContext): Promise<OperationResult> {
  return withSyncLock(async () => {
    const statusOutput = (await git(context.paths.repoPath, ["status", "--short", "--branch", "--untracked-files=all"])).stdout.trimEnd();
    const tracking = await aheadBehind(context.paths.repoPath, context.state.deviceBranch);
    const branchLine = tracking
      ? `\n远端 ahead/behind: 本地 ahead ${tracking.ahead}, behind ${tracking.behind}`
      : "\n远端设备分支尚不存在。";
    return { message: `${statusOutput || "工作区干净"}${branchLine}` };
  });
}

/**
 * force 覆盖没有 merge base 的概念, 用两点 diff 直接对比两侧分支头,
 * 输出即覆盖后内容会变化的文件。只做文件级展示, 不做行级; 仓库根的
 * pi-sync.json 等非 sync/ 文件不会落回本机, 不列入展示。
 */
export async function previewForceChanges(context: OperationContext, target: string): Promise<string[]> {
  if (!(await remoteBranchExists(context.paths.repoPath, target))) return [];
  const paths = await changedPaths(context.paths.repoPath, "HEAD", `origin/${target}`);
  return paths
    .filter((path) => path.startsWith("sync/"))
    .map((path) => path.slice("sync/".length))
    .sort();
}

export async function runAutoSync(context: OperationContext): Promise<OperationResult | undefined> {
  return withSyncLock(async () => {
    // autoSync = 自动执行的 merge-down --main --theirs: 先把本机现状 push 到设备分支
    // 完成存档, 再从 main 合并。设备分支本来就是本机镜像, push 它不影响任何其他设备。
    const config = await loadConfig(context.paths.repoPath);
    await archiveLocal(context, config, "Auto-sync Pi configuration");
    await fetchOrigin(context.paths.repoPath);
    if (!(await remoteBranchExists(context.paths.repoPath, "main"))) return undefined;
    const headBefore = (await git(context.paths.repoPath, ["rev-parse", "HEAD"])).stdout.trim();
    try {
      await git(context.paths.repoPath, ["merge", "-X", "theirs", "--no-edit", "origin/main"]);
    } catch (error) {
      throw await abortAndFormatMergeError(context.paths.repoPath, error);
    }
    const headAfter = (await git(context.paths.repoPath, ["rev-parse", "HEAD"])).stdout.trim();
    // HEAD 未移动说明 main 没有新内容, 静默结束, 不打扰用户。
    if (headAfter === headBefore) return undefined;
    const applied = await applyRepositoryToAgent(context, config);
    return {
      message: "autoSync 已从 main 合并新配置, 请执行 /reload 使其生效。",
      ...applied,
    };
  });
}

/** 分支名不做任何改写 (device/ 只是推荐前缀), 只校验非空。 */
export function requireBranchName(value: string): string {
  const branch = value.trim();
  if (!branch || branch.endsWith("/")) throw new Error("分支名不能为空。");
  return branch;
}

export function parseMergeStrategy(args: string[], allowed: readonly ("ours" | "theirs")[]): MergeStrategy {
  const strategies = args.filter((argument) => argument === "--ours" || argument === "--theirs");
  const unexpected = args.filter((argument) => !allowed.some((strategy) => argument === `--${strategy}`));
  if (unexpected.length > 0) throw new Error(`不支持的参数: ${unexpected.join(" ")}`);
  if (strategies.length > 1) throw new Error("--ours 与 --theirs 不能同时使用。");
  return strategies[0]?.slice(2) as MergeStrategy;
}

async function mergeBranch(repoPath: string, branch: string, strategy?: MergeStrategy): Promise<void> {
  const args = ["merge"];
  if (strategy) args.push("-X", strategy);
  args.push("--no-edit", branch);
  await git(repoPath, args);
}

async function abortMerge(repoPath: string): Promise<void> {
  await git(repoPath, ["merge", "--abort"]).catch(() => undefined);
}

async function abortAndFormatMergeError(repoPath: string, error: unknown): Promise<Error> {
  const conflicts = await listConflictedPaths(repoPath).catch(() => []);
  await abortMerge(repoPath);
  if (conflicts.length > 0) {
    return new Error(`合并冲突已中止; 当前工作树已恢复。冲突文件:\n${conflicts.map((path) => `- ${path}`).join("\n")}\n请自行处理后重试, 或选择带 --ours/--theirs 的策略。`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function packageDeclaration(agentDir: string): Promise<string | undefined> {
  try {
    const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as { packages?: unknown };
    return JSON.stringify(settings?.packages);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function scaffoldRepository(repoPath: string): Promise<void> {
  for (const directory of ["sync", "sync/extensions", "sync/skills", "sync/prompts", "sync/themes"]) {
    await mkdir(join(repoPath, directory), { recursive: true });
  }
  const configPath = join(repoPath, "pi-sync.json");
  if (!existsSync(configPath)) await writeDefaultConfig(repoPath);


  const gitignorePath = join(repoPath, ".gitignore");
  if (!existsSync(gitignorePath)) {
    await writeFile(gitignorePath, "# 本地 pi-sync-pure 状态\n.pi-sync-pure/\n", "utf8");
  }
  const readmePath = join(repoPath, "README.md");
  if (!existsSync(readmePath)) {
    await writeFile(readmePath, "# Pi configuration repository\n\n由 pi-sync-pure 管理的 Pi 配置仓库。\n", "utf8");
  }
}
