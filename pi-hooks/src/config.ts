/**
 * hooks.json 配置层：加载、校验、热重载。
 *
 * 双层配置：全局 ~/.pi/agent/hooks.json + 项目 .pi/hooks.json，
 * 同事件下先全局后项目。配置只是注册表，行为逻辑全在 bash 脚本里。
 */

import { readFileSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** pi 0.85.1 全部 36 个事件名。on 字段必须是其中之一。 */
export const PI_EVENTS = [
  "project_trust",
  "resources_discover",
  "session_start",
  "session_info_changed",
  "session_before_switch",
  "session_before_fork",
  "session_before_compact",
  "session_compact",
  "session_compact_failed",
  "session_shutdown",
  "session_before_tree",
  "session_tree",
  "context",
  "before_provider_request",
  "before_provider_headers",
  "after_provider_response",
  "before_agent_start",
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
  "tool_call",
  "tool_result",
  "user_bash",
  "input",
] as const;

export type PiEventName = (typeof PI_EVENTS)[number];

/** 单条 hook 的 5 字段 schema。 */
export interface HookEntry {
  /** 事件名 */
  on: PiEventName;
  /** bash 字符串 */
  run: string;
  /** 可选：对目标串做正则搜索，搜到才执行 */
  match?: RegExp;
  /** 可选：超时秒数，默认 30 */
  timeout?: number;
  /** 可选：默认 true，false 则该条目不生效 */
  enabled: boolean;
  /** 来源层：global 或 project，诊断用 */
  layer: "global" | "project";
  /** 在配置文件中的序号，诊断用 */
  index: number;
  /** 条目内容指纹，状态目录按此分配（改动内容即状态归零） */
  id: string;
}

export interface LoadResult {
  /** 校验通过的 hook 条目（全局在前，项目在后） */
  hooks: HookEntry[];
  /** 用户可见的错误/警告（配置问题必须显式可见，不允许静默失效） */
  problems: string[];
}

interface RawHook {
  on?: unknown;
  run?: unknown;
  match?: unknown;
  timeout?: unknown;
  enabled?: unknown;
}

/** 稳定字符串化（键排序），用于条目指纹。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

/**
 * 校验并规范化一条原始配置。
 * 返回 null 表示该条目被拒绝，reason 说明原因。
 */
function validateHook(
  raw: unknown,
  layer: "global" | "project",
  index: number,
): { hook: HookEntry } | { hook: null; reason: string } {
  const where = `${layer}[${index}]`;
  if (typeof raw !== "object" || raw === null) {
    return { hook: null, reason: `${where}: 条目必须是对象` };
  }
  const r = raw as RawHook;

  if (typeof r.on !== "string") return { hook: null, reason: `${where}: on 必填且为字符串` };
  if (!(PI_EVENTS as readonly string[]).includes(r.on)) {
    return { hook: null, reason: `${where}: 未知事件名 "${r.on}"` };
  }

  if (typeof r.run !== "string" || r.run.trim() === "") {
    return { hook: null, reason: `${where}: run 必填且为非空字符串` };
  }

  let match: RegExp | undefined;
  if (r.match !== undefined) {
    if (typeof r.match !== "string") return { hook: null, reason: `${where}: match 必须是字符串` };
    try {
      match = new RegExp(r.match);
    } catch (e) {
      return { hook: null, reason: `${where}: match 不是合法正则 — ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  if (r.timeout !== undefined) {
    if (typeof r.timeout !== "number" || !Number.isFinite(r.timeout) || r.timeout <= 0) {
      return { hook: null, reason: `${where}: timeout 必须是正数（秒）` };
    }
  }

  if (r.enabled !== undefined && typeof r.enabled !== "boolean") {
    return { hook: null, reason: `${where}: enabled 必须是布尔值` };
  }

  const hook: HookEntry = {
    on: r.on as PiEventName,
    run: r.run,
    match,
    timeout: r.timeout,
    enabled: r.enabled ?? true,
    layer,
    index,
    id: "",
  };
  hook.id = stableStringify({ on: hook.on, run: hook.run, match: r.match, timeout: r.timeout });
  return { hook };
}

/** 解析单个 hooks.json 文件内容。文件级错误（JSON 语法）整份不生效。 */
export function parseFileContent(text: string, layer: "global" | "project", path: string): LoadResult {
  const problems: string[] = [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    // 直接报错：该文件整份视为不生效（另一层配置不受影响）
    return {
      hooks: [],
      problems: [`hooks.json 解析失败（${path}）：${e instanceof Error ? e.message : String(e)}，该文件全部条目未生效`],
    };
  }

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { hooks: [], problems: [`hooks.json 格式错误（${path}）：顶层必须是 {"hooks": [...]} 对象`] };
  }
  const rawHooks = (data as { hooks?: unknown }).hooks;
  if (rawHooks === undefined) {
    return { hooks: [], problems: [] };
  }
  if (!Array.isArray(rawHooks)) {
    return { hooks: [], problems: [`hooks.json 格式错误（${path}）：hooks 字段必须是数组`] };
  }

  const hooks: HookEntry[] = [];
  rawHooks.forEach((raw, i) => {
    const result = validateHook(raw, layer, i);
    if (result.hook) hooks.push(result.hook);
    else problems.push(result.reason);
  });
  return { hooks, problems };
}

export function globalConfigPath(): string {
  return join(getAgentDir(), "hooks.json");
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, ".pi", "hooks.json");
}

/**
 * 读取并合并双层配置。读取失败（文件不存在）按空处理；
 * 解析失败已在 parseFileContent 内转为 problems。
 */
export function loadAll(globalPath: string, projectPath: string): LoadResult {
  const problems: string[] = [];
  const hooks: HookEntry[] = [];

  for (const [path, layer] of [
    [globalPath, "global"],
    [projectPath, "project"],
  ] as const) {
    let text: string | null = null;
    try {
      text = readFileSync(path, "utf-8");
    } catch {
      continue; // 文件不存在是常态，静默跳过
    }
    const result = parseFileContent(text, layer, path);
    hooks.push(...result.hooks);
    problems.push(...result.problems);
  }

  return { hooks, problems };
}

/**
 * 热重载：监听配置文件变化，防抖后回调。
 * 返回清理函数（session_shutdown 时调用）。
 */
export function watchConfigs(
  paths: string[],
  onChange: () => void,
  debounceMs = 300,
): () => void {
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;

  for (const path of paths) {
    try {
      const watcher = watch(path, { persistent: false }, () => {
        // 编辑器保存常触发多次事件，防抖合并
        if (timer) clearTimeout(timer);
        timer = setTimeout(onChange, debounceMs);
      });
      watcher.on("error", () => {}); // 文件被删/权限问题：静默，下次 session_start 重读兜底
      watchers.push(watcher);
    } catch {
      // 文件不存在时 watch 会抛错，跳过
    }
  }

  return () => {
    if (timer) clearTimeout(timer);
    for (const w of watchers) w.close();
  };
}
