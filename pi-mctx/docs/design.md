# pi-mctx 设计文档

> 状态: 设计定稿 (融合版), 等待批准实施。实施前的任何代码改动均需用户批准。
> 插件目录暂名 `pi-manual-context`, 实施第一步将改名为 `pi-mctx`。
> 本文档融合了两份设计: 原 pi-mctx (蒸馏重置) 与原 pi-obs-sink (工具结果下沉)。

## 1. 定位

pi-mctx 是一个**纯手动**的上下文管理工具集, 提供两个互补操作:

| 子命令 | 粒度 | 损耗 | 会话 | 场景 |
|--------|------|------|------|------|
| `/mctx sink` | 细粒度 (单条工具结果) | 无损 (obs 可整条读回) | 不换会话 | 大块工具输出确定用完了, 移出发给模型的请求, 继续当前任务 |
| `/mctx new` | 粗粒度 (整个会话) | 蒸馏 (生成 kickoff prompt) | 换新会话 | 任务阶段切换, 蒸馏精华后全新开始 |

共同原则:

- **纯手动**: 不自动触发, 不后台运行, 不按阈值/次数/时间做任何自动决定
- **不改历史**: sink 永不修改 session 文件; new 旧会话文件保留 (parentSession 关联, `/resume` 可回溯)
- **零污染**: 取消或失败时对当前上下文零影响

## 2. 命令总览

```
/mctx                       提示用法 (列出 new / sink 说明, 不执行任何操作)
/mctx new [可选补充指示]     蒸馏重置: 总结会话 -> 清空上下文 -> 新会话草稿预填
/mctx sink                  沉掉当前上下文里所有合格的工具结果
/mctx sink --keep N         保留最近 N 条合格结果, 其余下沉
/mctx sink --undo           撤销本会话所有下沉 (删文件 + 清集合)
```

- `new` 的补充指示用于引导总结侧重点, 如 `/mctx new 重点保留数据库设计决策`
- `sink` 的 `--keep N` 支持 `--keep N` 与 `--keep=N` 两种形式 (实现细节)

## 3. 子系统一: sink (工具结果下沉)

### 3.1 核心原理

**为什么必须手动**: 自动化方案的困难不在"下沉", 在"判断哪一个可以不要了"。任何固定规则 (发送次数、大小、年龄) 都会误判: 判断过早 → 之后还要用, 被迫回读, 白折腾; 判断过晚 → 已经没必要省了。只有人知道"这条我确定用完了", 所以触发权交给人。

**缓存为什么必然受损, 以及"择时"**: Provider 的前缀缓存按最长公共前缀匹配, 这轮请求从第一个不一致的位置起后面全部重算重写。把历史中间的一条消息从"全文"改成"占位符" = 在该位置制造一个不一致点。推论:

- 一次下沉操作 = 一次前缀断裂, 与下沉几条无关
- 批量下沉 N 条只断 1 次 (断裂点由最早的那条决定), 分 N 次下沉 = N 次断裂 → 设计上鼓励"一次沉完" (`--keep` 之后"其余全沉"而非"挑几条沉")
- 断点之后未被沉的结果最亏: 重写的钱照付, token 一个没省
- 在缓存已失效的时刻下沉边际成本 ≈ 0, 计为"择时"但不写代码: 空闲超过 provider 缓存 TTL (常见 5 分钟)、刚发生 compaction、刚切换模型, 这些时刻用户自己知道

**为什么状态可以是"文件存在性"**: 因为从不修改 session, 磁盘上的历史永远是全文, context 钩子改的只是"发给模型的副本"。下沉写下的文件是纯优化缓存: 文件全丢 → 下沉自动撤销 → 全文原样回到上下文, 零数据损失。带来三个好处: 不需要索引/账本做持久化 (文件就是状态); 放 tmpdir 由操作系统回收; 重启后文件消失 = 自动回到干净状态, 无需清理代码。

**请求路径零开销**: sink 集合为空时 context 钩子直接返回, 无任何成本。唯一常驻成本: obs 工具 schema 始终出现在系统提示 (一个 id 参数, 极小); 动态注册/注销工具会反复修改系统提示、反而打断缓存, 得不偿失。

### 3.2 架构与数据流

四个部件, 一个存储:

