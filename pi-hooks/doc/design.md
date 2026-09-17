# pi-hooks 设计

本文只讲抽象层面的设计思路：为什么这样设计、协议是什么、语义如何约定。实现层面的模块划分与代码结构见 `development.md`，调研依据见 `research.md`。

## 设计哲学

hooks.json 只做注册表，一切都是 bash。配置文件复杂度降到物理下限（每条 hook 五个字段），代价是约定一份引擎与脚本之间的协议：事件 JSON 从 stdin 进，决策从退出码和 stdout 出。这份协议才是真正的产品——它与 Claude Code 的 hook 脚本协议同构（stdin 收 JSON、exit 2 阻断），CC 生态的拦截类脚本可以直接复用；输出侧不抄 CC 的纯文本宽容，统一要求 JSON，写 JSON 的成本由插件自带的 `hook_out` 抹平。

设计过程中砍掉过五版复杂方案：动作映射表、if 表达式、inject 字段、模板引擎、配置侧计数器、信任门。每次简化的判断标准一致——把决策逻辑留在用户脚本里，引擎只做翻译。

## 引擎形态

引擎是一个普通 pi 扩展。加载时读取 JSON 配置并校验，为配置涉及的每个事件注册一个分发 handler；事件触发时，按配置顺序串行执行通过 `match` 过滤的 hook 条目，把协议结果翻译成该事件的返回值结构。

同一事件多条 hook 的执行语义：串行、首个阻断性结果短路（与 pi runner 对 `tool_call` 的 first-block-wins 行为一致）、transform 链式传递、注入按序累加。引擎所有 handler 内置异常兜底——pi 的 `tool_call` 事件在 runner 内层没有异常隔离，扩展抛错会变成工具的"幻影拦截"，这层兜底是引擎的生存底线，不是可选项。

## 配置文件

配置分两层：`~/.pi/agent/hooks.json` 全局生效，项目根目录 `.pi/hooks.json` 仅在该项目生效，同事件下先全局后项目。配置文件保存后热重载；JSON 语法错误时该文件整份不生效并报错提示，单条校验失败只拒绝该条目——所有配置问题必须显式可见，不允许静默失效。

信任模型是无门控：两层配置都无条件加载执行。这是明确的设计决策而非遗漏：pi 推荐的用法是在虚拟机/容器里运行，那里 bash 工具本身就能执行任意命令，仓库里的 hooks.json 与 AGENTS.md 提示注入的攻击面同源，单独给 hooks 设防不改变整体风险。裸机使用者需要自行知晓：打开任何含 `.pi/hooks.json` 的仓库即意味着执行其中的命令。调研期间曾验证过复用 pi 信任门的可行性，发现 `isProjectTrusted()` 对不含 pi 认识资源的项目直接返回真（hooks.json 不在其清单内），复用需自建存储补齐真空——这也是放弃门控的技术背景，详见 `research.md`。

## hooks.json schema

每条 hook 五个字段：

```jsonc
{
  "hooks": [
    {
      "on": "tool_call",                // 事件名，必填
      "match": "^bash\\(git push",      // 可选，正则，对目标串搜索
      "run": "./hooks/check-push.sh",   // 必填，bash 字符串
      "timeout": 10,                    // 可选，秒，默认 30
      "enabled": true                   // 可选，默认 true
    }
  ]
}
```

加载期校验：`on` 必须是 36 个事件之一，`run` 非空字符串，`match` 合法正则，`timeout` 正数，`enabled` 布尔。除此之外不做任何动作合法性检查——动作语义全部在协议层，配置层没有"配错动作"这回事。

## match 语义

引擎为每次事件构造一个目标串，用 `match` 对其做一次非锚定正则搜索，搜到才执行脚本。目标串规则：工具事件拼成 `工具名(主参数)`，如 `bash(git push origin main)`、`edit(src/a.ts)`；非工具事件直接用主字段原文，如 `input` 事件用输入文本。主参数映射内置在引擎里（bash/powershell 取 command，read/edit/write/ls 取 path，grep/find 取 pattern），自定义工具不拼参数、目标串即工具名。

`match` 没有任何自定义语法，就是一个 JavaScript 正则。约定俗成的写法是锚定开头：`^bash\(` 匹配所有 bash 调用，`^(edit|write)\(.*\.test\.ts\)` 同时拦两种文件工具。

## Hook 协议

协议是脚本的唯一接口，固定、不可配置。

