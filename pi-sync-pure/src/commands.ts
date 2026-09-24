import { existsSync } from "node:fs";
import { loadLocalState, getSyncPaths, type LocalState, type SyncPaths } from "./config.ts";
import { fetchOrigin } from "./git.ts";
import { defaultDeviceName } from "./device-id.ts";
import {
  align,
  changeRemote,
  initializeRepository,
  mergeDown,
  mergeUp,
  normalizeDeviceBranch,
  normalizeTargetBranch,
  parseMergeStrategy,
  previewForceChanges,
  publish,
  push,
  recover,
  renameDevice,
  runAutoSync,
  status,
  type OperationContext,
} from "./operations.ts";
import {
  confirmForceOperation,
  confirmRecovery,
  promptForDeviceName,
  promptForRemote,
  reportError,
  reportResult,
  selectClaimedBranch,
  selectOperation,
  type SyncUi,
} from "./ui.ts";

export const USAGE = `用法: /pisync <命令> [参数]

命令:
  init <remote-url> [设备名] [device/分支] [--new]  初始化或认领设备分支; --new 强制新建
  push                                      镜像本机配置并推送到设备分支
  recover [device/分支]                      从远端设备分支无脑覆盖恢复本机
  publish [目标分支]                         强制以本机设备分支覆盖目标 (默认 main)
  align [源分支]                             强制以源分支覆盖本机设备分支 (默认 main)
  merge-up [目标分支] [--ours|--theirs]      合并本机到目标分支并推送 (默认 main)
  merge-down [源分支] [--theirs|--ours]      合并源分支到本机 (默认 main)
  remote <url>                              更换并验证 origin URL
  rename <新设备名>                          重命名设备分支 (不删除旧远端分支)
  status                                    查看工作区及远端 ahead/behind

分支参数中裸名会自动补 device/ 前缀, main 保持原样。
交互会话中可直接执行 /pisync 打开操作菜单。`;

export interface CommandContext extends SyncUi {
  cwd: string;
}

export async function handleSyncCommand(rawArgs: string, context: CommandContext): Promise<void> {
  const args = rawArgs.trim().split(/\s+/).filter(Boolean);
  const paths = getSyncPaths();
  let state: LocalState | undefined;
  try {
    state = await loadLocalState(paths.statePath);
    if (args.length === 0 && context.hasUI) {
      const selected = await selectOperation(context, Boolean(state && existsSync(paths.repoPath)));
      if (!selected) return;
      args.push(selected);
    } else if (args.length === 0) {
      outputUsage(context);
      return;
    }

    const command = args.shift()!;
    if (command === "init") {
      await initializeCommand(args, paths, context);
      return;
    }
    if (!state || !existsSync(paths.repoPath)) {
      throw new Error(`尚未初始化。交互会话可执行 /pisync 并选择 init; 非交互会话请执行 /pisync init <remote-url> [设备名]。`);
    }
    const operationContext: OperationContext = { paths, state };
    let result;

    switch (command) {
      case "push":
        assertNoArgs(args);
        result = await push(operationContext);
        break;
      case "recover": {
        if (args.length > 1) throw new Error("recover 最多接受一个设备分支名。");
        // recover 是无脑覆盖, 不做受影响文件对比, 只确认操作本身。
        if (!await confirmRecovery(context)) return;
        result = await recover(operationContext, args[0]);
        break;
      }
      case "publish": {
        if (args.length > 1) throw new Error("用法: /pisync publish [目标分支]");
        const target = args[0] ? normalizeTargetBranch(args[0]) : undefined;
        if (!await confirmForceOperation(context, "publish", await listForceChanges(paths, state, target))) return;
        result = await publish(operationContext, target);
        break;
      }
      case "align": {
        if (args.length > 1) throw new Error("用法: /pisync align [源分支]");
        const source = args[0] ? normalizeTargetBranch(args[0]) : undefined;
        if (!await confirmForceOperation(context, "align", await listForceChanges(paths, state, source))) return;
        result = await align(operationContext, source);
        break;
      }
      case "merge-up": {
        const { positional, flags } = splitBranchAndFlags(args);
        if (positional.length > 1) throw new Error("用法: /pisync merge-up [目标分支] [--ours|--theirs]");
        result = await mergeUp(operationContext, positional[0] ? normalizeTargetBranch(positional[0]) : undefined, parseMergeStrategy(flags, ["ours", "theirs"]));
        break;
      }
      case "merge-down": {
        const { positional, flags } = splitBranchAndFlags(args);
        if (positional.length > 1) throw new Error("用法: /pisync merge-down [源分支] [--theirs|--ours]");
        result = await mergeDown(operationContext, positional[0] ? normalizeTargetBranch(positional[0]) : undefined, parseMergeStrategy(flags, ["theirs", "ours"]));
        break;
      }
      case "remote":
        if (args.length !== 1) throw new Error("用法: /pisync remote <url>");
        result = await changeRemote(operationContext, args[0]!);
        break;
      case "rename":
        if (args.length !== 1) throw new Error("用法: /pisync rename <新设备名>");
        result = await renameDevice(operationContext, args[0]!);
        break;
      case "status":
        assertNoArgs(args);
        result = await status(operationContext);
        break;
      default:
        throw new Error(`未知命令: ${command}\n\n${USAGE}`);
    }
    reportResult(context, result);
  } catch (error) {
    reportError(context, error);
  }
}

