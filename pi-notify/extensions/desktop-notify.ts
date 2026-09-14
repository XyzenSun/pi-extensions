/**
 * Pi ntfy Notify — ntfy 推送通知扩展
 *
 * pi 完成输出时通过 ntfy 推送到手机/其他设备。适用于本机、虚拟机、服务器等任何场景。
 *
 * ## 使用
 *
 *   /notify                    显示通知状态总览
 *   /notify on | stop          通知开关（持久化，ntfy 是唯一渠道即总闸）
 *   /notify session on | stop  会话级开关（仅当前 pi 会话，重启后重置）
 *   /notify mute [时长 | off]  勿扰：默认 1h，时长格式 10s/30m/1h/1d
 *   /notify topic <名称>       设置 ntfy topic
 *   /notify server <url>       ntfy 服务器地址（默认 https://ntfy.sh）
 *   /notify token <token>      访问令牌（自建服务器鉴权用，可选）
 *   /notify test               发送测试通知
 *
 * ## 行为
 *
 *   - 监听 agent_settled（pi 不再自动继续的真正完成点，重试/压缩期间不触发）
 *   - 监听 rpiv:ask-user:prompt（agent 需要用户输入时，来自第三方扩展
 *     @juicesharp/rpiv-ask-user-question，未安装则静默无此通知）
 *   - 通知正文结构化：session-name / session-id / time / user-prompt / ai-text
 *   - aborted（用户主动中断）不通知；error 通知固定文案
 *   - 多 pi 实例安全（会话级开关按 session id 隔离）
 *
 * ## 文件
 *
 *   本文件放在 ~/.pi/agent/extensions/ 下自动生效。
 *   调试日志: $TMPDIR/pi-notify-debug.log
 *   配置文件: ~/.pi/agent/notify.json
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// @juicesharp/rpiv-ask-user-question 的事件契约（该包有稳定性承诺：频道名不可变）。
// pi 核心不提供 ask-user 事件，只能通过这个跨扩展事件总线监听。
const ASK_USER_PROMPT_EVENT = "rpiv:ask-user:prompt" as const;

// ── 状态 ─────────────────────────────────────────────────────────────────────
// hooksRegistered: 事件 hook 仅在启动时按持久化配置注册一次，从全关切到开启需重启 pi
let hooksRegistered = false;
let piApi: ExtensionAPI | null = null;
// ask-user 事件来自跨扩展事件总线，回调无 ctx 参数，从 session_start 缓存
let cachedCtx: ExtensionContext | null = null;

// ── 可配置项 ────────────────────────────────────────────────────────────────
const CONFIG_PATH = join(getAgentDir(), "notify.json");
// ntfy 是唯一通知渠道，开关即全局总闸（config.enabled）
type NtfyConfig = { server: string; topic: string; token: string };
type Config = { enabled: boolean; lang: "zh" | "en" | "ja" | "ko"; muteUntil?: number; ntfy: NtfyConfig };

function defaultNtfyConfig(): NtfyConfig {
  return { server: "https://ntfy.sh", topic: "", token: "" };
}

function loadConfig(): Config {
  try {
    if (existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      const ntfy = { ...defaultNtfyConfig(), ...(saved.ntfy ?? {}) };
      // 旧版配置迁移：原全局开关与渠道开关任一为关则视为关闭；messageMode 已废弃忽略
      const legacyEnabled = (saved.enabled ?? true) && ((saved.ntfy as { enabled?: boolean } | undefined)?.enabled ?? true);
      return {
        enabled: saved.enabled !== undefined ? legacyEnabled : true,
        lang: saved.lang ?? "en",
        muteUntil: saved.muteUntil,
        ntfy: { server: ntfy.server, topic: ntfy.topic, token: ntfy.token },
      };
    }
  } catch { /* */ }
  return { enabled: true, lang: "en", ntfy: defaultNtfyConfig() };
}

function saveConfig(c: Config): void {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), "utf-8");
  } catch { /* */ }
}

// 勿扰是纯时间戳状态：实时计算，多实例通过 notify.json 自动同步，无需运行时标志
function isMuted(): boolean {
  return !!config.muteUntil && config.muteUntil > Date.now();
}

