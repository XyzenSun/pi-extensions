import type { OperationResult } from "./operations.ts";

export interface SyncUi {
  hasUI: boolean;
  mode?: string;
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    input(title: string, placeholder?: string): Promise<string | undefined>;
    notify(message: string, level?: "info" | "warning" | "error"): void;
  };
}

export const SYNC_MENU_ITEMS = [
  "push - 镜像本机配置并推送",
  "recover - 从远端设备分支恢复本机",
  "publish - 强制以本机覆盖目标分支",
  "align - 强制以源分支覆盖本机",
  "merge-up - 合并本机到目标分支",
  "merge-down - 合并源分支到本机",
  "remote - 更换远端 URL",
  "rename - 重命名设备分支",
  "status - 查看状态",
] as const;

export async function confirmForceOperation(
  context: SyncUi,
  operation: "align" | "publish",
  affectedPaths: string[],
): Promise<boolean> {
  if (!context.hasUI) return true;
  const fileList = affectedPaths.length > 0
    ? affectedPaths.map((path) => `- ${path}`).join("\n")
    : "未检测到已追踪文件差异。";
  const selected = await context.ui.select(
    `确认 ${operation}: 此操作会强制覆盖配置文件。受影响文件:\n${fileList}`,
    ["取消", "继续执行"],
  );
  return selected === "继续执行";
}

/** recover 的确认: 无脑覆盖不做文件对比, 只确认操作本身, 默认停在取消。 */
export async function confirmRecovery(context: SyncUi): Promise<boolean> {
  if (!context.hasUI) return true;
  const selected = await context.ui.select(
    "recover 将用远端设备分支的内容无脑覆盖本机配置, 本机未 push 的改动会丢失。",
    ["取消", "继续执行"],
  );
  return selected === "继续执行";
}

export async function selectOperation(context: SyncUi, initialized: boolean): Promise<string | undefined> {
  if (!context.hasUI) return undefined;
  const options = initialized ? [...SYNC_MENU_ITEMS] : ["init - 初始化同步仓库"];
  const selected = await context.ui.select("pi-sync-pure 操作", options);
  return selected?.split(" - ")[0];
}

export async function promptForRemote(context: SyncUi): Promise<string | undefined> {
  if (!context.hasUI) return undefined;
  return context.ui.input("配置仓库 Git remote URL", "git@github.com:user/pi-config.git");
}

export async function promptForDeviceName(context: SyncUi, defaultName: string): Promise<string | undefined> {
  if (!context.hasUI) return undefined;
  const value = await context.ui.input("设备分支名 (推荐 device/<名称>, 可自定义)", defaultName);
  return value?.trim() || defaultName;
}

export async function selectClaimedBranch(context: SyncUi, branches: string[]): Promise<string | null | undefined> {
  if (!context.hasUI || branches.length === 0) return undefined;
  const selected = await context.ui.select("发现远端分支。选择要认领的分支, 或创建新分支", [
    ...branches,
    "创建新的分支",
  ]);
  if (!selected) return undefined;
  return selected === "创建新的分支" ? null : selected;
}

export function reportResult(context: SyncUi, result: OperationResult): void {
  const suffix = result.packagesMayHaveChanged
    ? "\n如 packages 声明有变化, 可运行 pi update --extensions 安装或更新扩展包。"
    : "";
  const message = `${result.message}${suffix}`;
  if (context.hasUI) context.ui.notify(message, "info");
  else console.log(message);
}

export function reportError(context: SyncUi, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (context.hasUI) context.ui.notify(message, "error");
  else console.error(message);
}

