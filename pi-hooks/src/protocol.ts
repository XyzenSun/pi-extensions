/**
 * 协议层：把执行结果翻译成统一决策。
 *
 * 退出码约定（与 Claude Code 同构）：
 *   exit 0  放行；stdout 非空则必须是 JSON 对象 {"content": ..., "to": ...}
 *   exit 2  阻断/取消，stderr 作为理由
 *   其他    非阻断错误，记诊断
 *   超时    非阻断错误，记诊断
 *
 * stdout 是 JSON-only（不抄 CC 的纯文本宽容）：解析只有一条路径，
 * 写 JSON 的成本由 lib.sh 的 hook_out 抹平。
 */

import type { ExecOutcome } from "./runner.ts";

/** 脚本经 stdout 表达的结构化输出。 */
export interface HookOutput {
  /** 正文：注入/改写的文本 */
  content?: unknown;
  /** 落点覆盖：仅 input 与 before_agent_start 有多落点 */
  to?: unknown;
}

/** 统一决策：适配器据此翻译成各事件的返回值。 */
export type Decision =
  | { kind: "none" } // 无事发生（exit 0 且 stdout 空）
  | { kind: "output"; output: HookOutput; raw: string } // exit 0 且 stdout 非空
  | { kind: "block"; reason: string } // exit 2：阻断/取消
  | { kind: "error"; message: string }; // 非阻断错误：诊断可见

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.slice(0, 200);
}

/** 解析 stdout 为 HookOutput。非法 JSON 返回 null。 */
export function parseStdout(stdout: string): HookOutput | null {
  const text = stdout.trim();
  if (text === "") return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null; // 必须是对象，数组/null 不算
    }
    return parsed as HookOutput;
  } catch {
    return null;
  }
}

/** 把执行结果翻译成统一决策。诊断文案面向用户，提示 hook_out。 */
export function interpret(outcome: ExecOutcome): Decision {
  if (outcome.timedOut) {
    return { kind: "error", message: `hook 超时（${firstLine(outcome.stderr) || "无 stderr"}）` };
  }
  if (outcome.code === 2) {
    const reason = outcome.stderr.trim() || "hook 阻断（未给出理由）";
    return { kind: "block", reason };
  }
  if (outcome.code === null) {
    return { kind: "error", message: `hook 进程异常终止：${firstLine(outcome.stderr)}` };
  }
  if (outcome.code !== 0) {
    return { kind: "error", message: `hook 退出码 ${outcome.code}：${firstLine(outcome.stderr)}` };
  }
  // exit 0：stdout 空为无事发生，非空必须是 JSON 对象
  if (outcome.stdout.trim() === "") return { kind: "none" };
  const parsed = parseStdout(outcome.stdout);
  if (parsed === null) {
    return {
      kind: "error",
      message: `hook stdout 不是合法 JSON 对象（${firstLine(outcome.stdout)}），请在脚本末尾用 hook_out 包装输出`,
    };
  }
  return { kind: "output", output: parsed, raw: outcome.stdout };
}

/** 从 HookOutput 取 content 字符串。非字符串视为缺失。 */
export function contentText(output: HookOutput): string | undefined {
  const c = output.content;
  return typeof c === "string" && c !== "" ? c : undefined;
}

/** 从 HookOutput 取 to 落点。仅接受已知值。 */
export function targetOf(output: HookOutput): string | undefined {
  const to = output.to;
  return typeof to === "string" && to !== "" ? to : undefined;
}