| 部件 | 职责 |
|------|------|
| `/mctx sink` 命令 | 人手动触发; 筛合格结果 → 写文件 → 登记集合 |
| context 钩子 | 每次请求前, 把"已登记"的结果内容换成占位符 |
| obs 工具 | 按 id 把原文整条读回 |
| 存储 | 一个目录, 一条结果一个文件 |

```
创建   工具执行完成 → 全文正常进入上下文 (本扩展不介入)
        │
下沉   用户敲 /mctx sink → 筛合格结果 → 写 <tmpdir>/pi-mctx/<sessionId>/<id>.txt
        │                              → 内存集合 Set.add(id)
        ▼
投影   每次请求前 context 钩子:
       集合为空 → 直接返回 (零开销)
       否则     → id 命中集合的结果, content 换成占位符
        ▼
回读   模型调用 obs({ id }) → 读文件 → 作为一条【新】工具结果追加在末尾
```

### 3.3 存储设计

```
<os.tmpdir()>/pi-mctx/<sessionId>/
    <toolCallId>.txt      # 一条已沉结果 = 一个文件
```

- 目录权限 0700, 文件权限 0600
- 使用 `os.tmpdir()` (尊重 TMPDIR 环境变量), 不硬编码 /tmp
- 按 sessionId 分子目录: 多会话隔离, 且可整体回收
- 不落在工作目录: 避免污染项目、避免被 AI 的 read/grep 误当作有效资料

**文件即状态**: 文件存在 == 该条已下沉。没有索引、没有 meta、没有账本。内存中的 `Set<toolCallId>` 只是文件名的镜像: `session_start` → readdir 重建 Set, 目录不存在 (ENOENT) → 空 Set。Set 不需要持久化, 它本来就是可随时从目录重建的派生数据。

**写入**: `writeFile(path, text, { flag: "wx", mode: 0o600 })`, wx 保证不覆盖已存在文件; EEXIST → 视为"已沉"幂等跳过 (支持多次 /mctx sink); 其它错误 → 记录并跳过该条, 不影响其余。

**撤销**: `/mctx sink --undo` → 删除本会话目录下所有文件 + 清空 Set, 等价于"下沉全部撤销"。

**生命周期**:

| 事件 | 行为 |
|------|------|
| resume 会话 (同 sessionId) | 文件仍在 → readdir 重建 Set → 占位符自动恢复 |
| fork 会话 (新 sessionId) | 新目录为空 → 全显示全文 (正确: 新会话需重新决定) |
| 原生 compaction | session 未改、文件未动 → 下游仍可回读; 被压掉的旧消息不再投影 |
| 进程/机器重启 | tmpdir 可能被清 → 自动回到"未下沉", 无清理代码 |
| tmpdir 被外部清理 | 同上; obs 读不到时报"未知 id", 不损坏任何东西 |

### 3.4 id 设计

**采用 toolCallId 直接作为 id**: `id = message.toolCallId`, 文件名 = `<id>.txt`。

| 性质 | 说明 |
|------|------|
| 逐条唯一 | 一条消息一个 id; 同内容的两条不会串 |
| 跨 resume 稳定 | session 里存的就是它, 重启不变 |
| 不依赖内容 | 内容变不变都无所谓, 正是"一消息一决定"想要的 |
| 零计算 | 直接在消息字段里, 不做哈希 |
| 文件名安全 | 实测 (2521 条真实样本) 全部为 call_..., 无 /、.、空格 |

对照: 内容哈希需要每轮对每条结果重算, 且把 id 和内容绑定 — 若内容因任何原因变化, id 就变, 占位符随之变, 缓存被打断。我们不需要这种绑定。

**安全校验**: 写/读文件名前用白名单校验 `SAFE_ID = /^[A-Za-z0-9_-]+$/`, 不通过则跳过并告警 (极少见的非规范 provider)。

### 3.5 命令规格

**执行流程**:

1. `ctx.waitForIdle()` 等待 agent 空闲 (保证 buildContextEntries 快照一致)
2. 取 `ctx.sessionManager.buildContextEntries()` (compaction-aware: 只拿当前还在上下文里的消息, 已被压缩掉的不再处理)
3. 逐条按 §3.6 判定"合格", 得到候选列表 (保持原始顺序)
4. `--keep N`: 从候选列表尾部保留 N 条, 其余为下沉目标
5. 对每个目标: 写文件 → Set.add(id) (已存在则幂等跳过)
6. `ctx.ui.notify` 报告: 下沉条数 / 合格条数 / 保留条数