**输入**：事件载荷以 JSON 写入脚本 stdin，字段与 pi 事件类型一致。环境变量提供常用上下文：`PI_HOOK_EVENT`（事件名）、`PI_HOOK_STATE_DIR`（该 hook 的私有状态目录）、`PI_HOOK_LIB`（工具库路径）、`PI_HOOK_INPUT_FILE`（载荷备份文件）、`PI_CWD`、`PI_SESSION_ID`。脚本工作目录为当前项目目录。

**退出码**：exit 0 放行，stdout 非空则按事件语义消费；exit 2 阻断或取消（该事件支持的话），stderr 作为理由；其他非零码与超时是非阻断错误，记诊断。想要 fail-closed 的安全脚本自己写 `set -e` 加 `trap 'exit 2' ERR`，引擎不提供全局开关。

**stdout**：exit 0 且 stdout 非空时，内容必须是一个 JSON 对象。这是与 Claude Code 的唯一有意分叉——CC 对 stdout 做"花括号形状猜测"，我们因为发布了 `hook_out` 工具有资格要求严格：解析只有一条路径，没有形状启发式，也不存在"想注入字面 JSON 文本却被误当决策"的边角案例。JSON 对象认两个键：`content`（正文）与 `to`（落点覆盖）。脚本侧永远不手写 JSON，`hook_out` 从管道读入任意文本，用 node 完成转义并打印合法 JSON。

## 事件语义表

| on | content 默认落点 | to 可覆盖为 | exit 2 |
| --- | --- | --- | --- |
| tool_call | 忽略 | — | 阻断工具，stderr 为理由 |
| input | 改写输入文本 | message（临时注入） | 吞掉该输入 |
| context | 追加临时消息 | — | 记诊断 |
| before_agent_start | 追加到系统提示词末尾 | message（持久消息，UI 隐藏） | 记诊断 |
| session_before_compact | 忽略 | — | 取消压缩 |
| 其余 30 个通知事件 | 忽略（仅执行） | — | 记诊断 |

最后一行是通用规则：任何没有专用语义的事件都以"仅执行"模式工作——脚本照常跑（旁路审计、上报等场景），stdout 和 exit 2 不产生行为。引擎因此天然支持全部 36 个事件，专用适配器只负责前五行。

注入分两种持久性：`before_agent_start` 的 message 是持久注入（作为 custom message 落盘进会话文件，每次触发累积一条），适合配合 `hook_once` 做一次性上下文；`context` 与 `input` 的 message 是临时注入（随下一次 LLM 调用生效，不落盘），适合周期提醒与 RAG 式动态上下文。排队输入场景（用户趁 agent 回答中追加输入）不触发 `before_agent_start`，此窗口内的注入必须走 `input` 事件。

## 有状态 hook

计数、once 这类状态需求不下放配置。引擎只为每条 hook 准备一个私有状态目录，路径经 `PI_HOOK_STATE_DIR` 传给脚本；条目指纹由内容 hash 得出，调整条目顺序不影响，改动条目内容则状态归零。引擎自带 `lib.sh` 提供三个函数：`hook_out`（文本包装为协议 JSON）、`hook_every N`（每 N 次返回真，计数在 `$HOOK_ROUND`）、`hook_once`（首次返回真）。状态是目录里的文件，不随会话 fork 恢复——对提醒类场景无感，分支正确的计数是后续计划。

## 失败与降级

脚本非零退出码、超时、崩溃、stdout 非法 JSON：一律不阻断，记入诊断，用户可感知。配置解析失败：该文件整份不生效。引擎自身异常：handler 顶层兜底，不阻断会话。子进程生命周期由引擎全权负责：Linux 里父进程退出不级联终止子进程，引擎在会话关闭时统一收割在途脚本；timeout 防的是 pi 运行期间 hook 卡死冻结当前回合。

## 范围

v1 覆盖四类主要场景：安全拦截（tool_call + exit 2）、周期提醒（input/context + hook_every）、持久或临时上下文注入（before_agent_start/context + stdout）、压缩守卫（session_before_compact + exit 2）。后续按真实需求追加：tool_result 的正文改写、user_bash、其余 session_before_* 的取消适配。明确不做：CC 的 http/mcp_tool/prompt/agent 四种 handler，`before_provider_request` 的 payload 改写暴露给配置（能力过强，误配即搞坏 API 调用，留给代码扩展）。
