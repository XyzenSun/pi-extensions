# pi-hooks 开发参考

面向在本仓库上继续开发的场景：模块职责、协议数据流、测试方式、常见扩展点。设计思路见 `design.md`，本文只讲代码。

## 模块结构

```
pi-hooks/
├── index.ts           # 入口：装配配置、注册事件与 /hooks 命令
├── src/
│   ├── config.ts      # 配置加载、校验、热重载
│   ├── matcher.ts     # match 目标串构造与正则测试
│   ├── runner.ts      # 执行层：spawn、stdin、env、timeout、进程收割
│   ├── protocol.ts    # 退出码与 stdout 的统一决策翻译
│   └── adapters.ts    # 事件适配器：决策 → pi 事件返回值
├── lib/lib.sh         # 用户脚本工具库（hook_out / hook_every / hook_once）
├── examples/          # 五个模板脚本，协议的事实标准
├── test/              # 冒烟测试（tsx 直跑，无测试框架依赖）
└── doc/               # design.md（设计）、research.md（调研）、development.md（本文）
```

依赖方向是单向的：`index.ts → adapters.ts → { matcher, runner, protocol } → config.ts`。`lib/` 与 `examples/` 是 bash，不参与 TS 编译，但随包发布（见 package.json 的 `files`）。

## 各模块职责

**config.ts** 拥有 36 个事件名的白名单常量 `PI_EVENTS`（与 pi 版本对齐的唯一事实来源，pi 升级新增事件时改这里）。`parseFileContent` 是纯函数，输入文本输出 `{hooks, problems}`，文件级错误（JSON 语法）整份不生效转为 problem。条目指纹 `hook.id` 由规范化字段 stableStringify 得出，用于状态目录分配——改动条目内容即状态归零，调整顺序不受影响。`watchConfigs` 用 `fs.watch` 加 300ms 防抖，watch 目标文件不存在时静默跳过（session_start 重读兜底）。

**matcher.ts** 的 `buildTarget` 是事件到目标串的映射：工具事件拼 `工具名(主参数)`，主参数字段查 `TOOL_PRIMARY_FIELD` 表；非工具事件取主字段。给新事件加 match 支持就是在这个 switch 里加一个 case。`matches` 的语义：无 match 放行；有 match 但目标串 undefined（事件无主字段）则跳过。

**runner.ts** 的 `runHook` 是唯一的进程执行路径。要点：`spawn("bash", ["-c", run])` 加 `detached` 让子进程自成进程组，timeout 与收割时杀负 pid 即杀全组；`PI_HOOK_INPUT_FILE` 是 stdin 的备份通道（载荷同时写临时文件，执行后删除）；`activeChildren` 登记在途进程，`reapAllChildren` 供 session_shutdown 调用。所有异常路径都转为 `ExecOutcome` 返回，绝不抛出——这是适配器 try/catch 之外的第二道防线。

**protocol.ts** 的 `interpret` 把 `ExecOutcome` 翻译成四种 `Decision`：none（exit 0 空 stdout）、output（合法 JSON 对象）、block（exit 2）、error（其他）。`parseStdout` 只接受 JSON 对象，数组与 null 都算非法。

**adapters.ts** 的 `dispatch` 是所有事件共用的执行入口：过滤（事件名 + enabled）→ match → 逐条执行 → 汇总。汇总规则：首个 block 短路返回；output 累积（后一条覆盖前一条的 content/to，transform 语义）；error 记诊断继续。六个专用适配器把 Decision 翻译成各自事件的返回值，每个都套 try/catch——`tool_call` 在 pi runner 内层没有异常隔离，适配器抛错会变成工具的幻影拦截。`adapterContext` 同时消费 `pendingInjections` 队列（input 事件 `to: "message"` 的落点由下一次 context 事件注入）。