**幂等性**: 重复 `/mctx sink` 只处理"尚未下沉"的合格结果 (第二次起只沉新产生的), 不会重复写、不会损坏已有文件。

### 3.6 合格判定

一条工具结果同时满足以下条件才合格:

```
message.role === "toolResult"
且 message.content 全为 text 块 (纯文本结果)
且 Buffer.byteLength(text) >= minBytes (默认 2048)
且 message.toolName !== "obs"        # 防止"读回来的内容又被沉"的套娃
```

不判断 isError: 失败的命令输出 (构建失败、测试失败) 通常正是最大、最需要移出的内容, 且 obs 可无损读回, 因此允许下沉失败结果。其余类型的工具结果一律不动。

### 3.7 context 钩子规格

```js
pi.on("context", (event, ctx) => {
  const set = 已沉集合;
  if (set.size === 0) return;                    // 快路径: 零开销
  return { messages: event.messages.map(m => {
    if (!isPureTextResult(m)) return m;
    if (!set.has(m.toolCallId)) return m;
    return { ...m, content: [{ type: "text", text: 占位符(m.toolCallId) }] };
  })};
});
```

硬性约束:

- 只改 content。role、toolCallId、toolName、isError、timestamp、details 等一律原样保留 → tool_use / tool_result 配对永不破
- 不改变消息数量与顺序
- 不写回 session ("文件即状态"成立的前提)
- 占位符必须逐字节稳定: 同一 id 每轮生成完全相同的内容, 禁止时间戳、计数器、"已沉 N 条"、字节数等任何会变的值

性能: 集合为空立即返回; 集合非空每条消息一次 Set.has (O(1)), 无哈希、无 I/O、无 stat, 不得引入任何每轮重算的成本。

### 3.8 obs 工具规格

**接口**: `obs({ id: "call_00_pXKFB50ElfWZZOyfAcDO6184" })`, id 必填, 来自占位符。返回该条结果的完整原文, 作为一条普通工具结果。

**行为**: 读 `<tmpdir>/pi-mctx/<sessionId>/<id>.txt`, 一次返回整条; ENOENT → 报错"未知 id (可能从未下沉, 或已被撤销)"; id 非法 (不匹配 SAFE_ID) → 报错; 只读语义, 不修改任何状态。

**为什么不分页**: 下沉对象的大小 = 它当初在上下文里的大小 (它曾完整装下过, 否则到不了下沉这一步), 回读一条最多把这条的大小恢复回来, 不会超出下沉前的峰值。分页的代价是真实的: 一条 30KB 读 2 次、500KB 读几十次, 每次都是一个工具调用 + 一轮往返, 还会让模型去处理它不会计算的 next_offset。用分页防一个不会发生的问题, 代价是每次都多花调用。默认 (且唯一) 行为是整条返回。

**结果不参与下沉**: obs 自身的结果被 §3.6 排除在合格集之外, 避免递归。

### 3.9 占位符文案 (定稿)

```
[系统操作提示] 此结果已移出上下文。需要时调用tool： obs({ id: "{id}" }) 取回。
```

| 元素 | 作用 |
|------|------|
| [系统操作提示] | 明确这是系统行为, 不是工具报错 |
| 此结果已移出上下文 | 交代事实, 消除"数据丢了?"的误判 |
| 需要时调用tool： obs({ id: "..." }) 取回 | 给出确切、可照抄的调用方式 |

约束: 整行只由 id 决定 (逐字节稳定), 不带字节数、行数、工具名、时间戳。不使用"经上下文压缩"之类措辞: 本扩展没有压缩语义 (compaction 是另一回事), 错误的措辞会误导模型。

## 4. 子系统二: new (蒸馏重置)

### 4.1 技术管线

