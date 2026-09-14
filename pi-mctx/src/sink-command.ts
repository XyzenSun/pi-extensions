/**
 * /mctx sink 命令逻辑: 参数解析 / 合格判定 / --keep 筛选 / 写入与报告。
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MctxConfig } from "./config.ts";
import { dbg } from "./debug.ts";
import {
  addSunkId,
  clearSunkIds,
  deleteSunkId,
  getSunkIds,
  rebindSession,
  removeAllSunkFiles,
  removeSunkFile,
  writeSunkFile,
} from "./sink-store.ts";

interface SinkArgs {
  keep: number | undefined;
  undo: boolean;
}

type ParsedSinkArgs = SinkArgs | { error: string };

function parseSinkArgs(raw: string): ParsedSinkArgs {
  const result: SinkArgs = { keep: undefined, undo: false };
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (token === "--undo") {
      result.undo = true;
    } else if (token.startsWith("--keep=")) {
      const value = Number(token.slice("--keep=".length));
      if (!Number.isInteger(value) || value < 0) {
        return { error: `--keep 需要非负整数: ${token}` };
      }
      result.keep = value;
    } else if (token === "--keep") {
      return { error: "--keep 需要 N 值, 用法: --keep N 或 --keep=N" };
    } else {
      return { error: `未知参数: ${token}` };
    }
  }
  return result;
}

/**
 * 提取 toolResult 的纯文本内容。content 全为 text 块时返回拼接文本, 否则 null。
 */
function extractResultText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || (block as { type?: string }).type !== "text") return null;
    parts.push((block as { text?: string }).text ?? "");
  }
  return parts.join("\n");
}

export async function runSinkCommand(
  rawArgs: string,
  ctx: ExtensionCommandContext,
  config: MctxConfig,
): Promise<void> {
  const parsed = parseSinkArgs(rawArgs);
  if ("error" in parsed) {
    ctx.ui.notify(`mctx sink: ${parsed.error}`, "error");
    return;
  }

  // 等待 agent 空闲: 保证 buildContextEntries 快照与实际发给模型的请求一致。
  await ctx.waitForIdle();

  const sessionId = ctx.sessionManager.getSessionId();
  dbg("sink", "命令触发", { rawArgs, parsed, sessionId, minBytes: config.sink.minBytes });

  if (parsed.undo) {
    const removed = removeAllSunkFiles(sessionId);
    rebindSession(sessionId);
    clearSunkIds();
    dbg("sink", "撤销完成", { sessionId, removed });
    ctx.ui.notify(`mctx: 已撤销全部下沉 (移除 ${removed} 个文件), 上下文恢复全文`, "info");
    return;
  }

  // 幂等自愈: 即使 session_start 未触发过 (理论边缘情况), 也保证集合与当前会话一致。
  rebindSession(sessionId);
  const sunkIds = getSunkIds();

  // buildContextEntries 是 compaction-aware 的: 只拿当前还在上下文里的消息,
  // 已被压缩掉的不再处理。
  const entries = ctx.sessionManager.buildContextEntries();
  const candidates: Array<{ id: string; toolName: string; bytes: number; text: string }> = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!message || message.role !== "toolResult") continue;
    // 防套娃: obs 读回的结果不允许再被下沉。
    if (message.toolName === "obs") continue;
    const text = extractResultText(message.content);
    if (text === null) continue;
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes < config.sink.minBytes) continue;
    candidates.push({ id: message.toolCallId, toolName: message.toolName, bytes, text });
  }
  dbg(
    "sink",
    "候选结果",
    candidates.map((candidate) => ({ id: candidate.id, tool: candidate.toolName, bytes: candidate.bytes })),
  );

  // --keep 目标状态语义: 执行后保证「最近 N 条可见, 其余已沉」。
  // 落在保留尾部的已沉条目需要恢复 (删文件 + 移出集合),
  // 使「先全沉再 --keep」与重复执行都能得到正确且幂等的结果。
  const keepCount = Math.min(parsed.keep ?? 0, candidates.length);
  const targets = candidates.slice(0, candidates.length - keepCount);

  let restored = 0;
  if (keepCount > 0) {
    const keptTail = candidates.slice(candidates.length - keepCount);
    for (const kept of keptTail) {
      if (!sunkIds.has(kept.id)) continue;
      // 以集合成员关系为准制恢复决定: 即使文件已被外部删除, 也同步修正集合。
      removeSunkFile(sessionId, kept.id);
      deleteSunkId(kept.id);
      restored++;
    }
  }

  let written = 0;
  let alreadySunk = 0;
  for (const target of targets) {
    // 幂等: 已在集合中的跳过, 重复 /mctx sink 只处理新增合格结果。
    if (sunkIds.has(target.id)) {
      alreadySunk++;
      continue;
    }
    if (writeSunkFile(sessionId, target.id, target.text)) {
      addSunkId(target.id);
      written++;
    }
  }

  dbg("sink", "下沉完成", {
    candidates: candidates.length,
    keep: keepCount,
    written,
    alreadySunk,
    restored,
  });
  // 未指定 --keep 时不显示"保留最近 0", 避免噪音。
  const reportParts = [`新下沉 ${written} 条 (候选 ${candidates.length}`];
  if (keepCount > 0) reportParts.push(`保留最近 ${keepCount}`);
  if (alreadySunk > 0) reportParts.push(`已沉跳过 ${alreadySunk}`);
  if (restored > 0) reportParts.push(`恢复可见 ${restored} 条`);
  ctx.ui.notify(`mctx sink: ${reportParts.join(", ")})`, "info");
}