// topic 是唯一必需配置（server 默认 ntfy.sh，token 可选）；未配置时开关与推送均无意义
function isNtfyConfigured(): boolean {
  return !!config.ntfy.topic;
}

function saveMuteUntil(ts: number | undefined): void {
  config.muteUntil = ts;
  saveConfig(config);
}

const config = loadConfig();

// ── 会话级开关（内存态，session id 标识，重启后重置）───────────────────
const sessionNotifyStopped = new Set<string>();

// session id 由 pi 的 sessionManager 提供；拿不到时返回 null，调用方降级为开启
function getSessionId(ctx: ExtensionContext): string | null {
  try {
    const id = (ctx.sessionManager as { getSessionId?: () => unknown }).getSessionId?.();
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

// 会话名（/name 设置）；拿不到时返回 null
function getSessionName(pi: ExtensionAPI): string | null {
  try {
    const name = (pi as { getSessionName?: () => unknown }).getSessionName?.();
    return typeof name === "string" && name ? name : null;
  } catch {
    return null;
  }
}

// ── 勿扰时长解析（1s / 1m / 1h / 1d，单位上限为天）──────────────────────
const MUTE_DURATION_UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function parseMuteDuration(input: string): number | null {
  const match = /^(\d+)([smhd])$/.exec(input.trim().toLowerCase());
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  if (amount <= 0) return null;
  return amount * MUTE_DURATION_UNITS[match[2]];
}

// 本地时间 HH:MM，用于勿扰反馈显示
function formatClock(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 5);
}

// yyyy-mm-dd HH:MM，通知正文 time 字段格式
function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── i18n ────────────────────────────────────────────────────────────────────
const i18n: Record<string, Record<string, string>> = {
  zh: {
    enabled: "通知已开启 🔔", disabled: "通知已全部停止 🔕",
    muted: "勿扰中 🔕 至 {0}", unmuted: "勿扰已解除 🔔", muteRemaining: "勿扰剩余{0}分",
    sessionOn: "本会话通知已开启 🔔", sessionStop: "本会话通知已停止 🔕",
    askUserText: "此会话需要你选择方案或需要你的输入!",
    errorText: "此会话遇到错误,需要处理!",
    needInput: "需要你的输入",
  },
  en: {
    enabled: "Notify ON 🔔", disabled: "Notify STOPPED 🔕",
    muted: "Muted 🔕 until {0}", unmuted: "Mute off 🔔", muteRemaining: "Muted {0}m left",
    sessionOn: "Session notify ON 🔔", sessionStop: "Session notify STOPPED 🔕",
    askUserText: "This session needs you to choose a plan or provide input!",
    errorText: "This session hit an error and needs attention!",
    needInput: "Input needed",
  },
  ja: {
    enabled: "通知ON 🔔", disabled: "通知停止 🔕",
    muted: "通知停止中 🔕 {0}まで", unmuted: "通知停止を解除 🔔", muteRemaining: "通知停止 残り{0}分",
    sessionOn: "このセッションの通知ON 🔔", sessionStop: "このセッションの通知停止 🔕",
    askUserText: "このセッションはプランの選択または入力が必要です!",
    errorText: "このセッションでエラーが発生しました。対応が必要です!",
    needInput: "入力が必要です",
  },
  ko: {
    enabled: "알림 ON 🔔", disabled: "알림 정지 🔕",
    muted: "방해금지 🔕 {0}까지", unmuted: "방해금지 해제 🔔", muteRemaining: "방해금지 {0}분 남음",
    sessionOn: "세션 알림 ON 🔔", sessionStop: "세션 알림 정지 🔕",
    askUserText: "이 세션은 방안 선택 또는 입력이 필요합니다!",
    errorText: "이 세션에 오류가 발생했습니다. 처리가 필요합니다!",
    needInput: "입력 필요",
  },
};
function t(key: string): string { return i18n[config.lang]?.[key] ?? i18n.zh[key] ?? key; }

// ── 调试日志 ─────────────────────────────────────────────────────────────────
const LOG = join(tmpdir(), "pi-notify-debug.log");
function log(msg: string): void {
  const ts = new Date().toISOString();
  try { appendFileSync(LOG, `[${ts}] ${msg}\n`, "utf-8"); } catch { /* ignore */ }
}

// ── ntfy 推送 ────────────────────────────────────────────────────────────────

// HTTP header 仅允许 ASCII，非 ASCII 标题按 RFC 2047 编码，ntfy 服务端会自动解码
function encodeNtfyHeader(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}

// 通知种类：完成 / 需要输入 / 错误，决定 ntfy Tags 图标
type NotifyKind = "complete" | "ask-user" | "error";

const NTFY_TAGS: Record<NotifyKind, string> = {
  "complete": "white_check_mark",
  "ask-user": "question",
  "error": "red_circle",
};

async function notifyNtfy(title: string, body: string, kind: NotifyKind, force = false): Promise<void> {
  const n = config.ntfy;
  // force 供 /notify test 使用：验证连通性不受开关限制，否则测试会被静默吞掉
  if ((!config.enabled && !force) || !n.topic) return;
  const headers: Record<string, string> = {
    Title: encodeNtfyHeader(title),
    Tags: NTFY_TAGS[kind],
  };
  // 自建服务器可能开启鉴权，配置了 token 则携带 Bearer 头
  if (n.token) headers.Authorization = `Bearer ${n.token}`;
  const url = `${n.server.replace(/\/+$/, "")}/${encodeURIComponent(n.topic)}`;
  try {
    const res = await fetch(url, { method: "POST", headers, body });
    if (!res.ok) {
      log(`ntfy: HTTP ${res.status} from ${n.server}`);
      // 推送失败时在 pi 内提示，避免静默失败难以排障
      piApi?.ui.notify(`ntfy push failed: HTTP ${res.status}`, "warning");
    }
  } catch (e: unknown) {
    log(`ntfy: send failed — ${e}`);
    piApi?.ui.notify(`ntfy push failed: ${e instanceof Error ? e.message : String(e)}`, "warning");
  }
}

// ── 会话内容提取 ──────────────────────────────────────────────────────────

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
function extractLastUserPrompt(ctx: ExtensionContext): string | null {
  try {
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i] as Record<string, unknown>;
      const msg = entry.message as Record<string, unknown> | undefined;
      const role = (entry.role ?? msg?.role) as string | undefined;
      if (role === "user") {
        const content = (entry.content ?? msg?.content);
        const text = cleanText(extractText(content));
        return text || null;
      }
    }
  } catch { /* fallback */ }
  return null;
}