```
/mctx new [补充指示]
  │
  ├─ 前置检查: 仅 TUI 模式 / 已选模型 / 分支非空 / waitForIdle 等待空闲
  │
  ├─ ① 收集: getBranch() → 处理 compaction entry
  │     (旧格式 firstKeptEntryId / 新格式 retainedTail 两种都要兼容)
  │     输入 = 历史摘要 + 保留消息 + 之后的全部消息
  │     注意: 输入为 session 原文, 不应用 sink 投影 (见 §5.1)
  │
  ├─ ② 序列化: convertToLlm + serializeConversation
  │     (tool result 自动截 2000 字符, 含 thinking, 图片天然跳过)
  │
  ├─ ③ 文件清单: 遍历 toolCall 块
  │     read/grep/find/ls → 读集, edit/write → 改集
  │     累积合并历史 compaction 的 details, 去重, 转 cwd 相对路径
  │
  ├─ ④ 单次 LLM 调用 (当前会话模型, modelRegistry.complete)
  │     system: 四段模板生成指令
  │     user: <conversation>序列化文本</conversation>
  │          + <touched-files>事实清单(标注已修改/仅读过)</touched-files>
  │          + 可选补充指示
  │     BorderedLoader + Esc 可中止; 新 sessionId, 不写缓存
  │     ├─ 失败/溢出 → 明确报错并结束, 当前上下文零影响
  │     │   (不重试 / 不预检 / 不降级)
  │     └─ 成功 ↓
  │
  ├─ ⑤ newSession(parentSession = 旧会话文件)
  │     withSession: 编辑器草稿预填生成的 prompt
  │     用户在新会话里审查、编辑, 回车提交才进入上下文
  │
  └─ ⑥ notify: 压缩前 token 数 + 本次总结调用的 usage/费用
```

### 4.2 前置检查

- 仅 TUI 模式; rpc/json/print 模式报错退出
- 已选模型 (`ctx.model` 存在)
- 分支非空 (无可总结内容时提示退出)
- `ctx.waitForIdle()` 等待 agent 空闲

### 4.3 输入收集

- 数据源: `ctx.sessionManager.getBranch()`
- compaction 兼容: 分支中若存在 compaction entry, 旧消息已被摘要替代, 不重复总结
  - 旧格式: `firstKeptEntryId` 指向保留消息起点
  - 新格式: `retainedTail` 直接内嵌保留消息
- 最终输入 = 历史摘要 + 保留消息 + 之后的全部消息 (参考官方 handoff.ts 示例的收集模式, 补充 retainedTail 支持)

### 4.4 序列化

复用公开导出 `convertToLlm` + `serializeConversation`。特性: tool result 序列化时截断到 2000 字符 (输入天然小于原上下文); thinking 默认包含; 图片跳过。

### 4.5 文件清单提取 (自实现)

pi 内部有同款逻辑 (`extractFileOpsFromMessage` 等) 但未从包根导出, 不可依赖, 需自己复刻:

- 遍历 assistant 消息的 toolCall 块 (sink 不修改 toolCall, 故已下沉结果不影响提取)
- 与 pi 内部 FileOperations 三集合结构对齐: read → 读集, write/edit → 改集 (grep/find/ls 的 path 常为目录或可选, 不提取)
- 累积合并历史 compaction entry 的 `details` (readFiles/modifiedFiles)
- 去重, 转为 cwd 相对路径

### 4.6 LLM 调用

- 模型: 当前会话模型, `ctx.modelRegistry.complete()`
- 一次性独立调用: 新 sessionId + 不写 provider 缓存 (与 pi 自身 compaction 行为一致)
- UI: BorderedLoader, Esc 中止
- 失败/溢出: 明确报错结束, 不自动重试 (手动工具, 用户重跑即断路器)

### 4.7 会话切换

- `ctx.newSession({ parentSession: 旧会话文件 })`
- `withSession` 中用 replacement context 的 `ui.setEditorText(prompt)` 预填草稿
- notify 压缩前 token 数 (`ctx.getContextUsage()`) 与总结调用 usage/费用

### 4.8 生成模板

system prompt 要点:

- 角色: 上下文交接助手, 生成新会话的 kickoff prompt
- 四段结构:

```markdown
## 上下文精华
<关键决策及理由, 核心技术概念, 重要代码片段 (签名/关键算法, 非整文件)>

## 当前任务
<正在做什么, 进行到哪一步>

## 需要读取的文件
- <path> — <为什么需要读> (标注: 已修改 / 仅读过)

## 接下来做什么
<具体可执行的下一步>
```

