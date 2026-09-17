#!/bin/bash
# 示例：每 10 轮输入提醒（input 事件 + hook_every 计数）
# 计数器由引擎状态目录持久化，跨压缩存活；$HOOK_ROUND 是当前轮次。
# hooks.json:
#   { "on": "input", "run": "./hooks/round-reminder.sh" }
source "$PI_HOOK_LIB/lib.sh"
hook_every 10 || exit 0
echo "已对话 $HOOK_ROUND 轮，考虑更新全局记忆" | hook_out message
