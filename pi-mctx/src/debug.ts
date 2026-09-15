/**
 * pi-mctx 调试日志。
 *
 * 输出到 <tmpdir>/pi-mctx/debug.log, 供人工调试排查。
 * 开关: 环境变量 PI_MCTX_DEBUG_ENABLED (设为 1/true/yes 开启, 其余值关闭)。
 * 关闭时所有 dbg 调用为 no-op, 不产生任何 I/O。
 *
 * 日志失败必须静默: 调试设施绝不能影响插件功能。
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";

const LOG_DIR = join(tmpdir(), "pi-mctx");
const LOG_FILE = join(LOG_DIR, "debug.log");

// 单条日志数据的截断上限, 防止把超长内容 (如完整序列化会话) 无限写进日志。
const MAX_DATA_LENGTH = 8000;

// 环境变量开关, 模块加载时读取一次。
// 布尔真值集合: 1/true/yes (大小写不敏感), 其余一律视为关闭。
const TRUTHY_VALUES = new Set(["1", "true", "yes"]);

export const DEBUG_ENABLED = TRUTHY_VALUES.has(
  (process.env.PI_MCTX_DEBUG_ENABLED ?? "").trim().toLowerCase(),
);

function truncateForLog(value: string): string {
  if (value.length <= MAX_DATA_LENGTH) return value;
  return `${value.slice(0, MAX_DATA_LENGTH)}\n...[truncated, total ${value.length} chars]`;
}

function safeStringify(data: unknown): string {
  if (typeof data === "string") return truncateForLog(data);
  try {
    return truncateForLog(JSON.stringify(data, null, 2) ?? String(data));
  } catch {
    // 循环引用等无法序列化的对象, 退化为 String()。
    return String(data);
  }
}

/** 追加一条调试日志。data 可选, 为对象时以 JSON 展开。 */
export function dbg(scope: string, message: string, data?: unknown): void {
  if (!DEBUG_ENABLED) return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const timestamp = new Date().toISOString();
    const line =
      data === undefined
        ? `[${timestamp}] [${scope}] ${message}\n`
        : `[${timestamp}] [${scope}] ${message}\n${safeStringify(data)}\n`;
    appendFileSync(LOG_FILE, line);
  } catch {
    // 静默忽略: 日志失败不影响插件功能
  }
}