- 约束:
  - "需要读取的文件"只能从 `<touched-files>` 事实清单中选择, 不得编造路径; 清单为空时省略该段
  - 精简, 目标 1500 字内 (仅指令约束, 不设 maxTokens)
  - 输出语言跟随会话主要语言
  - 只输出 prompt 本身, 无任何前言

## 5. 子系统交互定案

| # | 场景 | 定案 |
|---|------|------|
| 5.1 | `/mctx new` 总结输入 vs 已下沉结果 | **全文包含, 不应用 sink 投影**。理由: new 是清空前的最后一次总结, 一次性成本, 质量优先; sink 省的是每轮请求的持续成本, 两者目的不同。且 getBranch() 返回 session 原文, 天然满足, 零额外代码 |
| 5.2 | new 换会话后旧会话的 sink 文件 | 留在 `<tmpdir>/pi-mctx/<旧sessionId>/`, 新会话 sessionId 不同读不到。正确行为: 新会话需要的精华应在总结时蒸馏进 kickoff prompt, 不靠 obs 回读旧文件; tmpdir 自然回收 |
| 5.3 | new 的总结调用与 context 钩子 | 总结走 `modelRegistry.complete()`, 不经过主循环 context 钩子, 与 sink 投影无干扰 |
| 5.4 | sink 后再 new | 无顺序依赖, new 拿到的始终是 session 原文 |
| 5.5 | 新会话中的 obs 工具 | 仍注册 (插件全局加载), 但新会话 sink 目录为空, 调用报"未知 id"; kickoff prompt 不含占位符, 模型无理由调用 |
| 5.6 | sink 与原生 compaction | session 未改、文件未动; 被压掉的旧消息不再出现在 context, 钩子自然不处理; 下游仍可回读 |

## 6. 配置: pi-mctx.json (可选)

位置: `<getAgentDir()>/pi-mctx.json` (即 `~/.pi/agent/pi-mctx.json`)。注意: Pi 的 settings.json 中 packages 条目不支持把自定义字段传给扩展, 因此使用独立配置文件。

```json
{
  "sink": {
    "minBytes": 2048,
    "placeholder": "[系统操作提示] 此结果已移出上下文。需要时调用tool： obs({ id: \"{id}\" }) 取回。"
  }
}
```

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| sink.minBytes | number | 2048 | 合格结果的最小字节数 |
| sink.placeholder | string | 见 §3.9 | 占位符模板, 必须包含 {id}; 未包含则回退默认 |

new 子命令暂无配置项 (模板 v1 固定)。

容错: 文件不存在 → 全部默认值; JSON 解析失败 / 字段类型不符 → 逐项回退默认值并打印一次告警, 不抛出。读取时机: 扩展初始化一次。

## 7. 实现形态

```
pi-mctx/
  index.ts            # 入口: 注册命令/钩子/工具, 配置装配, 子命令分发
  src/
    debug.ts          # 调试日志 (输出到 <tmpdir>/pi-mctx/debug.log, 正式版关闭)
    config.ts         # pi-mctx.json 读取与容错
    sink-store.ts     # 存储管理: 目录/wx 幂等写入/undo/Set 重建/SAFE_ID 校验
    sink-command.ts   # /mctx sink 逻辑: 合格判定/--keep 筛选/报告
    sink-project.ts   # 投影: context 钩子的占位符替换
    obs-tool.ts       # obs 工具注册
    new-session.ts    # /mctx new 逻辑: 收集/序列化/LLM 调用/会话切换
    file-inventory.ts # new 的文件清单机械提取
  package.json
  tsconfig.json
  README.md
  docs/design.md      # 本文档
```

- 预计 ~650 行, 拆分模块 (两子系统相对独立, pi-sync 有 src/ 先例)
- 复用公开导出: `serializeConversation`, `convertToLlm`, `BorderedLoader`
- 不依赖 pi 内部未导出实现, 保证升级安全
- 依赖: `@earendil-works/pi-coding-agent` (peer), `typebox` (peer)

## 8. 边界情况与失败模式

### 8.1 通用