export async function initializeCommand(args: string[], paths: SyncPaths, context: CommandContext): Promise<void> {
  try {
    // --new 是标志而非位置参数, 先剥离再校验位置参数个数, 避免它占用认领分支的位置。
    const forceNewBranch = args.includes("--new");
    const positional = args.filter((argument) => argument !== "--new");
    let remoteUrl: string | undefined = positional[0];
    if (!remoteUrl && context.hasUI) remoteUrl = await promptForRemote(context);
    if (!remoteUrl) throw new Error("用法: /pisync init <remote-url> [设备名] [device/分支] [--new]");

    let deviceName: string | undefined = positional[1];
    if (!deviceName && context.hasUI) deviceName = await promptForDeviceName(context, await defaultDeviceName());
    if (!deviceName) deviceName = await defaultDeviceName();
    const explicitClaim = positional[2] ? normalizeDeviceBranch(positional[2]) : undefined;
    if (positional.length > 3) throw new Error("用法: /pisync init <remote-url> [设备名] [device/分支] [--new]");
    if (forceNewBranch && explicitClaim) throw new Error("--new 与认领分支参数不能同时使用。");
    const result = await initializeRepository(
      paths,
      remoteUrl,
      deviceName,
      explicitClaim,
      context.hasUI ? (branches) => selectClaimedBranch(context, branches) : undefined,
      forceNewBranch,
    );
    reportResult(context, result.result);
  } catch (error) {
    reportError(context, error);
  }
}

/** autoSync 结果的输出通道: 有会话 UI 时走 notify, 避免裸 console 污染 TUI 渲染。 */
export interface NotifyChannel {
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

export async function tryAutoSync(paths: SyncPaths, notify?: NotifyChannel): Promise<void> {
  try {
    const state = await loadLocalState(paths.statePath);
    if (!state || !existsSync(paths.repoPath)) return;
    const result = await runAutoSync({ paths, state });
    if (!result) return;
    if (notify) notify.notify(result.message, "info");
    else console.log(result.message);
  } catch (error) {
    const message = `pi-sync-pure autoSync: ${error instanceof Error ? error.message : String(error)}`;
    if (notify) notify.notify(message, "error");
    else console.warn(message);
  }
}

export async function listForceChanges(
  paths: SyncPaths,
  state: LocalState,
  requestedTarget?: string,
): Promise<string[]> {
  // publish 与 align 都是对齐指定分支, 未指定时默认 main。
  const target = requestedTarget ?? "main";
  await fetchOrigin(paths.repoPath);
  return previewForceChanges({ paths, state }, target);
}

/** 把分支名与 --ours/--theirs 标志分开, 分支名不参与策略校验。 */
function splitBranchAndFlags(args: string[]): { positional: string[]; flags: string[] } {
  return {
    positional: args.filter((argument) => !argument.startsWith("--")),
    flags: args.filter((argument) => argument.startsWith("--")),
  };
}

function assertNoArgs(args: string[]): void {
  if (args.length > 0) throw new Error(`该命令不接受参数: ${args.join(" ")}`);
}

function outputUsage(context: CommandContext): void {
  if (context.hasUI) context.ui.notify(USAGE, "info");
  else console.log(USAGE);
}
