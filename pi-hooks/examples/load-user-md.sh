#!/bin/bash
# 示例：持久消息注入（before_agent_start + hook_out 指定落点）
# 每次用户提交时注入一条持久 custom 消息（落盘进会话文件，UI 隐藏）。
# 通常配合 hook_once 使用（见 once-greeting.sh）。
# hooks.json:
#   { "on": "before_agent_start", "run": "./hooks/load-user-md.sh" }
source "$PI_HOOK_LIB/lib.sh"
cat ./USER.md | hook_out message
