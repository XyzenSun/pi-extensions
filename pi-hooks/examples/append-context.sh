#!/bin/bash
# 示例：临时上下文注入（context 事件 + hook_out 默认落点）
# 每轮 LLM 调用前把动态内容追加进上下文，不落盘、不占会话文件。
# hooks.json:
#   { "on": "context", "run": "./hooks/append-context.sh" }
source "$PI_HOOK_LIB/lib.sh"
echo "当前时间 $(date '+%H:%M')，工作目录 $PI_CWD" | hook_out
