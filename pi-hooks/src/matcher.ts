/**
 * match 语义：为每次事件构造目标串，用 match 正则做一次非锚定搜索。
 *
 * 目标串规则：
 *   工具事件拼成 `工具名(主参数)`，如 bash(git push)、edit(src/a.ts)；
 *   非工具事件直接用主字段原文，如 input 事件用输入文本、user_bash 用命令本身。
 * 主参数映射内置于此：bash/powershell 取 input.command，read/edit/write/ls 取
 * input.path，grep/find 取 input.pattern；自定义工具不拼参数，目标串即工具名。
 */

import type { ExtensionEvent } from "@earendil-works/pi-coding-agent";

/** 内置工具的主参数字段。自定义工具没有映射，目标串退化为工具名。 */
const TOOL_PRIMARY_FIELD: Record<string, string> = {
  bash: "command",
  powershell: "command",
  read: "path",
  edit: "path",
  write: "path",
  ls: "path",
  grep: "pattern",
  find: "pattern",
};

/** 从事件载荷中取工具主参数。 */
function toolPrimaryArg(event: { toolName: string; input?: unknown }): string | undefined {
  const field = TOOL_PRIMARY_FIELD[event.toolName];
  if (!field) return undefined;
  const input = event.input;
  if (input === null || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

/**
 * 构造事件的目标串。
 * 返回 undefined 表示该事件没有可匹配的目标（如无载荷的通知事件），
 * 此时若 hook 配置了 match，加载期应警告、运行期直接跳过。
 */
export function buildTarget(event: ExtensionEvent): string | undefined {
  switch (event.type) {
    case "tool_call":
    case "tool_result":
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end": {
      const arg = toolPrimaryArg(event as unknown as { toolName: string; input?: unknown });
      return arg === undefined ? event.toolName : `${event.toolName}(${arg})`;
    }
    case "input":
      return event.text;
    case "user_bash":
      return event.command;
    case "before_agent_start":
      return event.prompt;
    case "session_before_compact":
      return event.customInstructions;
    default:
      return undefined;
  }
}

/** match 测试：无 match 放行；目标串缺失时不放行（配置了 match 却无目标可搜）。 */
export function matches(match: RegExp | undefined, target: string | undefined): boolean {
  if (match === undefined) return true;
  if (target === undefined) return false;
  return match.test(target);
}
