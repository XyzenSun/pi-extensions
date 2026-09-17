/**
 * 事件适配器：把统一 Decision 翻译成各事件的返回值结构。
 *
 * 六个专用适配器（tool_call / input / before_agent_start / context /
 * session_before_compact / session_start+shutdown）+ 通用通知适配器。
 *
 * 执行语义：串行、首个阻断性结果短路（与 pi runner 的 first-block-wins 一致）；
 * transform 链式传递；注入按序累加。所有 handler 顶层 try/catch 兜底——
 * tool_call 在 pi runner 内层无异常隔离，抛错会变成工具的"幻影拦截"。
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
  InputEvent,
  ToolCallEvent,
  BeforeAgentStartEvent,
  ContextEvent,
  SessionBeforeCompactEvent,
  SessionStartEvent,
  SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import type { HookEntry, LoadResult } from "./config.ts";
import { buildTarget, matches } from "./matcher.ts";
import { runHook, type RunContext } from "./runner.ts";
import { interpret, contentText, targetOf } from "./protocol.ts";

/** 引擎运行时依赖，由 index.ts 注入。 */
export interface EngineDeps {
  agentDir: string;
  libDir: string;
  /** 取当前生效配置（热重载后自动最新） */
  getHooks: () => LoadResult;
  /** 诊断通知：所有失败路径必须用户可感知 */
  diagnose: (message: string, level?: "info" | "warning" | "error") => void;
  /** 临时注入队列：input 的 to:message 落点由下一次 context 事件消费 */
  pendingInjections: string[];
}

/** 一次事件触发的执行入口：过滤 → 执行 → 汇总决策。 */
async function dispatch(
  deps: EngineDeps,
  ctx: ExtensionContext,
  event: ExtensionEvent,
): Promise<{ acc: { content?: string; to?: string } | null; blocked: string | null }> {
  const hooks = deps.getHooks().hooks.filter((h) => h.on === event.type && h.enabled);
  if (hooks.length === 0) return { acc: null, blocked: null };

  const target = buildTarget(event);
  let acc: { content?: string; to?: string } | null = null;
  let blocked: string | null = null;

  const sessionId = safeSessionId(ctx);
  const sessionFile = safeSessionFile(ctx);

  for (const hook of hooks) {
    if (!matches(hook.match, target)) continue;

    const rc: RunContext = {
      eventName: event.type,
      payload: event,
      hookId: hook.id,
      sessionId,
      cwd: ctx.cwd,
      sessionFile,
      libDir: deps.libDir,
      timeoutSeconds: hook.timeout ?? 30,
      signal: ctx.signal,
    };

    const outcome = await runHook(deps.agentDir, hook.run, rc);
    const decision = interpret(outcome);

    switch (decision.kind) {
      case "block": {
        // 首个阻断短路，后续 hook 不再执行
        deps.diagnose(`[pi-hooks] ${hook.layer}[${hook.index}] 阻断：${decision.reason}`, "warning");
        return { acc: null, blocked: decision.reason };
      }
      case "error": {
        // 非阻断：诊断可见，继续下一条
        deps.diagnose(`[pi-hooks] ${hook.layer}[${hook.index}] 失败：${decision.message}`, "warning");
        break;
      }
      case "output": {
        const content = contentText(decision.output);
        const to = targetOf(decision.output);
        if (content !== undefined || to !== undefined) {
          // transform 语义：后一条 hook 看到前一条的结果（input 场景）。
          // 先取旧值再赋值，避开 CFA 对自引用赋值的窄化。
          const prev = acc as { content?: string; to?: string } | null;
          acc = { content: content ?? prev?.content, to: to ?? prev?.to };
        }
        break;
      }
      case "none":
        break;
    }
  }

  return { acc, blocked };
}

function safeSessionId(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager.getSessionId() || "nosession";
  } catch {
    return "nosession";
  }
}

function safeSessionFile(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionFile();
  } catch {
    return undefined;
  }
}

/** 临时注入的 custom 消息（不落盘，随下一次 LLM 调用生效）。 */
function ephemeralMessage(text: string): {
  role: "custom";
  customType: string;
  content: string;
  display: boolean;
  timestamp: number;
} {
  return { role: "custom", customType: "pi-hooks:inject", content: text, display: false, timestamp: Date.now() };
}

// ── 专用适配器 ───────────────────────────────────────────────────────────────

