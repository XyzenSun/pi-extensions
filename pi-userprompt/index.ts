import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadUserPrompt } from "./user-prompt.ts";

export default function (pi: ExtensionAPI) {
  let userPrompt: string | undefined;
  let loadedAt = 0;

  pi.on("session_start", async (_event, ctx) => {
    // 会话替换或重新加载时先清空, 避免读取失败后沿用旧项目的内容.
    userPrompt = undefined;
    try {
      userPrompt = await loadUserPrompt(ctx.cwd, getAgentDir(), ctx.isProjectTrusted());
      loadedAt = Date.now();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI) ctx.ui.notify(`pi-userprompt: ${message}`, "warning");
      else process.stderr.write(`pi-userprompt: ${message}\n`);
    }
  });

  pi.on("context", (event) => {
    if (!userPrompt) return;

    // context 只改当前请求的副本. 原文不进入历史和压缩, 每次请求重新携带一份.
    // 固定时间戳并创建新消息对象, 避免请求间元数据变化或其他 hook 修改缓存正文.
    return {
      messages: [
        { role: "user" as const, content: [{ type: "text" as const, text: userPrompt }], timestamp: loadedAt },
        ...event.messages,
      ],
    };
  });
}
