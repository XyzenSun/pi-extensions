#!/bin/bash
# 示例：拦截危险命令（tool_call + exit 2 阻断）
# hooks.json:
#   { "on": "tool_call", "match": "^bash\\(", "run": "./hooks/block-rm.sh" }
# stdin 是事件 JSON，toolName 与 input.command 字段直接用 jq 取。
input=$(cat)
command=$(echo "$input" | jq -r '.input.command // empty')
if echo "$command" | grep -qE '(^|[;&| ])rm -rf'; then
  echo "Blocked: rm -rf is not allowed" >&2
  exit 2
fi
exit 0
