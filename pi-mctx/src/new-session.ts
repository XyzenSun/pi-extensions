/**
 * /mctx new 命令逻辑: 收集分支 -> 序列化 -> 文件清单 -> 单次 LLM 蒸馏 -> 新会话草稿预填。
 *
 * 失败语义 (设计文档 §4): 任何失败/中止只报错, 当前上下文零影响。
 * 总结输入为 session 原文, 不应用 sink 投影 (D13: 清空前最后一次总结,
 * 一次性成本质量优先; sink 省的是每轮请求的持续成本, 目的不同)。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { uuidv7, type Message } from "@earendil-works/pi-ai";
import {
  BorderedLoader,
  convertToLlm,
  serializeConversation,
  type CompactionEntry,
  type ExtensionCommandContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { dbg } from "./debug.ts";
import { extractFileInventory, formatTouchedFiles, type CompactionFileDetails } from "./file-inventory.ts";

const HANDOFF_SYSTEM_PROMPT = `You are a context handoff assistant. You will receive a serialized conversation history and a list of files that were read or modified during the session. Your job is to write a kickoff prompt for a brand-new session that continues this work without access to the old conversation.

Write the prompt in the dominant language of the conversation, translating the four headings below accordingly. Output ONLY the prompt itself — no preamble, no explanations, no surrounding code fences.

The prompt must use exactly this structure with these four headings:

## 上下文精华
Key decisions and their rationale, core technical concepts, and important code snippets (function signatures / key algorithms — not whole files). This section must preserve the information needed to continue the work.

## 当前任务
What is currently being worked on and where it stands.

## 需要读取的文件
One entry per file, each formatted as: "- <path> — <why it must be read> (已修改)" or "(仅读过)". List files from the <touched-files> block when present; you may also include file paths that were explicitly referenced in the conversation (for example in bash commands or tool calls). Never invent a path that appears neither in the list nor in the conversation. If there are no such files, omit this entire section.

## 接下来做什么
Concrete, actionable next steps.

Rules:
- Keep the whole prompt concise — roughly 1500 characters or less.
- Do not copy tool outputs verbatim; distill them.
- Preserve critical decisions, constraints and preferences stated by the user.`;

// 防御性读取 retainedTail: pi 0.85.1 的类型上尚无此字段, 但新格式 session
// 会直接在 compaction entry 内嵌保留消息。存在时它是自包含检查点,
// 优先于 firstKeptEntryId 回溯路径, 未来 pi 升级自动兼容。
type RetainedTailCompaction = CompactionEntry & { retainedTail?: AgentMessage[] };

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
  if (entry.type === "message") return entry.message;
  if (entry.type === "compaction") {
    return {
      role: "compactionSummary",
      summary: entry.summary,
      tokensBefore: entry.tokensBefore,
      timestamp: new Date(entry.timestamp).getTime(),
    };
  }
  return undefined;
}

function toMessages(entries: SessionEntry[]): AgentMessage[] {
  return entries.map(entryToMessage).filter((message): message is AgentMessage => message !== undefined);
}

/**
 * 收集当前分支的消息。若分支上有 compaction entry, 旧消息已被摘要替代,
 * 不重复总结: 输入 = 历史摘要 + 保留消息 (retainedTail 或 firstKeptEntryId
 * 起的条目) + compaction 之后的全部消息。
 */
export function collectBranchMessages(branch: SessionEntry[]): AgentMessage[] {
  let compactionIndex = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i].type === "compaction") {
      compactionIndex = i;
      break;
    }
  }
  if (compactionIndex < 0) {
    return toMessages(branch);
  }
  const compaction = branch[compactionIndex] as RetainedTailCompaction;
  const retainedTail = compaction.retainedTail;
  let kept: AgentMessage[];
  if (Array.isArray(retainedTail)) {
    kept = retainedTail;
  } else {
    const firstKeptIndex = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
    kept = firstKeptIndex >= 0 ? toMessages(branch.slice(firstKeptIndex, compactionIndex)) : [];
  }
  const compactionMessage = entryToMessage(compaction) as AgentMessage;
  return [compactionMessage, ...kept, ...toMessages(branch.slice(compactionIndex + 1))];
}