| 情况 | 表现/处理 |
|------|-----------|
| `/mctx` 无参数 | 提示用法, 不执行任何操作 |
| rpc / json / print 模式 | 报错"仅支持交互模式" |
| agent 运行中 | waitForIdle 等待 (new 与 sink 一致) |

### 8.2 sink

| 情况 | 表现/处理 |
|------|-----------|
| 从未 /mctx sink | 集合为空, context 钩子零开销 |
| 重复 /mctx sink | 幂等, 只处理新增合格结果 |
| --keep N 大于候选数 | 实际下沉 0 条, 正常提示 |
| 结果大小 < minBytes | 不参与下沉 |
| 结果含图片块 (非纯文本) | 不参与下沉 |
| obs 自身结果 | 不参与下沉 (防套娃) |
| toolCallId 含非法字符 | 跳过 + 告警 |
| 写文件 EEXIST | 视为已沉, 跳过 |
| 写文件其它错误 | 记录 + 跳过该条, 其余继续 |
| 读不存在 id | obs 报错, 不损坏状态 |
| tmpdir 被清理 | 重新 readdir 得空集 → 自动回滚为"未下沉" |
| fork | 新 sessionId → 空目录 → 全文显示 |
| compaction | session 未改; 旧消息不再出现在 context, 钩子自然不处理 |
| 同一次开机内 resume | readdir 恢复集合, 占位符回来 |

### 8.3 new

| 情况 | 表现/处理 |
|------|-----------|
| 空会话 / 无模型 | 提示后退出 |
| 总结调用失败或溢出 | 报错结束, 旧上下文原封不动 |
| Esc 中止 | 取消, 零影响 |
| 文件清单为空 | 模板允许省略该段 |
| 旧会话 | 文件保留, parentSession 关联, /resume 可回溯 |

## 9. 设计决策记录

| # | 决策点 | 结论 | 理由 |
|---|--------|------|------|
| D1 | 审核方式 | 无 yes/no 拦截, 新会话编辑器草稿审查 | 已注入上下文的消息不可编辑; 草稿形态审查编辑一体, 提交才生效 |
| D2 | 清空方式 | newSession + parentSession | 旧会话保留可回溯; compaction 是有损摘要, 不是清空 |
| D3 | 总结模型 | 当前会话模型 | 零配置, 开箱即用 |
| D4 | 生成路线 | 自有四段模板 + modelRegistry.complete | 产物是面向未来行动的 kickoff prompt, 不是 pi 的压缩摘要格式 |
| D5 | 超长策略 | 纯单次调用, 溢出直接报错 | 用户拍板; 序列化输入天然小于原上下文, 溢出罕见; 放弃预检/降级的复杂度 |
| D6 | 文件清单 | 机械提取 + LLM 选择 | pi 内部同款方案; 机械提取不遗漏不编造, LLM 负责筛选与标注 |
| D7 | 输出规模 | 仅指令约束 | 用户拍板, 不设 maxTokens |
| D8 | 命令形式 | /mctx new [可选补充指示] | 类似 /compact [instructions], 可引导总结侧重点 |
| D9 | 失败处理 | 不自动重试 | 手动工具, 用户重跑即断路器 |
| D10 | 命名 | 目录 pi-mctx, 包 @xyzensun/pi-mctx, 命令 /mctx | 用户指定 |
| D11 | 插件定位 | 手动上下文管理工具集 (new + sink) | obs-sink 设计融入为子命令; 两操作粒度互补 |
| D12 | /mctx 无参数 | 提示用法 | new 是换会话大动作, 不宜默认触发 |
| D13 | new 总结输入 vs 已下沉结果 | 全文包含, 不投影 | 清空前最后一次总结, 一次性成本质量优先; sink 省持续成本, 目的不同; 用户拍板 |
| D14 | obs 工具注册 | 始终注册 | schema 极小; 动态注册/注销反复改系统提示更亏 |
| D15 | 配置 | 统一 pi-mctx.json, sink 项在 "sink" 命名空间 | 一个插件一个配置文件 |
| D16 | sink 存储路径 | `<tmpdir>/pi-mctx/<sessionId>/` | 与插件命名空间一致 |
| D17 | 代码组织 | 拆分模块 (index + src/) | 两子系统 + 共享逻辑, ~650 行; pi-sync 先例 |
| D18 | sink 也 waitForIdle | 是 | 保证 buildContextEntries 快照一致 |
| D19 | sink 触发方式 | 手动 /mctx sink | 只有人知道"用完了"; 避免误判 (原 obs-sink 核心决策) |
| D20 | sink 下沉范围 | 全沉 (可选 --keep) | 断点后未沉的条目纯亏; 批量只断 1 次缓存 |
| D21 | sink id | toolCallId | 零计算、稳定、逐条唯一、文件名安全 |
| D22 | sink 状态载体 | 文件存在性 | 零索引; 丢文件 = 自动回滚 |
| D23 | sink isError 过滤 | 不过滤 | 失败日志常最大且需要下沉; 可无损读回 |
| D24 | obs 回读粒度 | 整条 | 分页徒增工具调用, 且下沉物本就在容量内 |
| D25 | 占位符内容 | id + 读取指引, 不带字节数/摘录 | 工具调用仍在上下文; 字节数是模型无法验证的噪声 |
| D26 | 占位符稳定性 | 逐字节稳定 | 同一 id 每轮生成完全相同内容, 保护缓存 |

