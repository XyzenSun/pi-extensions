#!/bin/bash
# pi-hooks 脚本工具库 — 经 PI_HOOK_LIB 环境变量定位，脚本开头 source 即可。
#
#   source "$PI_HOOK_LIB/lib.sh"
#
# 三个函数（各几行，可抄可改）：
#   hook_out [落点]   把 stdin 任意文本包装成协议要求的 JSON 输出
#   hook_every N      每调用到第 N 的整数倍次返回真，当前计数在 $HOOK_ROUND
#   hook_once         本会话首次调用返回真并落 done 标记
#
# 状态存于 PI_HOOK_STATE_DIR（引擎按 hook 条目分配的私有目录）。

# hook_out：stdin 文本 → {"content": "..."} 或 {"to": "...", "content": "..."}
# 转义由 node 完成（pi 环境必有 node），不依赖 jq。
hook_out() {
  local to="${1:-}"
  if [ -n "$to" ]; then
    node -e '
      let s = "";
      process.stdin.on("data", (c) => (s += c));
      process.stdin.on("end", () =>
        process.stdout.write(JSON.stringify({ to: process.argv[1], content: s })));
    ' "$to"
  else
    node -e '
      let s = "";
      process.stdin.on("data", (c) => (s += c));
      process.stdin.on("end", () => process.stdout.write(JSON.stringify({ content: s })));
    '
  fi
}

# hook_every N：计数器文件在状态目录，返回真时 HOOK_ROUND 为当前计数。
hook_every() {
  local n="${1:?用法: hook_every N}"
  local count_file="$PI_HOOK_STATE_DIR/every.count"
  local count=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))
  echo "$count" > "$count_file" 2>/dev/null
  HOOK_ROUND="$count"
  [ $(( count % n )) -eq 0 ]
}

# hook_once：本状态目录首次调用返回真，之后永远返回假。
# 与 Claude Code 的 once 语义一致：失败不落标记，只有走到这里才算一次。
hook_once() {
  local marker="$PI_HOOK_STATE_DIR/once.done"
  [ ! -f "$marker" ] || return 1
  touch "$marker" 2>/dev/null
  return 0
}