// 最后一条 assistant 消息（stopReason 判断 + ai-text 提取）。
// agent_settled 的 event 无 messages payload，从 sessionManager 取。
function getLastAssistantMessage(ctx: ExtensionContext): { stopReason?: string; content?: unknown } | null {
  try {
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i] as Record<string, unknown>;
      const msg = entry.message as Record<string, unknown> | undefined;
      const role = (entry.role ?? msg?.role) as string | undefined;
      if (role === "assistant") {
        return {
          stopReason: (entry.stopReason ?? msg?.stopReason) as string | undefined,
          content: entry.content ?? msg?.content,
        };
      }
    }
  } catch { /* fallback */ }
  return null;
}

// ── 通知正文构建 ──────────────────────────────────────────────────────────

// 会话显示名回退链：session name → user-prompt 前 20 字 → "unnamed"
function resolveSessionName(pi: ExtensionAPI, ctx: ExtensionContext): string {
  const named = getSessionName(pi);
  if (named) return named;
  const prompt = extractLastUserPrompt(ctx);
  if (prompt) return prompt.length > 20 ? prompt.slice(0, 20) + "…" : prompt;
  return "unnamed";
}

// 通知标题：session name → user-prompt 前 25 字 → "pi"
function buildTitle(pi: ExtensionAPI, ctx: ExtensionContext): string {
  const named = getSessionName(pi);
  if (named) return named;
  const prompt = extractLastUserPrompt(ctx);
  if (prompt) return prompt.length > 25 ? prompt.slice(0, 25) + "…" : prompt;
  return "pi";
}