## 10. 调研附录

### 10.1 pi 公开 API 可复用

- `serializeConversation` / `convertToLlm`: 消息序列化 (new 用)
- `BorderedLoader`: 加载动画组件 (含 abort signal, new 用)
- `ctx.newSession()` / `ctx.waitForIdle()` / `ctx.getContextUsage()` / `ctx.sessionManager.buildContextEntries()` / `getBranch()`
- `ctx.modelRegistry.complete()`: 一次性 LLM 调用
- `pi.on("context")`: 请求前消息投影 (sink 用)
- `pi.registerTool()` / `pi.registerCommand()`

### 10.2 pi 内部实现不可依赖 (需自写)

- `extractFileOpsFromMessage` / `createFileOps` / `computeFileLists` / `formatFileOperations`: 位于 `core/compaction/utils.ts`, 未从包根导出; 包 `exports` 字段只开放根入口, deep import 被阻止
- `prepareCompaction`: 未导出

### 10.3 Claude Code 压缩机制借鉴分析

前提: 本插件纯手动, Claude Code 是自动防御体系, 定位不同, 选择性借鉴。

借鉴 (改造后纳入):

| 机制 | 来源 | 采用点 |
|------|------|--------|
| 强制保留关键内容 | 压缩指令模板 | new 的"上下文精华"必须含关键决策及理由、技术概念、重要代码片段 |
| 断路器 | MAX_RETRIES 机制 | 失败即报错, 不自动重试 |
| 输出预留 | L1 层 | 指令约束 prompt 精简 (按 D7 不设 maxTokens 硬上限) |
| 可观测性 | 埋点体系 | new 完成后 notify 前后 token 对比 + 总结调用费用; sink 完成后报告条数 |
| 配对保证 | 工具调用配对 | sink 只改 content 不动配对字段; new 纯文本序列化天然规避 |

排除 (附理由):

- 自动触发阈值体系 (L1/L2): 插件纯手动, pi 已有 auto-compaction, 不重复建设
- SM Compact 会话记忆引擎: 后台常驻记忆是另一个产品面, 不进 v1
- 微压缩自动清理 (L3/L4): 自动判断"哪条不要了"必然误判; 本插件的 sink 是同一投影层思路的手动版
- 缓存优先 / Fork Agent 缓存继承: 序列化文本与主对话缓存前缀必然不同; 接受一次性输入成本
- 渐进式降级截断: 用户拍板 D5 采用纯单次调用

### 10.4 与 SoL-Pi (ObservationPack) 的对比 (sink 子系统)

| 维度 | SoL-Pi ObservationPack | pi-mctx sink |
|------|------------------------|--------------|
| 触发 | 自动 (按"该结果被发送的次数") | 手动 (/mctx sink) |
| id | obs_ + sha256(toolName\0toolCallId\0contentHash)[:24] | 直接用 toolCallId |
| 状态 | 无状态, 每轮靠位置现算 | Set<toolCallId>, 从目录重建 |
| 存储 | session 目录 (永久累积) | os.tmpdir() (自动回收) |
| 回读 | obs_recall, 分页 (16KB/400 行 + next_offset) | obs, 整条返回 |
| 改历史 | 否 (只在投影层改) | 否 (只在投影层改) |
| 择时 | 无 | 用户自然择时 (缓存已冷时操作) |

