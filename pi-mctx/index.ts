/**
 * pi-mctx — pi 手动上下文管理工具集
 *
 * 两个互补操作, 把上下文的管理权交给用户:
 *
 *   /mctx new [补充指示]        蒸馏重置: 总结会话为四段式 kickoff prompt,
 *                              清空上下文进入新会话, prompt 预填编辑器草稿,
 *                              审查编辑后回车提交才进入上下文
 *   /mctx sink [--keep N]       工具结果下沉: 把确定用完的大块工具输出移出
 *                              发给模型的请求 (session 原文不动), 模型需要时
 *                              用 obs({ id }) 整条无损读回
 *   /mctx sink --undo           撤销本会话全部下沉
 *
 * 设计详情见 docs/design.md。
 * 调试日志 (debug 版): <tmpdir>/pi-mctx/debug.log
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./src/config.ts";
import { dbg, DEBUG_ENABLED } from "./src/debug.ts";
import { registerObsTool } from "./src/obs-tool.ts";
import { runNewCommand } from "./src/new-session.ts";
import { runSinkCommand } from "./src/sink-command.ts";
import { getSunkIds, rebindSession } from "./src/sink-store.ts";
import { projectSunkMessages } from "./src/sink-project.ts";

const USAGE = "用法: /mctx new [补充指示] | /mctx sink [--keep N] | /mctx sink --undo";

export default function (pi: ExtensionAPI): void {
  dbg("init", "pi-mctx 加载", { debugEnabled: DEBUG_ENABLED, tmpBase: "pi-mctx" });

  const config = loadConfig();

  // 会话绑定: 启动/new/resume/fork 后从目录重建已沉集合 ("文件即状态")。
  pi.on("session_start", async (event, ctx) => {
    rebindSession(ctx.sessionManager.getSessionId());
    dbg("init", "session_start", { reason: event.reason });
  });

  // 投影钩子: 集合为空直接返回, 请求路径零开销 (设计文档 §3.7)。
  pi.on("context", async (event) => {
    const sunkIds = getSunkIds();
    if (sunkIds.size === 0) return;
    return { messages: projectSunkMessages(event.messages, sunkIds, config.sink.placeholder) };
  });

  registerObsTool(pi);

  pi.registerCommand("mctx", {
    description: "手动上下文管理: new 蒸馏重置换新会话 / sink 工具结果下沉",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        { value: "new", label: "new", description: "蒸馏会话为 kickoff prompt, 清空上下文进入新会话" },
        { value: "sink", label: "sink", description: "把用完的工具结果移出上下文 (无损, obs 读回)" },
        { value: "sink --undo", label: "sink --undo", description: "撤销本会话全部下沉" },
      ];
      const filtered = items.filter((item) => item.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed === "" || trimmed === "help") {
        ctx.ui.notify(USAGE, "info");
        return;
      }
      if (trimmed === "new" || trimmed.startsWith("new ")) {
        await runNewCommand(trimmed.slice("new".length).trim(), ctx);
        return;
      }
      if (trimmed === "sink" || trimmed.startsWith("sink ")) {
        await runSinkCommand(trimmed.slice("sink".length).trim(), ctx, config);
        return;
      }
      const subcommand = trimmed.split(/\s+/)[0];
      ctx.ui.notify(`mctx: 未知子命令 "${subcommand}"。${USAGE}`, "error");
    },
  });
}
