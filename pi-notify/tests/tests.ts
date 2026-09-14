/**
 * Unit tests for pi-notify extension (ntfy-only, v3).
 *
 * Run: node --experimental-strip-types tests/tests.ts
 *
 * Tests core logic without requiring pi runtime:
 *   - content extraction (extractText, extractLastUserPrompt, getLastAssistantMessage)
 *   - structured body building (buildStructuredBody)
 *   - mute duration parsing (1s/1m/1h/1d)
 *   - ntfy header encoding (RFC 2047)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ═══════════════════════════════════════════════════════════════════════════
// Extracted pure functions from desktop-notify.ts (duplicated for test isolation)
// ═══════════════════════════════════════════════════════════════════════════

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        const t = (block as { text?: string }).text;
        if (t) return t;
      }
    }
  }
  return "";
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// 最近一条 user 消息全文（user-prompt 字段用，截 50 字）
function extractLastUserPrompt(entries: Record<string, unknown>[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const msg = entry.message as Record<string, unknown> | undefined;
    const role = (entry.role ?? msg?.role) as string | undefined;
    if (role === "user") {
      const content = (entry.content ?? msg?.content);
      const text = cleanText(extractText(content));
      return text || null;
    }
  }
  return null;
}

// 最后一条 assistant 消息（stopReason 判断 + ai-text 提取）
function getLastAssistantMessage(entries: Record<string, unknown>[]): { stopReason?: string; content?: unknown } | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const msg = entry.message as Record<string, unknown> | undefined;
    const role = (entry.role ?? msg?.role) as string | undefined;
    if (role === "assistant") {
      return {
        stopReason: (entry.stopReason ?? msg?.stopReason) as string | undefined,
        content: entry.content ?? msg?.content,
      };
    }
  }
  return null;
}

// ── 勿扰时长解析 ─────────────────────────────────────────────────────────────
const MUTE_DURATION_UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function parseMuteDuration(input: string): number | null {
  const match = /^(\d+)([smhd])$/.exec(input.trim().toLowerCase());
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  if (amount <= 0) return null;
  return amount * MUTE_DURATION_UNITS[match[2]];
}

// ── ntfy 标题编码 ────────────────────────────────────────────────────────────
function encodeNtfyHeader(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}

// ── 结构化正文构建 ───────────────────────────────────────────────────────────
function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function buildStructuredBody(fields: {
  sessionName: string;
  sessionId: string;
  prompt: string | null;
  aiText: string;
  now: number;
}): string {
  const truncatedPrompt = fields.prompt
    ? (fields.prompt.length > 50 ? fields.prompt.slice(0, 50) + "…" : fields.prompt)
    : "";
  return [
    `session-name: ${fields.sessionName}`,
    `session-id: ${fields.sessionId}`,
    `time: ${formatDateTime(fields.now)}`,
    `user-prompt: ${truncatedPrompt}`,
    `ai-text: ${fields.aiText}`,
  ].join("\n");
}

// ── 会话名回退链 ─────────────────────────────────────────────────────────────
function resolveSessionName(sessionName: string | null, prompt: string | null): string {
  if (sessionName) return sessionName;
  if (prompt) return prompt.length > 20 ? prompt.slice(0, 20) + "…" : prompt;
  return "unnamed";
}

function buildTitle(sessionName: string | null, prompt: string | null): string {
  if (sessionName) return sessionName;
  if (prompt) return prompt.length > 25 ? prompt.slice(0, 25) + "…" : prompt;
  return "pi";
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("extractText", () => {
  it("string content", () => {
    assert.equal(extractText("hello"), "hello");
  });

  it("content array with text block", () => {
    assert.equal(extractText([{ type: "text", text: "world" }]), "world");
  });

  it("picks first text block, joins nothing", () => {
    assert.equal(extractText([{ type: "image" }, { type: "text", text: "hi" }]), "hi");
  });

  it("non-text returns empty", () => {
    assert.equal(extractText(null), "");
    assert.equal(extractText({ type: "image" }), "");
  });
});

describe("extractLastUserPrompt", () => {
  it("finds last user message", () => {
    const entries = [
      { role: "user", content: "first question" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second question" },
    ];
    assert.equal(extractLastUserPrompt(entries), "second question");
  });

  it("handles nested entry.message structure", () => {
    const entries = [
      { type: "message", message: { role: "user", content: "nested" } },
    ];
    assert.equal(extractLastUserPrompt(entries), "nested");
  });

  it("collapses whitespace", () => {
    const entries = [{ role: "user", content: "  hello   world  " }];
    assert.equal(extractLastUserPrompt(entries), "hello world");
  });

  it("returns null when no user message", () => {
    assert.equal(extractLastUserPrompt([{ role: "assistant", content: "x" }]), null);
  });
});

describe("getLastAssistantMessage", () => {
  it("finds last assistant with stopReason", () => {
    const entries = [
      { role: "assistant", stopReason: "stop", content: "first" },
      { role: "user", content: "q" },
      { role: "assistant", stopReason: "error", content: "second" },
    ];
    const msg = getLastAssistantMessage(entries);
    assert.equal(msg!.stopReason, "error");
    assert.equal(extractText(msg!.content), "second");
  });

  it("returns null when no assistant", () => {
    assert.equal(getLastAssistantMessage([{ role: "user" }]), null);
  });

  it("aborted stopReason is visible", () => {
    const entries = [{ role: "assistant", stopReason: "aborted" }];
    assert.equal(getLastAssistantMessage(entries)!.stopReason, "aborted");
  });
});

describe("parseMuteDuration", () => {
  it("parses all supported units", () => {
    assert.equal(parseMuteDuration("1s"), 1000);
    assert.equal(parseMuteDuration("1m"), 60_000);
    assert.equal(parseMuteDuration("1h"), 3_600_000);
    assert.equal(parseMuteDuration("1d"), 86_400_000);
  });

  it("parses multi-digit amounts", () => {
    assert.equal(parseMuteDuration("30m"), 1_800_000);
    assert.equal(parseMuteDuration("7d"), 604_800_000);
  });

  it("rejects units beyond d", () => {
    assert.equal(parseMuteDuration("1w"), null);
    assert.equal(parseMuteDuration("1y"), null);
  });

  it("rejects missing unit / zero / negative / float / combined", () => {
    assert.equal(parseMuteDuration("30"), null);
    assert.equal(parseMuteDuration(""), null);
    assert.equal(parseMuteDuration("0m"), null);
    assert.equal(parseMuteDuration("-5m"), null);
    assert.equal(parseMuteDuration("0.5h"), null);
    assert.equal(parseMuteDuration("1h30m"), null);
  });
});

describe("encodeNtfyHeader", () => {
  it("ASCII passthrough", () => {
    assert.equal(encodeNtfyHeader("pi task complete"), "pi task complete");
  });

  it("Chinese title is RFC 2047 base64 encoded and round-trips", () => {
    const encoded = encodeNtfyHeader("帮我重构用户模块");
    assert.ok(encoded.startsWith("=?UTF-8?B?"));
    assert.ok(encoded.endsWith("?="));
    assert.ok(/^[\x21-\x7E]+$/.test(encoded));
    const b64 = encoded.slice("=?UTF-8?B?".length, -2);
    assert.equal(Buffer.from(b64, "base64").toString("utf-8"), "帮我重构用户模块");
  });
});

describe("buildStructuredBody", () => {
  const base = {
    sessionName: "重构用户模块",
    sessionId: "a3f8c2e1-1234-5678-9abc-def012345678",
    prompt: "帮我重构整个用户认证模块的代码",
    aiText: "已完成，共修改 3 个文件",
    now: new Date("2026-09-11T14:32:00").getTime(),
  };

  it("builds five structured fields in order", () => {
    const body = buildStructuredBody(base);
    const lines = body.split("\n");
    assert.equal(lines.length, 5);
    assert.equal(lines[0], "session-name: 重构用户模块");
    assert.equal(lines[1], "session-id: a3f8c2e1-1234-5678-9abc-def012345678");
    assert.equal(lines[2], "time: 2026-09-11 14:32");
    assert.equal(lines[3], "user-prompt: 帮我重构整个用户认证模块的代码");
    assert.equal(lines[4], "ai-text: 已完成，共修改 3 个文件");
  });

  it("truncates user-prompt to 50 chars + ellipsis", () => {
    const long = "问".repeat(60);
    const body = buildStructuredBody({ ...base, prompt: long });
    const promptLine = body.split("\n")[3];
    assert.equal(promptLine, `user-prompt: ${"问".repeat(50)}…`);
  });

  it("empty prompt renders empty value", () => {
    const body = buildStructuredBody({ ...base, prompt: null });
    assert.equal(body.split("\n")[3], "user-prompt: ");
  });

  it("ask-user fixed text goes into ai-text slot", () => {
    const body = buildStructuredBody({ ...base, aiText: "此会话需要你选择方案或需要你的输入!" });
    assert.ok(body.includes("ai-text: 此会话需要你选择方案或需要你的输入!"));
  });

  it("error fixed text goes into ai-text slot", () => {
    const body = buildStructuredBody({ ...base, aiText: "此会话遇到错误,需要处理!" });
    assert.ok(body.includes("ai-text: 此会话遇到错误,需要处理!"));
  });
});

describe("session name fallback chain", () => {
  it("named session wins", () => {
    assert.equal(resolveSessionName("重构用户模块", "随便什么"), "重构用户模块");
  });

  it("unnamed falls back to prompt first 20 chars", () => {
    const long = "帮我重构整个用户认证模块的代码包括登录注册";
    assert.equal(resolveSessionName(null, long), "帮我重构整个用户认证模块的代码包括登录注…");
  });

  it("short prompt used as-is", () => {
    assert.equal(resolveSessionName(null, "修个 bug"), "修个 bug");
  });

  it("no name no prompt → unnamed", () => {
    assert.equal(resolveSessionName(null, null), "unnamed");
  });
});

describe("buildTitle", () => {
  it("named session wins", () => {
    assert.equal(buildTitle("重构用户模块", "随便"), "重构用户模块");
  });

  it("unnamed falls back to prompt first 25 chars", () => {
    const long = "帮我重构整个用户认证模块的代码包括登录注册和权限管理";
    assert.equal(buildTitle(null, long), "帮我重构整个用户认证模块的代码包括登录注册和权限管…");
  });

  it("no name no prompt → pi", () => {
    assert.equal(buildTitle(null, null), "pi");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Run
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n✅ All tests passed!\n");
