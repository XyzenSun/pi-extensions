/**
 * obs 工具: 按 id 整条读回已下沉的工具结果。
 *
 * 始终注册 (设计文档 D14): 工具 schema 极小, 动态注册/注销反而会
 * 反复修改系统提示、打断缓存前缀, 得不偿失。
 * 不分页 (设计文档 D24): 下沉物本就完整装进过上下文, 整条读回不会
 * 超出下沉前的峰值; 分页徒增工具调用与往返。
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dbg } from "./debug.ts";
import { isSafeId, readSunkFile } from "./sink-store.ts";

export function registerObsTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "obs",
    label: "Obs",
    description:
      'Read back a tool result that was moved out of context. When you see a placeholder reading ' +
      '"[系统操作提示] 此结果已移出上下文。需要时调用tool： obs({ id: ... }) 取回。" ' +
      "in an earlier tool result and you need its full content, call this tool with the id from that placeholder. " +
      "Returns the complete original content in one piece.",
    parameters: Type.Object({
      id: Type.String({ description: "The id shown in the placeholder, e.g. call_00_..." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const id = params.id.trim();
      const sessionId = ctx.sessionManager.getSessionId();
      dbg("obs", "回读请求", { id, sessionId });
      if (!isSafeId(id)) {
        throw new Error(`obs: 非法 id: ${id}`);
      }
      let text: string;
      try {
        text = readSunkFile(sessionId, id);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`obs: 未知 id (可能从未下沉, 或已被撤销): ${id}`);
        }
        throw error;
      }
      dbg("obs", "回读成功", { id, bytes: Buffer.byteLength(text, "utf8") });
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}