// 结构化正文。aiText 由调用方按通知种类决定（完成=AI 回复截断 / ask-user、error=固定文案）
function buildStructuredBody(ctx: ExtensionContext, aiText: string): string {
  const sessionId = getSessionId(ctx) ?? "unavailable";
  const prompt = extractLastUserPrompt(ctx) ?? "";
  const truncatedPrompt = prompt.length > 50 ? prompt.slice(0, 50) + "…" : prompt;
  const sessionName = piApi ? resolveSessionName(piApi, ctx) : "unnamed";
  return [
    `session-name: ${sessionName}`,
    `session-id: ${sessionId}`,
    `time: ${formatDateTime(Date.now())}`,
    `user-prompt: ${truncatedPrompt}`,
    `ai-text: ${aiText}`,
  ].join("\n");
}

// ── 三层开关闸门（agent_settled 与 ask-user 共用）────────────────────────
// 返回 true = 允许发送。勿扰过期顺带清理（跨实例同步点）。
function passGate(ctx: ExtensionContext): boolean {
  if (config.muteUntil && Date.now() > config.muteUntil) {
    saveMuteUntil(undefined);
    log("mute expired (gate check)");
  }
  const sessionId = getSessionId(ctx);
  if (sessionId && sessionNotifyStopped.has(sessionId)) return false;
  return config.enabled && !isMuted();
}

