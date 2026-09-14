/**
 * pi-mctx 配置读取。
 *
 * 位置: <getAgentDir()>/pi-mctx.json (即 ~/.pi/agent/pi-mctx.json)。
 * Pi 的 settings.json packages 条目不支持自定义字段透传, 因此使用独立配置文件。
 *
 * 容错策略 (设计文档 §6): 文件不存在用默认值; JSON 解析失败/字段类型不符
 * 逐项回退默认并记录告警, 绝不抛出。读取时机: 扩展初始化一次。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { dbg } from "./debug.ts";

// 占位符默认文案 (设计文档 §3.9 定稿)。{id} 为替换槽位, 其余内容逐字节稳定。
export const DEFAULT_PLACEHOLDER =
  '[系统操作提示] 此结果已移出上下文。需要时调用tool： obs({ id: "{id}" }) 取回。';

export const DEFAULT_MIN_BYTES = 2048;

export interface SinkConfig {
  minBytes: number;
  placeholder: string;
}

export interface MctxConfig {
  sink: SinkConfig;
}

export function defaultConfig(): MctxConfig {
  return {
    sink: {
      minBytes: DEFAULT_MIN_BYTES,
      placeholder: DEFAULT_PLACEHOLDER,
    },
  };
}

export function loadConfig(): MctxConfig {
  const config = defaultConfig();
  const configPath = join(getAgentDir(), "pi-mctx.json");
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      dbg("config", "配置根必须是对象, 已回退默认值", { configPath });
      return config;
    }
    const root = parsed as { sink?: unknown };

    if (root.sink !== undefined) {
      if (root.sink === null || typeof root.sink !== "object" || Array.isArray(root.sink)) {
        dbg("config", "配置字段 sink 必须是对象, 已回退默认值");
      } else {
        const sink = root.sink as { minBytes?: unknown; placeholder?: unknown };
        if (typeof sink.minBytes === "number" && Number.isFinite(sink.minBytes) && sink.minBytes > 0) {
          config.sink.minBytes = sink.minBytes;
        } else if (sink.minBytes !== undefined) {
          dbg("config", "配置字段 sink.minBytes 需为正数, 已回退默认值");
        }
        // 占位符必须包含 {id} 槽位, 否则投影无法指引回读, 回退默认。
        if (typeof sink.placeholder === "string" && sink.placeholder.includes("{id}")) {
          config.sink.placeholder = sink.placeholder;
        } else if (sink.placeholder !== undefined) {
          dbg("config", "配置字段 sink.placeholder 缺少 {id} 或类型不符, 已回退默认值");
        }
      }
    }
    dbg("config", "配置加载完成", { configPath, config });
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // 配置文件不存在是正常情况, 静默使用默认值。
      dbg("config", "配置文件不存在, 使用默认值", { configPath });
      return config;
    }
    dbg("config", "配置解析失败, 使用默认值", { configPath, error: String(error) });
    return config;
  }
}
