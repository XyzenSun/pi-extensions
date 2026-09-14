/**
 * sink 投影: context 钩子把命中已沉集合的 toolResult 内容替换为占位符。
 *
 * 硬性约束 (设计文档 §3.7):
 * - 只改 content, role/toolCallId/toolName/isError/timestamp/details 原样保留,
 *   tool_use/tool_result 配对永不破
 * - 不改变消息数量与顺序
 * - 占位符逐字节稳定: 同一 id 每轮生成完全相同的内容 (保护缓存前缀)
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { dbg } from "./debug.ts";

type ToolResultAgentMessage = Extract<AgentMessage, { role: "toolResult" }>;

// 纯文本判定与合格判定 (sink-command) 保持一致: 含图片等非文本块的结果
// 不会被 sink, 这里同样跳过, 双保险。
function isPureTextToolResult(message: AgentMessage): message is ToolResultAgentMessage {
  if (message.role !== "toolResult") return false;
  return message.content.every((block) => block.type === "text");
}

export function renderPlaceholder(template: string, id: string): string {
  return template.replace("{id}", id);
}

/** 投影主函数: 返回替换后的消息数组。未命中任何条目时原数组原样返回。 */
export function projectSunkMessages(
  messages: AgentMessage[],
  sunkIds: ReadonlySet<string>,
  placeholderTemplate: string,
): AgentMessage[] {
  let hitCount = 0;
  const projected = messages.map((message) => {
    if (!isPureTextToolResult(message)) return message;
    if (!sunkIds.has(message.toolCallId)) return message;
    hitCount++;
    return {
      ...message,
      content: [{ type: "text" as const, text: renderPlaceholder(placeholderTemplate, message.toolCallId) }],
    };
  });
  if (hitCount > 0) {
    dbg("sink-project", "投影完成", { total: messages.length, hits: hitCount });
  }
  return projected;
}
