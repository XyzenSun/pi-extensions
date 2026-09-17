# pi-hooks

配置驱动的 hook 引擎：用一份 `hooks.json` 声明"在哪个事件点、过滤什么、跑哪段 bash"，行为逻辑全部写在 bash 脚本里。设计思路见 `doc/design.md`，调研结论见 `doc/research.md`，开发参考见 `doc/development.md`。

## 安装

```bash
pi package add npm:@xyzensun/pi-hooks
```

## 配置

两层配置，同事件下先全局后项目：

- 全局：`~/.pi/agent/hooks.json`
- 项目：`<项目根>/.pi/hooks.json`

```jsonc
{
  "hooks": [
    {
      "on": "tool_call",              // 事件名（36 个 pi 事件之一）
      "match": "^bash\\(git push",    // 可选：正则，对目标串搜索，搜到才执行
      "run": "./hooks/check-push.sh", // bash 命令
      "timeout": 10,                  // 可选：秒，默认 30
      "enabled": true                 // 可选：默认 true，false 停用该条
    }
  ]
}
```

配置文件保存后热重载；JSON 语法错误时该文件整份不生效并报错提示。

## 协议

脚本与引擎之间只隔一份固定协议（与 Claude Code hook 脚本同构）：

**输入** — 事件载荷 JSON 从 stdin 进，常用上下文经环境变量：`PI_HOOK_EVENT`、`PI_HOOK_STATE_DIR`（该 hook 的私有状态目录）、`PI_HOOK_LIB`（工具库路径）、`PI_HOOK_INPUT_FILE`（载荷备份文件）、`PI_CWD`、`PI_SESSION_ID`、`PI_SESSION_FILE`。

**退出码** — `exit 0` 放行；`exit 2` 阻断/取消（stderr 作为理由）；其他非零码与超时是非阻断错误，诊断可见。想要 fail-closed 的安全脚本自己写 `set -e` + `trap 'exit 2' ERR`。

**stdout** — exit 0 且 stdout 非空时必须是 JSON 对象，v1 认两个键：`content`（正文）与 `to`（落点覆盖）。脚本侧永远不手写 JSON，用工具库的 `hook_out` 包装：

```bash
source "$PI_HOOK_LIB/lib.sh"
echo "已对话 10 轮" | hook_out            # {"content":"..."}，走默认落点
cat ./USER.md | hook_out message          # {"to":"message","content":"..."}
```

## match 目标串

工具事件拼成 `工具名(主参数)`，如 `bash(git push origin main)`、`edit(src/a.ts)`；`input` 用输入文本、`user_bash` 用命令本身。推荐锚定写法：`^bash\(`、`^bash\(git push`、`^(edit|write)\(.*\.test\.ts\)`。

## 事件语义速查

| on | content 默认落点 | to 可覆盖为 | exit 2 |
| --- | --- | --- | --- |
| tool_call | 忽略 | — | 阻断工具，stderr 为理由 |
| input | 改写输入文本 | message（临时注入） | 吞掉该输入 |
| context | 追加临时消息（不落盘） | — | 记诊断 |
| before_agent_start | 追加到系统提示词末尾 | message（持久消息，UI 隐藏） | 记诊断 |
| session_before_compact | 忽略 | — | 取消压缩 |
| 其余 30 个通知事件 | 忽略（仅执行） | — | 记诊断 |

## 有状态 hook

`lib.sh` 提供三个函数，状态存于引擎分配的 `PI_HOOK_STATE_DIR`：

```bash
source "$PI_HOOK_LIB/lib.sh"
hook_every 10 || exit 0        # 每 10 次返回真，计数在 $HOOK_ROUND
hook_once || exit 0            # 本会话首次返回真
cat f | hook_out message       # 任意文本 → 协议 JSON
```

`examples/` 目录有五个完整示例：拦截 rm -rf、动态上下文注入、USER.md 持久注入、每 10 轮提醒、会话首问 systemPrompt 追加。

## 命令

`/hooks status` 查看当前生效条目与配置问题；`/hooks reload` 手动重载。

## 已知限制

- 通用通知事件（29 个）在启动时注册，热重载新增此类事件条目需 `/reload` 或重启后生效（六个专用事件不受此限）。
- `hook_every` / `hook_once` 的状态是状态目录里的文件，不随会话 fork/分支恢复（分支正确的计数是 v2 计划）。
- 无信任门：打开任何含 `.pi/hooks.json` 的仓库即执行其中命令，威胁模型默认外包给虚拟机/容器运行环境，裸机使用请自行评估（决策记录见 `doc/design.md`）。
- Windows 未支持（bash + 进程组语义）。
