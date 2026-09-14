/**
 * pi-mctx 调试日志。
 *
 * 输出到 <tmpdir>/pi-mctx/debug.log, 供人工调试排查。
 * 正式发布时把 DEBUG_ENABLED 置为 false, 所有 dbg 调用变为 no-op,
 * 不产生任何 I/O 与字符串构造开销。
 *
 * 日志失败必须静默: 调试设施绝不能影响插件功能。
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";

// 调试开关: 需要排查问题时置为 true, 发布版本保持 false。
export const DEBUG_ENABLED = false;

const LOG_DIR = join(tmpdir(), "pi-mctx");
const LOG_FILE = join(LOG_DIR, "debug.log");

// 单条日志数据的截断上限, 防止把超长内容 (如完整序列化会话) 无限写进日志。
const MAX_DATA_LENGTH = 8000;

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
