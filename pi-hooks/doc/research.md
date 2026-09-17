# pi-hooks 调研摘要

本文是调研结论的精简存档。设计决策的完整推理见 `design.md`；开发参考见 `development.md`。

## 证据来源

pi 侧结论来自 pi 0.85.1 源码实读（`dist/core/extensions/types.d.ts`、`runner.js`、`agent-session.js`、`exec.js`、`pi-agent-core/dist/agent-loop.js`），行为级结论与官方文档快照（本仓库 `docs/`）交叉验证。Claude Code 侧来自官方文档 `code.claude.com/docs/en/hooks.md` 与 `permissions.md` 的实时抓取。

## pi 事件系统

pi 0.85.1 共 36 个事件（0.84.1 为 33 个，0.84.3 新增 `session_compact_failed`，0.84.4 新增 `ui_prompt_start/end`）。按干预能力分三档：

可拦截或可注入的 13 个（有返回值语义）：`input`、`context`、`before_agent_start`、`tool_call`、`tool_result`、`message_end`、`session_before_switch`、`session_before_fork`、`session_before_tree`、`session_before_compact`、`project_trust`、`resources_discover`、`user_bash`。纯通知 22 个。特殊 1 个：`before_provider_request`（返回值整体替换请求 payload）。

多 handler 合并策略逐事件写死在 runner 里，没有统一抽象。与引擎相关的关键行为：`tool_call` 首个 block 短路且无内层异常隔离（抛错会被 agent-loop 转成 error tool result，表现为工具被"幻影拦截"）；`input` transform 链式、handled 短路；`context` 全量替换链（深拷贝起步，不落盘）；`before_agent_start` 的 message 累加落盘（持久注入）、systemPrompt 链式（当轮生效）。

其他源码事实：`pi.exec` 关闭 stdin 且 `shell: false`，无法承载 stdin 协议，引擎执行层必须自实现 spawn；扩展经 `sendUserMessage` 产生的输入带 `source: "extension"`，可据此过滤防自激；`pi.appendEntry` 写入的 custom entry 不进 LLM 上下文。

## Claude Code hooks 对照

CC 的 hooks 是纯配置驱动（三层 settings 文件 + matcher + 五种 handler 类型：command/http/mcp_tool/prompt/agent）。决策语义：exit 0 无输出即无决策（沉默不等于批准）、exit 2 阻断、stdout 按"花括号形状猜测"解析 JSON。`once` 仅对 skill frontmatter 声明者生效；`if` 字段恰好一条权限规则，无 `&&`/`||`；匹配的 hook 并行执行。

CC 共 33 个事件，其中 16 个支持 exit 2 阻断。与 pi 的映射：PreToolUse↔tool_call、PostToolUse↔tool_result、UserPromptSubmit↔input、PreCompact↔session_before_compact、SessionStart/End↔session_start/shutdown 均对等；CC 的 Stop 能阻止结束（pi 不能），CC 的协作类事件（子 agent、任务、worktree、文件监听）pi 无对应。pi 独有：`context`（每次 LLM 调用前动态改写消息数组，天然 RAG 注入口）、`before_provider_request/headers`、`user_bash`。

CC 的 workspace trust 按会话类型分叉：交互模式下接受信任对话框之前扣留所有 settings 文件的 hooks（包括用户全局配置）；headless（`-p`/SDK）模式从不弹窗、一律视为已信任，仓库提交的 hooks 直接运行，官方缓解只有文档警告加 `--bare`、`disableAllHooks`、`--setting-sources user` 三个逃生舱。pi 的非交互模式默认 fail-closed（无已存信任决定时视为不信任）。

## 信任门调研结论

初版设计要求项目级配置过信任门（复用 `ctx.isProjectTrusted()`），源码核实发现障碍：pi 的信任判定对不含其认识资源的项目直接返回已信任，而需信任资源清单（`.pi/` 下的 settings.json、extensions、skills、prompts、themes、SYSTEM.md、APPEND_SYSTEM.md）不含 hooks.json——只含 hooks.json 的项目会获得无需询问的"真空信任"，且该场景下 `project_trust` 事件根本不会发给扩展。复用 pi 信任门必须自建存储补齐真空。最终决策：移除信任门，威胁模型外包给运行环境（虚拟机/容器运行 pi），理由是项目 hooks 与 AGENTS.md 提示注入的攻击面同源，单独设防不改变整体风险。决策全文见 `design.md`。

## 可行性结论

配置驱动 hook 引擎在 pi 上完全可行：事件订阅与干预靠 `pi.on` 返回值，执行外部命令靠自实现 spawn，配置读取与热重载靠 `node:fs`，状态持久化靠私有状态目录。安全模型经三轮迭代（复用 pi 信任门 → 自建存储 → 无门控）收敛为最终方案。