借鉴: 只在投影层改、不改 session; 内容寻址式的完整性意识; "文件在 = 可回读"的思路。

不借鉴: 自动触发 (误判 + 多次断缓存); 每轮现算 id (浪费); 存 session 目录 (永久累积); 分页回读 (浪费工具调用)。

### 10.5 未采纳的备选方案 (sink 子系统)

| 方案 | 为什么不做 |
|------|-----------|
| 按发送次数自动下沉 | 误判; 多次、分散地打断缓存 |
| 给 edit/write 加 then_run (Action Fusion 那套) | 只适用于"可预测的验证后缀", 场景极窄; 通用化到 bash 无意义 |
| 内置工具加 sink 参数 (创建时下沉) | 需重注册内置工具, 成本高; 本轮不纳入 |
| 内容哈希作 id | 每轮重算浪费; 内容变则 id 变, 破坏占位符稳定性 |
| 分页回读 | 徒增工具调用; 下沉物本就在容量内 |
| 存 session 目录 | 永久累积, 需自行清理 |
| 占位符带字节数/摘录 | 噪声; 带摘录还需读文件, 加重热路径 |
| 用 packages 传递配置 | Pi 不支持自定义字段透传 |
| LLM 摘要替代 (收据式) | 有损; 属于 compaction 域, 非本插件目标 |

## 11. 已知限制

- **缓存断裂不可避免**: 一次 /mctx sink 至少断一次前缀 (除非择时在缓存已冷时)。协议层限制, 无解
- **tmpdir 可能被外部清理**: 清理发生在会话进行中时, 被清条目的 obs 会报未知 id (若原文仍在 session, 可重新 /mctx sink 沉一次; 占位符是否恢复取决于集合重建)。概率低, 且不损坏数据
- **toolCallId 非规范时跳过**: 极少见
- **不使用内置工具参数**: 无法在"结果产生的那一瞬间"就下沉 (sink: true 路线未采纳), 因此无法做到"零缓存断裂的创建时下沉"
- **obs 工具 schema 常驻系统提示**: 极小但非零 (D14)

## 12. 测试要点

### 12.1 sink

- 未 /mctx sink 时: context 钩子返回 undefined, 不构造任何对象 (快路径)
- /mctx sink: 合格结果写入文件; 不合格 (小/非文本/obs 结果) 不写
- 投影: 命中集合的仅 content 被替换; toolCallId/toolName/isError/顺序不变
- 占位符稳定性: 连续两次投影, 同一 id 生成的字符串完全相等
- 回读: obs({id}) 返回与写入内容逐字节相同; 未知 id 报错
- 幂等: 连续两次 /mctx sink 不重复写、不报错
- --keep N: 保留最近 N 条, 其余下沉
- --undo: 文件被删、集合清空、投影恢复全文 (钩子回到快路径)
- 重启恢复: 模拟进程重启后 readdir 重建集合, 占位符仍生效
- tmpdir 清理: 删除目录后 readdir 得空集, 全文恢复

### 12.2 new

- 空会话: 提示退出, 不发起 LLM 调用
- 总结调用失败: 报错, 旧会话原封不动
- Esc 中止: 取消, 零影响
- compaction 兼容: 旧格式 (firstKeptEntryId) 与新格式 (retainedTail) 会话都能正确收集
- 文件清单: 从 toolCall 提取, 与历史 compaction details 累积合并
- 生成后: 新会话编辑器草稿 == 生成的 prompt; parentSession 指向旧会话文件
- 已下沉后执行 new: 总结输入为全文 (不应用投影)

## 13. 实施动作清单 (待批准)

1. 目录/包改名 `pi-manual-context` → `pi-mctx`, package.json name 同步为 `@xyzensun/pi-mctx`
2. 建立拆分模块骨架 (index.ts + src/)
3. 实现 sink 子系统 (store / command / project / obs-tool / config)
4. 实现 new 子系统 (new-session / file-inventory)
5. 插件 README 重写 (两个子命令的作用与用法)
6. typecheck + `pi -e ./pi-mctx/index.ts` 本地验证
7. 根 README 插件清单同步更新
