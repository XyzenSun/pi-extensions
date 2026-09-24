import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSyncPaths, loadConfig } from "./src/config.ts";
import { loadLocalState } from "./src/config.ts";
import { handleSyncCommand, tryAutoSync } from "./src/commands.ts";
import { existsSync } from "node:fs";

export default function (pi: ExtensionAPI): void {
  const paths = getSyncPaths();

  pi.registerCommand("pisync", {
    description: "使用 Git 分支同步 Pi 配置",
    handler: async (args, context) => {
      await handleSyncCommand(args, {
        cwd: context.cwd,
        // pi 的 RPC 模式也暴露协议 UI, 但架构约定要求 RPC/JSON/print 不弹同步界面。
        hasUI: context.mode === "tui",
        mode: context.mode,
        ui: context.ui,
      });
    },
  });

  // autoSync 不用定时器: 配置更新后需要 /reload 才生效, 定时拉取意义不大。
  // 改为会话启动时执行一次 merge-down --main --theirs, 有新内容则提示 reload。
  pi.on("session_start", async (_event, context) => {
    if (!existsSync(paths.repoPath)) return;
    try {
      const state = await loadLocalState(paths.statePath);
      if (!state) return;
      const config = await loadConfig(paths.repoPath);
      if (!config.autoSync.enabled) return;
      // 不 await, 避免阻塞会话启动; tryAutoSync 内部有全局锁, 与手动命令互斥。
      void tryAutoSync(paths, context.ui);
    } catch (error) {
      console.warn(`pi-sync-pure: 无法启动 autoSync: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