**index.ts** 装配一切：初始加载配置、注册六个专用适配器 + 24 个通知事件（循环注册需对 `pi.on` 做受控类型断言，事件名来自白名单常量，运行时安全）、挂热重载、注册 `/hooks` 命令。`latestCtx` 缓存最近一次事件回调的 ctx，供无 ctx 场景（初始加载）的诊断通知使用。

## 协议数据流

一次 `tool_call` 事件的完整路径：

```
pi runner emitToolCall
  → index.ts 注册的 handler（更新 latestCtx）
  → adapterToolCall → dispatch
      → buildTarget: {toolName:"bash", input:{command:"git push"}} → "bash(git push)"
      → matches: /^bash\(git push/ 命中
      → runHook: spawn bash -c <run>
          stdin  ← 事件 JSON
          env    ← PI_HOOK_EVENT / PI_HOOK_STATE_DIR / PI_HOOK_LIB / ...
      → interpret: {code:2, stderr:"危险"} → {kind:"block", reason:"危险"}
  → 返回 {block: true, reason: "危险"}
  → pi agent-loop: 工具不执行，模型收到 error tool result
```

注入类路径多一步翻译：`{kind:"output", output:{content, to}}` 按事件语义表落点——`before_agent_start` 默认返回 `{systemPrompt: 原值 + content}`，`to:"message"` 时返回 `{message: {customType:"pi-hooks:inject", content, display:false}}`（持久）；`context` 把 content 包成 ephemeral custom message 追加进 messages（临时，不落盘）。

## 已知的 pi 行为陷阱

调试时踩过的坑，源码级结论：

`before_agent_start` 的 systemPrompt 修改在最终 provider 请求里确实生效（可用 `before_provider_request` 检查 payload 验证），模型不遵循注入指令是模型行为，不是链路断了——不要看到模型没听话就怀疑注入失败。

排队输入（`streamingBehavior` 为 steer/followUp）不触发 `before_agent_start`，此窗口的注入要走 `input` 事件。

扩展经 `sendUserMessage` 发的消息会触发 `input` 事件（`source: "extension"`），适配器必须过滤，否则引擎自激。

`tool_call` 适配器抛错会被 agent-loop 转成 error tool result——工具不执行、模型看到错误、turn 继续。表现为"幻影拦截"，排查困难，所以适配器的 try/catch 是生存底线。

## 测试

两个冒烟测试用 tsx 直跑，无框架依赖：

```bash
cd pi-hooks
npx tsx test/config-matcher-protocol.test.ts   # 25 项：校验/目标串/协议解析
npx tsx test/runner.test.ts                    # 18 项：spawn/stdin/env/timeout/状态
npx tsc --noEmit                               # 类型检查
```

端到端验证用真实 pi：

```bash
mkdir -p /tmp/e2e/.pi && cd /tmp/e2e
# 写 .pi/hooks.json（拦截类条目）
pi -p -e /path/to/pi-hooks/index.ts "请执行 rm -rf /tmp/x 并告诉我结果"
```

`-p` 模式下模型对注入指令的遵循度不稳定，验证注入链路是否通要用 `before_provider_request` 检查最终 payload，不要依赖模型行为。

## 常见扩展点

新增事件适配器：在 `adapters.ts` 加 `adapterXxx`（套 try/catch，翻译 Decision 为该事件返回值），在 `index.ts` 注册。通知类事件不需要适配器——通用 `adapterNotify` 已覆盖，只需确认 `matcher.ts` 的 `buildTarget` 是否需要为新事件加目标串。

新增协议键：在 `protocol.ts` 的 `HookOutput` 加字段，在 `interpret` 或适配器里消费。未知键已按"警告并忽略"处理，向后兼容。

pi 升级：对照新版 `types.d.ts` 更新 `config.ts` 的 `PI_EVENTS`，跑类型检查与冒烟测试，`doc/research.md` 的事件数与能力分级同步修订。

新增模板脚本：放 `examples/`，保持自包含（开头 source lib.sh），它是协议的事实标准，写法即文档。
