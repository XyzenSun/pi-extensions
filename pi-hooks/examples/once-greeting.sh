#!/bin/bash
# 示例：会话首次问候（before_agent_start + hook_once + systemPrompt 追加）
# 每个会话只在第一次提交时把提示词追加到系统提示词末尾（当轮生效，不落盘）。
# hooks.json:
#   { "on": "before_agent_start", "run": "./hooks/once-greeting.sh" }
source "$PI_HOOK_LIB/lib.sh"
hook_once || exit 0
echo "本会话由 pi-hooks 引擎接管，注意遵守仓库规范" | hook_out
