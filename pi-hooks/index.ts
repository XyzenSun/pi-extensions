/**
 * pi-hooks — 配置驱动 hook 引擎。
 *
 * 用一份 hooks.json 声明"在哪个事件点、过滤什么、跑哪段 bash"，
 * 行为逻辑全部写在 bash 脚本里（一切都是 bash）。
 *
 * 协议：stdin 收事件 JSON，退出码表达决策（exit 0 放行 / exit 2 阻断），
 * stdout 非空时必须是 JSON 对象（用 lib.sh 的 hook_out 包装）。
 *
 * 配置：~/.pi/agent/hooks.json（全局）+ .pi/hooks.json（项目），
 * 无信任门（威胁模型外包给运行环境，见 doc/design.md）。
 *
 * 命令：/hooks 查看当前生效条目与诊断。
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadAll, globalConfigPath, projectConfigPath, watchConfigs, type HookEntry } from "./src/config.ts";
import {
  adapterToolCall,
  adapterInput,
  adapterContext,
  adapterBeforeAgentStart,
  adapterBeforeCompact,
  adapterSessionStart,
  adapterSessionShutdown,
  adapterNotify,
  type EngineDeps,
} from "./src/adapters.ts";

export default function (pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const entryDir = dirname(fileURLToPath(import.meta.url));
  const libDir = join(entryDir, "lib");

  // ── 配置状态（热重载整体换新，dispatch 每次取最新） ─────────────────────
  let current = { hooks: [] as HookEntry[], problems: [] as string[] };
  let unwatch: (() => void) | undefined;
  /** input 的 to:message 注入队列，由下一次 context 事件消费 */
  const pendingInjections: string[] = [];
  /** 最近一次事件回调的 ctx，供无 ctx 场景（初始加载）诊断用 */
  let latestCtx: ExtensionContext | undefined;

  function diagnose(message: string, level: "info" | "warning" | "error" = "warning"): void {
    try {
      latestCtx?.ui?.notify?.(message, level);
    } catch {
      // 无 UI（print/rpc 模式）或无 ctx：静默，配置问题在 session_start 的重读中会再次报出
    }
  }

  function reloadConfig(ctx?: ExtensionContext): void {
    const cwd = ctx?.cwd ?? process.cwd();
    const globalPath = globalConfigPath();
    const projectPath = projectConfigPath(cwd);

    const result = loadAll(globalPath, projectPath);
    current = result;

    // 配置问题必须显式可见，不允许静默失效
    for (const problem of result.problems) diagnose(`[pi-hooks] ${problem}`, "error");
  }

  // ── 事件注册 ─────────────────────────────────────────────────────────────
  // 专用适配器：六个有返回值语义的事件
  pi.on("tool_call", (event, ctx) => {
    latestCtx = ctx;
    return adapterToolCall(event, ctx, deps);
  });
  pi.on("input", (event, ctx) => {
    latestCtx = ctx;
    return adapterInput(event, ctx, deps);
  });
  pi.on("context", (event, ctx) => {
    latestCtx = ctx;
    return adapterContext(event, ctx, deps);
  });
  pi.on("before_agent_start", (event, ctx) => {
    latestCtx = ctx;
    return adapterBeforeAgentStart(event, ctx, deps);
  });
  pi.on("session_before_compact", (event, ctx) => {
    latestCtx = ctx;
    return adapterBeforeCompact(event, ctx, deps);
  });

  // 通知类：session 生命周期 + 全部通用事件（仅执行模式）
  pi.on("session_start", async (event, ctx) => {
    latestCtx = ctx;
    // reload 后重读配置（含 cwd 变化后的项目层）
    reloadConfig(ctx);
    await adapterSessionStart(event, ctx, deps);
  });
  pi.on("session_shutdown", (event, ctx) => {
    latestCtx = ctx;
    return adapterSessionShutdown(event, ctx, deps);
  });

  // 通用通知适配器：其余 29 个事件按需注册（有配置才挂）
  // 为避免注册 29 个空 handler，只在配置涉及某事件时注册；热重载新增事件
  // 依赖 session_start(reload) 或重启。v1 接受此限制，README 已注明。
  const NOTIFY_EVENTS = [
    "session_info_changed",
    "session_compact",
    "session_compact_failed",
    "session_before_switch",
    "session_before_fork",
    "session_before_tree",
    "session_tree",
    "agent_start",
    "agent_end",
    "agent_settled",
    "ui_prompt_start",
    "ui_prompt_end",
    "turn_start",
    "turn_end",
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "model_select",
    "thinking_level_select",
    "tool_result",
    "user_bash",
  ] as const;

  for (const name of NOTIFY_EVENTS) {
    // pi.on 是逐字面量重载，循环注册需受控断言；事件名来自白名单常量，运行时安全
    (pi.on as unknown as (event: string, handler: (event: ExtensionEvent, ctx: ExtensionContext) => unknown) => void)(
      name,
      (event, ctx) => {
        latestCtx = ctx;
        return adapterNotify(event, ctx, deps);
      },
    );
  }

  const deps: EngineDeps = {
    agentDir,
    libDir,
    getHooks: () => current,
    diagnose,
    pendingInjections,
  };

  // ── 初始加载 + 热重载 ────────────────────────────────────────────────────
  reloadConfig();
  unwatch = watchConfigs(
    [globalConfigPath(), projectConfigPath(process.cwd())],
    () => {
      reloadConfig();
      diagnose("[pi-hooks] 配置已热重载", "info");
    },
  );

  // ── /hooks 命令 ──────────────────────────────────────────────────────────
  pi.registerCommand("hooks", {
    description: "查看 pi-hooks 当前生效的 hook 条目与配置问题",
    getArgumentCompletions: (prefix: string) => {
      const subs = ["status", "reload"];
      const filtered = subs.filter((s) => s.startsWith(prefix.trim()));
      return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
    },
    handler: async (args: string, ctx) => {
      const sub = args?.trim().toLowerCase() ?? "";
      if (sub === "reload") {
        reloadConfig(ctx);
        ctx.ui.notify("[pi-hooks] 配置已重载", "info");
        return;
      }

      // status：生效条目 + 问题清单
      const lines: string[] = [];
      const active = current.hooks.filter((h) => h.enabled);
      const disabled = current.hooks.filter((h) => !h.enabled);

      lines.push(`生效 ${active.length} 条，停用 ${disabled.length} 条`);
      for (const h of active) {
        const match = h.match ? ` match=${h.match.source}` : "";
        const timeout = h.timeout ? ` timeout=${h.timeout}s` : "";
        lines.push(`  [${h.layer}] ${h.on}${match}${timeout} → ${h.run.slice(0, 60)}`);
      }
      for (const h of disabled) {
        lines.push(`  [${h.layer}] ${h.on}（已停用）→ ${h.run.slice(0, 60)}`);
      }
      if (current.problems.length > 0) {
        lines.push("配置问题:");
        for (const p of current.problems) lines.push(`  ${p}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