/** tool_call：exit 2 阻断工具，stdout 忽略（仅执行/拦截场景）。 */
export async function adapterToolCall(event: ToolCallEvent, ctx: ExtensionContext, deps: EngineDeps) {
  try {
    const { blocked } = await dispatch(deps, ctx, event);
    if (blocked !== null) return { block: true, reason: blocked };
    return undefined;
  } catch (e) {
    // 幻影拦截防线：引擎自身异常绝不能阻断工具
    deps.diagnose(`[pi-hooks] tool_call 适配器异常：${e instanceof Error ? e.message : String(e)}`, "error");
    return undefined;
  }
}
/** input：默认 transform 改写输入；to:message 转入临时注入队列；exit 2 吞掉输入。 */
export async function adapterInput(event: InputEvent, ctx: ExtensionContext, deps: EngineDeps) {
  try {
    // 扩展自激防线：自己 sendUserMessage 产生的输入不处理
    if (event.source === "extension") return undefined;

    const { acc, blocked } = await dispatch(deps, ctx, event);
    if (blocked !== null) {
      ctx.ui?.notify(`[pi-hooks] 输入被 hook 拦截：${blocked}`, "warning");
      return { action: "handled" } as const;
    }
    if (acc?.to === "message" && acc.content !== undefined) {
      deps.pendingInjections.push(acc.content);
      return undefined;
    }
    if (acc?.content !== undefined) {
      return { action: "transform", text: acc.content } as const;
    }
    return undefined;
  } catch (e) {
    deps.diagnose(`[pi-hooks] input 适配器异常：${e instanceof Error ? e.message : String(e)}`, "error");
    return undefined;
  }
}

/** context：content 追加临时消息；同时消费 input 落入队列的注入。 */
export async function adapterContext(event: ContextEvent, ctx: ExtensionContext, deps: EngineDeps) {
  try {
    let messages = event.messages;

    // 先消费 input 队列的注入（to:message 落点）
    const pending = deps.pendingInjections.splice(0, deps.pendingInjections.length);
    for (const text of pending) {
      messages = [...messages, ephemeralMessage(text)];
    }

    const { acc } = await dispatch(deps, ctx, event);
    if (acc?.content !== undefined) {
      messages = [...messages, ephemeralMessage(acc.content)];
    }

    // 只在有改动时返回，避免无谓的数组复制
    if (messages !== event.messages) return { messages };
    return undefined;
  } catch (e) {
    deps.diagnose(`[pi-hooks] context 适配器异常：${e instanceof Error ? e.message : String(e)}`, "error");
    return undefined;
  }
}

/** before_agent_start：默认追加 systemPrompt；to:message 注入持久消息。 */
export async function adapterBeforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext, deps: EngineDeps) {
  try {
    const { acc } = await dispatch(deps, ctx, event);
    if (!acc?.content) return undefined;

    if (acc.to === "message") {
      // 持久注入：custom message 落盘进会话文件
      return {
        message: { customType: "pi-hooks:inject", content: acc.content, display: false },
      };
    }
    // 默认：追加到系统提示词末尾（当轮生效，不落盘）
    return { systemPrompt: `${event.systemPrompt}\n\n${acc.content}` };
  } catch (e) {
    deps.diagnose(`[pi-hooks] before_agent_start 适配器异常：${e instanceof Error ? e.message : String(e)}`, "error");
    return undefined;
  }
}

/** session_before_compact：exit 2 取消压缩。 */
export async function adapterBeforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext, deps: EngineDeps) {
  try {
    const { blocked } = await dispatch(deps, ctx, event);
    if (blocked !== null) {
      ctx.ui?.notify(`[pi-hooks] 压缩被 hook 取消：${blocked}`, "info");
      return { cancel: true } as const;
    }
    return undefined;
  } catch (e) {
    deps.diagnose(`[pi-hooks] session_before_compact 适配器异常：${e instanceof Error ? e.message : String(e)}`, "error");
    return undefined;
  }
}

/** session_start：通知类执行（stdout/exit2 均不产生行为）。 */
export async function adapterSessionStart(event: SessionStartEvent, ctx: ExtensionContext, deps: EngineDeps) {
  try {
    await dispatch(deps, ctx, event);
  } catch (e) {
    deps.diagnose(`[pi-hooks] session_start 适配器异常：${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

/** session_shutdown：通知类执行 + 收割在途子进程。 */
export async function adapterSessionShutdown(event: SessionShutdownEvent, ctx: ExtensionContext, deps: EngineDeps) {
  try {
    await dispatch(deps, ctx, event);
  } catch (e) {
    deps.diagnose(`[pi-hooks] session_shutdown 适配器异常：${e instanceof Error ? e.message : String(e)}`, "error");
  }
  // Linux 父进程退出不级联终止子进程，主动收割防孤儿脚本继续写盘
  const { reapAllChildren } = await import("./runner.ts");
  reapAllChildren();
}

/** 通用通知适配器：任何没有专用语义的事件都以"仅执行"模式工作。 */
export async function adapterNotify(event: ExtensionEvent, ctx: ExtensionContext, deps: EngineDeps) {
  try {
    await dispatch(deps, ctx, event);
  } catch (e) {
    deps.diagnose(`[pi-hooks] ${event.type} 适配器异常：${e instanceof Error ? e.message : String(e)}`, "error");
  }
}