export async function runNewCommand(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
  const startedAt = Date.now();
  const extraInstructions = rawArgs.trim();
  dbg("new", "命令触发", { extraInstructions, mode: ctx.mode, hasModel: Boolean(ctx.model) });

  if (ctx.mode !== "tui") {
    ctx.ui.notify("mctx new: 仅支持交互模式", "error");
    return;
  }
  const model = ctx.model;
  if (!model) {
    ctx.ui.notify("mctx new: 未选择模型", "error");
    return;
  }

  // 等待 agent 空闲: 流式输出中途的分支快照不完整, 且运行中切换会话有竞态。
  await ctx.waitForIdle();

  const branch = ctx.sessionManager.getBranch();
  const messages = collectBranchMessages(branch);
  dbg("new", "分支收集完成", { branchEntries: branch.length, messages: messages.length });
  if (messages.length === 0) {
    dbg("new", "分支无消息, 提前退出");
    ctx.ui.notify("mctx new: 当前会话没有可总结的内容", "warning");
    return;
  }

  const conversationText = serializeConversation(convertToLlm(messages));
  dbg("new", "序列化完成", { chars: conversationText.length });

  // 文件清单: 从 toolCall 机械提取 + 累积合并历史 compaction details。
  // sink 不修改 toolCall, 故已下沉结果不影响提取。
  const compactionDetails = branch
    .filter((entry): entry is CompactionEntry => entry.type === "compaction")
    .map((entry) => (entry.details ?? {}) as CompactionFileDetails);
  const inventory = extractFileInventory(messages, compactionDetails, ctx.cwd);
  const touchedFilesBlock = formatTouchedFiles(inventory);
  dbg("new", "文件清单区块", { touchedFilesBlock });

  const userPromptText = [
    "<conversation>",
    conversationText,
    "</conversation>",
    ...(touchedFilesBlock ? ["", touchedFilesBlock] : []),
    ...(extraInstructions ? ["", "用户补充指示 (总结时重点遵循):", extraInstructions] : []),
  ].join("\n");

  const tokensBefore = ctx.getContextUsage()?.tokens;
  const currentSessionFile = ctx.sessionManager.getSessionFile();
  dbg("new", "发起蒸馏调用", { tokensBefore, currentSessionFile });

  // 生成 kickoff prompt。BorderedLoader 期间 Esc 可中止。
  // generationError 用于区分"用户取消"与"调用失败", 两者都保持当前上下文不变。
  let generationError: string | null = null;
  const kickoffPrompt = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, "mctx: 正在蒸馏上下文...");
    loader.onAbort = () => done(null);

    const generate = async (): Promise<string | null> => {
      const userMessage: Message = {
        role: "user",
        content: [{ type: "text", text: userPromptText }],
        timestamp: Date.now(),
      };
      // 一次性独立调用: 新 sessionId + 不写 provider 缓存,
      // 与 pi 自身 compaction 的调用约定一致, 不污染会话缓存前缀。
      const response = await ctx.modelRegistry.complete(
        model,
        { systemPrompt: HANDOFF_SYSTEM_PROMPT, messages: [userMessage] },
        { signal: loader.signal, cacheRetention: "none", sessionId: uuidv7() },
      );
      dbg("new", "LLM 响应", {
        stopReason: response.stopReason,
        usage: response.usage,
        elapsedMs: Date.now() - startedAt,
      });
      if (response.stopReason === "aborted") return null;
      if (response.stopReason === "length") {
        generationError = "总结输出被截断 (达到输出上限)";
        return null;
      }
      if (response.stopReason === "error") {
        generationError = response.errorMessage ?? "LLM 调用失败";
        return null;
      }
      const text = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();
      if (!text) {
        generationError = "总结输出为空";
        return null;
      }
      return text;
    };

    generate()
      .then(done)
      .catch((error) => {
        generationError = error instanceof Error ? error.message : String(error);
        dbg("new", "蒸馏调用失败", { error: generationError });
        done(null);
      });
    return loader;
  });

  if (kickoffPrompt === null) {
    const reason = generationError ?? "已取消";
    dbg("new", "未生成 kickoff prompt, 当前会话保持原样", { reason });
    ctx.ui.notify(`mctx new: ${reason}, 当前上下文未受影响`, "warning");
    return;
  }

  dbg("new", "kickoff prompt 生成完成", kickoffPrompt);

  // 清空上下文进入新会话。旧会话文件保留, parentSession 关联, /resume 可回溯。
  const newSessionResult = await ctx.newSession({
    parentSession: currentSessionFile,
    withSession: async (replacementCtx) => {
      // 只能使用 replacement ctx: 原 ctx 在会话替换后已失效。
      replacementCtx.ui.setEditorText(kickoffPrompt);
      const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      replacementCtx.ui.notify(
        `mctx: 上下文已清空 (原 ${tokensBefore ?? "?"} tokens, 蒸馏 ${elapsedSeconds}s)。审查草稿后回车提交`,
        "info",
      );
    },
  });

  if (newSessionResult.cancelled) {
    ctx.ui.notify("mctx new: 新会话被取消, 当前上下文未受影响", "warning");
  }
}