// ── 扩展入口 ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  log("extension loaded");
  piApi = pi;

  // 通知关闭时无需任何监听与判断：不注册事件 hook。
  // /notify 命令仍可注册，运行时打开后重启 pi 生效。
  if (config.enabled) {
    hooksRegistered = true;
  } else {
    log("notifications off at startup, hooks not registered");
  }

  // ── /notify 命令 ──────────────────────────────────────────────────────────
  pi.registerCommand("notify", {
    description: "开关/配置 ntfy 推送通知",
    getArgumentCompletions: (prefix: string) => {
      const parts = prefix.trim().split(/\s+/).filter(Boolean);
      const wantsNextLevel = prefix.endsWith(" ");

      if (parts.length === 0 || (parts.length === 1 && !wantsNextLevel)) {
        const subs = ["on", "stop", "session", "mute", "topic", "server", "token", "test", "lang", "status"];
        const filtered = subs.filter((s) => s.startsWith(parts[0] ?? ""));
        return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
      }
      const sub = parts[0];
      const val = parts[1] ?? "";
      if (sub === "session") {
        return ["on", "stop"].filter((s) => s.startsWith(val)).map((s) => ({ value: `session ${s}`, label: s }));
      }
      if (sub === "mute") {
        return ["off", "10m", "30m", "1h", "1d"].filter((s) => s.startsWith(val)).map((s) => ({ value: `mute ${s}`, label: s }));
      }
      if (sub === "lang") {
        return ["zh", "en", "ja", "ko"].filter((s) => s.startsWith(val)).map((s) => ({ value: `${sub} ${s}`, label: s }));
      }
      return null;
    },
    handler: async (args: string, ctx: ExtensionContext) => {
      const raw = args?.trim() ?? "";
      const parts = raw.split(/\s+/);
      const sub = parts[0]?.toLowerCase();
      // topic/token 大小写敏感，保留原始值；仅开关类子命令用小写比较
      const val = parts.slice(1).join(" ").toLowerCase();

      // hook 只在启动时按配置注册一次：从关闭状态打开时需重启才能生效
      const restartHint = () => {
        if (!hooksRegistered && config.enabled) {
          ctx.ui.notify("Restart pi to activate notifications", "warning");
        }
      };

      // 状态总览：三层开关 + ntfy 配置 + 勿扰，无参 /notify 与 /notify status 共用
      const showStatus = () => {
        // 同步检查勿扰过期
        if (config.muteUntil && Date.now() > config.muteUntil) {
          saveMuteUntil(undefined);
          log("mute expired (checked on status)");
        }
        const sessionId = getSessionId(ctx);
        const sessionState = sessionId && sessionNotifyStopped.has(sessionId) ? "STOP" : "ON";
        let muteInfo = "";
        if (isMuted()) {
          const remaining = Math.round(((config.muteUntil ?? 0) - Date.now()) / 60000);
          muteInfo = " " + t("muteRemaining").replace("{0}", remaining.toString());
        }
        const ntfyStatus = `topic=${config.ntfy.topic || "not set"} server=${config.ntfy.server}${config.ntfy.token ? " (auth)" : ""}`;
        ctx.ui.notify(
          `Notify ${config.enabled ? "ON 🔔" : "STOP 🔕"} | Session ${sessionState} | ${ntfyStatus} | Language=${config.lang}${muteInfo}`,
          "info",
        );
      };

      // 无参 = 状态总览
      if (!sub) { showStatus(); return; }

      // ── 全局级：持久化总闸 ──────────────────────────────────────
      // 未配置 topic 时开启无意义：拒绝并提示，只允许保持关闭
      if (sub === "on") {
        if (!isNtfyConfigured()) {
          ctx.ui.notify("ntfy not configured — set topic first: /notify topic <name>", "warning");
          return;
        }
        config.enabled = true; saveConfig(config); ctx.ui.notify(t("enabled"), "info"); restartHint(); return;
      }
      if (sub === "stop") { config.enabled = false; saveConfig(config); ctx.ui.notify(t("disabled"), "info"); return; }

      // ── 会话级：仅当前 pi 会话，内存态，重启后重置 ──────────────────
      if (sub === "session") {
        const ssub = parts[1]?.toLowerCase();
        const sessionId = getSessionId(ctx);
        if (!sessionId) { ctx.ui.notify("Session id unavailable in this context", "warning"); return; }
        if (ssub === "on") {
          sessionNotifyStopped.delete(sessionId);
          ctx.ui.notify(t("sessionOn"), "info");
          return;
        }
        if (ssub === "stop") {
          sessionNotifyStopped.add(sessionId);
          ctx.ui.notify(t("sessionStop"), "info");
          return;
        }
        ctx.ui.notify("Usage: /notify session on|stop", "warning");
        return;
      }

      // ── 勿扰：限时静音，持久化时间戳，多实例自动同步 ────────────────
      if (sub === "mute") {
        const mval = parts.slice(1).join(" ").trim().toLowerCase();
        if (!mval) {
          // 无参默认 1 小时
          saveMuteUntil(Date.now() + MUTE_DURATION_UNITS.h);
          ctx.ui.notify(t("muted").replace("{0}", formatClock(config.muteUntil!)), "info");
          return;
        }
        if (mval === "off") {
          saveMuteUntil(undefined);
          ctx.ui.notify(t("unmuted"), "info");
          return;
        }
        const ms = parseMuteDuration(mval);
        if (ms === null) {
          ctx.ui.notify("Usage: /notify mute [Ns|Nm|Nh|Nd | off] (e.g. 30m 1h 1d; default 1h)", "warning");
          return;
        }
        saveMuteUntil(Date.now() + ms);
        ctx.ui.notify(t("muted").replace("{0}", formatClock(config.muteUntil!)), "info");
        return;
      }

      if (sub === "lang") {
        if (i18n[val]) { config.lang = val as typeof config.lang; saveConfig(config); ctx.ui.notify(`Language=${val}`, "info"); }
        else { ctx.ui.notify("Available: zh en ja ko", "warning"); }
        return;
      }

      // ── ntfy 配置（单渠道，命令直接在顶层）──────────────────────
      if (sub === "topic") {
        // 保留原始大小写（topic 大小写敏感）
        const nval = parts.slice(1).join(" ").trim();
        if (nval) {
          config.ntfy.topic = nval.split(/\s+/)[0];
          saveConfig(config);
          ctx.ui.notify(`ntfy topic = ${config.ntfy.topic}`, "info");
        } else {
          ctx.ui.notify(`Usage: /notify topic <name> (current: ${config.ntfy.topic || "not set"})`, "warning");
        }
        return;
      }

      if (sub === "server") {
        const nval = parts.slice(1).join(" ").trim();
        if (nval) {
          config.ntfy.server = nval.replace(/\/+$/, "");
          saveConfig(config);
          ctx.ui.notify(`ntfy server = ${config.ntfy.server}`, "info");
        } else {
          ctx.ui.notify(`Usage: /notify server <url> (current: ${config.ntfy.server})`, "warning");
        }
        return;
      }

      if (sub === "token") {
        // token 大小写敏感，保留原始值
        const nval = parts.slice(1).join(" ").trim();
        if (nval) {
          config.ntfy.token = nval.split(/\s+/)[0];
          saveConfig(config);
          ctx.ui.notify("ntfy token saved", "info");
        } else {
          ctx.ui.notify(
            config.ntfy.token ? "ntfy token: set (use /notify token <new> to replace)" : "Usage: /notify token <token>",
            "warning",
          );
        }
        return;
      }

      if (sub === "test") {
        if (!config.ntfy.topic) { ctx.ui.notify("Set topic first: /notify topic <name>", "warning"); return; }
        ctx.ui.notify("Sending ntfy test...", "info");
        // 测试不受开关限制，但提醒用户当前开关状态，避免误以为已启用
        if (!config.enabled) ctx.ui.notify("Note: notify is STOP — use /notify on to enable", "warning");
        void notifyNtfy("pi ntfy test", "If you can read this, ntfy is configured correctly.", "complete", true);
        return;
      }

      // /notify status
      if (sub === "status") {
        showStatus();
        return;
      }

      ctx.ui.notify(`Unknown: ${raw} — try /notify status`, "warning");
    },
  });

  // ── 事件（仅通知开启时注册，见入口处 hooksRegistered 赋值）─────────
  if (!hooksRegistered) return;

  // 缓存 ctx 供跨扩展事件总线的回调使用（它们没有 ctx 参数）
  pi.on("session_start", async (_event, ctx) => {
    cachedCtx = ctx;
    log("session_start");
  });

  // agent_settled：pi 不再自动继续的真正完成点。
  // pi 内部在可重试错误时自动 continue 循环、压缩后重试，settled 只在
  // 彻底结束时触发，因此无需我们再做重试识别与去抖。
  pi.on("agent_settled", (_event, ctx) => {
    // 未配置 topic 时静默短路（含改 JSON 强行置开的场景）：不发送、不记日志、无提示。
    // 直改 JSON 不是正确的用户行为，不做任何兜底。
    if (!config.ntfy.topic) return;

    log("agent_settled");
    if (!passGate(ctx)) { log("agent_settled: gate blocked, skip"); return; }

    const msg = getLastAssistantMessage(ctx);
    if (msg) log(`agent_settled: stopReason=${msg.stopReason}`);

    // 用户主动中断的回合：自己掐的，不通知
    if (msg?.stopReason === "aborted") { log("aborted, skip"); return; }

    const title = buildTitle(pi, ctx);
    let aiText: string;
    let kind: NotifyKind;
    if (msg?.stopReason === "error") {
      // 错误回合也要通知（人可能已离开，需要知道出事了），固定文案
      aiText = t("errorText");
      kind = "error";
    } else {
      const text = msg ? cleanText(extractText(msg.content)) : "";
      // 正常完成：AI 回复截 80 字；无文本的罕见场景退化为空串（正文仍有其余字段）
      aiText = text.length > 80 ? text.slice(0, 80) + "…" : text;
      kind = "complete";
    }

    log(`notification: "${title}" kind=${kind}`);
    void notifyNtfy(title, buildStructuredBody(ctx, aiText), kind);
  });

  // ask-user：agent 需要用户输入时（来自 @juicesharp/rpiv-ask-user-question）。
  // 静默监听：未安装该扩展则事件永不触发，零成本。
  // 注意用 pi.events.on（跨扩展事件总线）而非 pi.on（pi 生命周期），回调无 ctx，
  // 用 session_start 缓存的 cachedCtx。
  pi.events.on(ASK_USER_PROMPT_EVENT, () => {
    const ctx = cachedCtx;
    if (!ctx) return;
    if (!config.ntfy.topic) return;
    log(ASK_USER_PROMPT_EVENT);
    if (!passGate(ctx)) { log("ask-user: gate blocked, skip"); return; }

    const sessionName = resolveSessionName(pi, ctx);
    const title = `[${sessionName}] ${t("needInput")}`;
    log(`notification: "${title}" kind=ask-user`);
    void notifyNtfy(title, buildStructuredBody(ctx, t("askUserText")), "ask-user");
  });
}
