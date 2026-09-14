# 决策 3 前置材料：现状机制报告 + 待决问题

> 用途：在设计 TUI 与命令入口（决策 3）之前，把**同步流程、锁、哈希比较、冲突处理**四套现有机制说清楚，
> 使设计建立在事实而非印象上。所有结论均来自阅读 `0e0cfb2` 的源码，标注 `文件:行号`。
>
> 本文是一次性的评审材料，决策敲定后并入 `docs/v0.2.0.md` 决策 3，本文即可删除。
>
> 阅读顺序建议：先读第一部分（机制报告），再读第二部分（待决问题）。

---

# 第一部分：现状机制报告

## 1. 同步流程总览

### 1.1 一次完整 `/pisync` 的阶段序列

入口 `run()`（`commands.ts:802`）只包一层 `withOperationSignal`，实体是 `runWithOperationSignal`（`commands.ts:808`）：

```
① preflight   inspectLifecycleState()            commands.ts:816
              ├─ broken            → partial_failure 直接退出   :818
              ├─ uninitialized     → setup 分支（走完即 return） :830
              └─ interrupted_setup → setup 分支                 :861
② 加锁        lock.acquire("sync", 5000)          commands.ts:886
③ 指纹校验    planInitializedSync() 重算并比对     commands.ts:900
④ 选择归一化  normalizeSyncSelections()            commands.ts:919
⑤ recovery    仅当 state.pendingOperation 非空     commands.ts:922
⑥ syncInternal                                    commands.ts:943
   ├─ 7a pull  this.pull(repoPath, ...)            commands.ts:736
   │           └─ runPullFlow → …… → applyCurrent(reason="pull")
   │           ★ pull 未 ok 则提前 return，push 不执行  commands.ts:745-775
   └─ 7b push  this.push(repoPath)                 commands.ts:778
               └─ preparePush → executePush → applyCurrent(reason="push")
```

**关键结构性事实：apply 不是独立阶段**，它内嵌在 pull 与 push 各自的末尾
（`pull-flow.ts:265/285/300/319`、`push-flow.ts:468`）。这正是 `CLAUDE.md`
"push 完成后统一走 apply 收口"的实现方式。

### 1.2 pull 与 push 已完全解耦

这是决策 3 最重要的前提，有四条独立证据：

| # | 证据 | 位置 |
|---|---|---|
| 1 | `syncInternal` 中是两次**串行独立调用**，不共享中间变量；`push(repoPath)` 连 `packageApproval`/`onProgress`/`signal` 都没接 | `commands.ts:736` 与 `:778` |
| 2 | `pull-flow.ts` 的 git import 里**没有任何 push 能力**（无 `gitPush`/`gitPushHeadToBranch`） | `pull-flow.ts:1-7` |
| 3 | `autoSyncOnce()` 已在生产中跑 pull-only 路径 | `commands.ts:1507` |
| 4 | 测试早已把 `pull()` 当独立单元调用 | `test/commands-pull.test.ts:65` 等 |

**结论：`/pisync pull` 与 `/pisync push` 不需要改 `run()` 一行。**

### 1.3 但 `pull()` 现在是"哑"的 —— 三个坑

| 坑 | 事实 | 后果 |
|---|---|---|
| **A. 收不到 selections** | `pull()` 签名（`commands.ts:1396-1401`）只有 `repoPath`/`packageApproval`/`onProgress`/`executionOptions`。扩展选择门禁在 `applyCurrent`（`commands.ts:2197`），条件含 `selections?.reviewed === true`，而 `activeSelections` **只有 `run()` 会赋值**（`commands.ts:919`，`:950` 清空） | 直接调 `pull()` → 门禁不触发 → **远端扩展/包变更无提示直接落地本机**。这正是 autoSync 能静默生效的机制 |
| **B. 无生命周期检查** | `pull()` 只有 `getRepoPath()`（`commands.ts:1402`）；`run()` 靠 `inspectLifecycleState()`（`:816`）拦截 broken/uninitialized | 未初始化时直接抛错。`autoSyncOnce` 是自己先调 `inspectLifecycleState()` 兜的（`commands.ts:1450`） |
| **C. 无指纹参数** | `pull()` 没有 `expectedPlanFingerprint` | 无法做"审阅期间计划变了就拒绝"的 TOCTOU 防护 |

**push 侧反而是现成的**：`preparePush()`（`commands.ts:1529`）/ `executePush()`（`commands.ts:1579`）
本就是两段式，且 `executePush` 执行前**重校验指纹**（`push-flow.ts:389` 失效则 `blocked_conflict`）。
即 push 的计划预览是原生能力，pull 缺。

### 1.4 `pull` 并非字面意义的"零远端写入"

rebase 冲突时 `preserveRebaseConflict`（`pull-flow.ts:260`）
→ `preserveRebaseConflictOnDeviceBranch`（`commands.ts:1215`）
→ `gitPushDeviceBranch`（`commands.ts:1231`），即 `git push --force-with-lease` 到设备快照分支。

这是**只推设备分支、绝不推共享 branch** 的保命写入。措辞上应说 "pull = 不推共享分支"，而非 "不写远端"。

---

## 2. 锁机制

### 2.1 物理实现：**只有一把锁**

```
锁文件：<syncDir>/sync.lock            lock.ts:25
syncDir = join(agentDir, ".pi-sync")   commands.ts:347
```

`SyncLock` 构造函数把文件名**硬编码**为 `sync.lock`（`lock.ts:25`），构造参数只有 `syncDir`。
`PiSyncCommands` 只在构造时建一个实例（`commands.ts:347`），全仓无第二处 `new SyncLock`。

**因此下列 10 个标签不是不同的锁，只是写进同一个锁文件的 `operation` 诊断字段（`lock.ts:16`）：**

| 取锁方式 | 标签 |
|---|---|
| 直接 `acquire` | `sync`（`:886`）、`resolve-conflict`（`:498`）、`apply`（`:1848`）、`init`（`:1922`）、`clear-repo`（`:1973`） |
| 经 `withCommandLock` | `apply`（`:1372`）、`pull`（`:1405`）、`push-prepare`（`:1533`）、`push`（`:1587`）、`push-continue`（`:1697`） |

推论（对决策 3 直接相关）：**pull 与 push 天然互斥，不可能并发**。TUI 里不需要考虑
"一边 pull 一边 push"的并发状态。

注：`apply` 标签被 `:1372` 与 `:1848` 两处复用，看锁文件无法区分是 `apply()` 还是 init 的已初始化分支。

**只读命令全部不取锁**：`status()`（`:1278`）、`diff()`（`:1310`）、`needsSync()`（`:1241`）、
`plan()`（`:381`）。即 TUI 刷新状态不会与同步互相阻塞。

互斥手段是 `writeFile(..., { flag: "wx" })` 排他创建（`lock.ts:67-71`），依赖文件系统的
O_EXCL 原子性。锁内容为 `{ pid, hostname, startedAt, operation }`（`lock.ts:12-17`）。

### 2.1.1 锁文件初始化后会被重定位到仓库内

`relocateLocalStateDir`（`state.ts:128-167`）把 `agentDir/.pi-sync` 整体 `rename` 进配置仓库
（`state.ts:157`），并在原路径留一个目录符号链接（`state.ts:162-166`）。
该目录被双重忽略：`.gitignore`（`setup-flow.ts:497`）+ `.git/info/exclude`（`state.ts:104-122`）。

即初始化后 `sync.lock` 的物理位置是 `<config-repo>/.pi-sync/sync.lock`，经 symlink 访问。
两条推论：锁文件**永不跨机同步**（所以 `hostname` 不参与判定是自洽的）；
两个 agentDir 不同但 repoPath 相同的 Pi 实例会共享同一把锁，互斥仍成立。

### 2.2 API 与超时

| 方法 | 位置 | 语义 |
|---|---|---|
| `acquire(operation, timeoutMs = 0)` | `lock.ts:33` | 默认 **0 = 不等待，立即返回 false**。传正值则轮询重试（有锁时 200ms 间隔 `:51`，竞争失败时 100~300ms 随机退避 `:79`）。**从不抛异常** |
| `release()` | `lock.ts:91` | **只释放自己创建的锁**：比对 `existing.pid === this.lockInfo?.pid`（`:102`）才 unlink |
| `readLock()` | `lock.ts:117` | 读锁信息，解析失败返回 null |
| `isStale()` | `lock.ts:131` | 私有，见下 |

**全部调用点统一用 5000ms**：`commands.ts:498/688/886/1848/1922/1973`。

**截止判断在 sleep 之前**（`lock.ts:50` 与 `:77`），故实际最长等待可超出 `timeoutMs`
约一个轮询间隔：有效锁分支最多 +200ms，竞态分支最多 +300ms。传 5000 时最坏约 5.3s。

`SyncLock` 内部**没有** try-finally，释放责任全在调用方。已核对 `commands.ts` 的
6 处直接 acquire **全部有对应的 finally release**
（`:558`/`:691`/`:948`/`:1910`/`:1948`/`:2019`），另 5 处经 `withCommandLock` 复用 `:691`。

### 2.3 陈旧锁：靠 pid 存活探测，**不靠时间**

```
process.kill(info.pid, 0)   lock.ts:139
```

信号 0 只做存在性检查。进程活着 → 锁有效；抛错（ESRCH）→ 判定过期，直接 unlink（`lock.ts:47`）后重试。

**没有任何时间阈值**——一个卡死但进程仍在的 pi-sync 会永久持锁。
`startedAt`（`lock.ts:63` 写入）**只写不读**：全仓仅类型声明与写入两处，无任何读取点，
纯属诊断信息，不参与判定。

锁文件损坏无法解析时，`isStale()` 返回 `existsSync(this.lockPath)`（`lock.ts:134`），
即视为过期允许恢复，避免坏文件造成永久死锁。

两个 pid 探测的边界情况：

- **pid 复用**：死进程的 pid 被无关新进程占用 → `process.kill(pid,0)` 成功 → 永久判定"锁有效"，
  所有 acquire 恒失败，只能手工删 `sync.lock`
- **EPERM**：pid 存在但属其他用户时 Node 抛 `EPERM`，被 `lock.ts:141` 的裸 catch 吞掉
  → **误判为陈旧并强删他人的有效锁**

**跨机风险**：`hostname` 只被记录，`isStale` 不比对。但因 §2.1.1 锁文件永不跨机同步，
此项在当前设计下不构成实际问题。

### 2.4 重入：`withCommandLock` + `orchestrationLockHeld`

```typescript
// commands.ts:682-693
private async withCommandLock<T>(operation, onBusy, run): Promise<T> {
    if (this.orchestrationLockHeld) return run();          // ← 重入短路
    if (!(await this.lock.acquire(operation, 5000))) return onBusy();
    try { return await run(); } finally { await this.lock.release(); }
}
```

`run()` 在 `commands.ts:886` 直接 `acquire("sync")` 成功后，于 `:898` 置
`orchestrationLockHeld = true`；内部调用的 `pull()`（`commands.ts:1405` 用 `withCommandLock`）
命中 `:687` 的短路直接执行，**不再取锁 → 不会自我死锁**。

**异常安全**：`commands.ts:948-952` 是 `finally` 块，同时复位
`orchestrationLockHeld = false`、`activeSelections = null`、`await this.lock.release()`。
即使 `syncInternal` 抛异常也不残留（顺序也正确：先摘标志再放锁）。
实证：`test/commands-pull.test.ts:109-165` 制造 git 挂起 + 超时，断言超时后锁必须已释放。

### 2.4.1 ~~同进程重入漏洞：autoSync 可绕过文件锁~~ 已修

**根因**：`orchestrationLockHeld` 是**实例级布尔量，不是 async-context 级**，
而 `index.ts` 只创建一个共享的 `cmds` 实例，autoSync 定时器与 `/pisync`
命令处理器复用它。因此 autoSync 定时器在手动 `run()` 期间触发时：
`autoSyncOnce` → `pull()` → `withCommandLock` → **命中重入短路，直通执行、
完全绕过文件锁**。文件锁只挡跨进程竞争，挡不住同进程重入。

**修法是两层守卫**（缺一不可，覆盖的时段不同）：

| 层 | 位置 | 挡什么 |
|---|---|---|
| 编排层 | `autoSyncOnce` 开头自查 `orchestrationLockHeld`，命中返回 `skipped/busy` | 同步**真正在跑**的时段。这是根因修复，任何调用方都受保护 |
| 扩展层 | `index.ts` 的 `commandInFlight` 标志，定时器回调命中即跳过本次 tick | 命令处理器**等待用户输入**的时段（计划预览、包审批、冲突菜单、status/diff 全屏输出）——此时并不持锁 |

第二层的必要性：处理器弹对话框时锁已释放或尚未获取，用户可能停留很久。
此时 autoSync 若落地远端变更，用户手上那份计划就成了过期数据——指纹校验会拒绝执行，
表现为一次莫名其妙的失败。常驻 TUI 会把这个窗口拉得更长。

回归保护：`test/autosync.test.ts`（持锁时 `skipped/busy` 且本机文件不被改动）、
`test/extension.test.ts`（命令执行中跨两个周期不触发 tick，结束后恢复）。
两条都验证过——移除对应守卫即失败。

> 遗留：autoSync 的 preflight 含 `gitFetch`，它会写 `.git` 的远端引用且
> **发生在取锁之前**。这是只读元数据写入，不改工作区文件，风险远低于上述漏洞，
> 仍记在 §5 问题 8。

### 2.5 抢锁失败的表现

统一文案 **"已有同步操作正在进行。"**，`partial_failure` 级（error）：

| 位置 | 场景 |
|---|---|
| `busyCommandResult()` | `withCommandLock` 的 onBusy 默认值 |
| `run()` 抢 "sync" 失败 | 手动同步入口 |

> D9 之前还有第三处：`resolveConflict()` 抢锁失败。该方法已随 D9 删除。

`autoSyncOnce` 靠**消息子串** `result.message.includes("已有同步操作")` 判定
（`commands.ts:1516`）折叠为 `skipped/busy`。

> ⚠️ 这是中文化的已知脆弱点：`v0.2.0.md` 决策 1 已记录"消息与判定须一起改"。
> 若未来改文案而漏改此处，autoSync 会把"忙"误报为 `needs_interaction`。

### 2.6 `pendingOperation`：另一种"跨进程逻辑锁"

`state.json` 的 `pendingOperation` 记录**中断的事务**，与文件锁正交：

| 值 | 写入点 | 消费点 |
|---|---|---|
| `apply-failed` | `apply-transaction.ts:118-129`（唯一写入点在 `recordFailedApply`，仅在**包安装失败且已回滚备份**后写，`context` 含 `commit`/`reason`/`backupPath`/`packageErrors`） | `recoverPendingInternal` → `this.apply()`（`commands.ts:720`） |
| `push-rebase-conflict` | **当前代码无任何写入点**（已 grep 全仓确认）。仅 v2→v3 迁移可能产生（`state.ts:389-401`），属遗留值 | `recoverPendingInternal` → `push(..., "--continue")`（`commands.ts:717`）、`pushContinue` 门禁（`:1693`） |

清除点：apply 成功后的 `updateState(..., pendingOperation: null)`
（`apply-transaction.ts:61` 与 `:216`）、`pushContinue` 推送成功（`commands.ts:1756`）、
`clearRepo` 重置（`commands.ts:2007`）。

**与文件锁的本质区别**：文件锁是**进程存活期**的互斥（进程死则 pid 探测使其自动失效）；
`pendingOperation` 是**持久化的事务断点**，进程死后必须保留，由下次 `run()` 显式恢复
（`commands.ts:922`）。autoSync 遇到它直接跳过（`commands.ts:1471`）。
写入走"临时文件 + rename"（`state.ts:265`），翻转是原子的，不依赖锁。

---

## 3. 哈希与三方比较机制

### 3.1 三方定义

| 变量 | 含义 | 来源 |
|---|---|---|
| **B** | Baseline，上次同步基线 | `state.json` 的 `files[relPath].sha256` |
| **L** | Local，本机当前文件 | `agentDir` 磁盘（`inventory.ts:262`） |
| **R** | Repo，仓库镜像文件 | `<repoPath>/<config.root>/`（`inventory.ts:263`） |

**R 是本地 git 工作区，不是远端**。远端通过 git fetch/rebase 先进入工作区，再参与比较。

候选路径集合 = 白名单内的 agent 文件 ∪ 白名单内的 repo 文件 ∪ **基线中已管理且仍在白名单内的路径**
（`inventory.ts:278-309`）。第三项保证"两端都删了"的文件仍能被发现。

不在 include 内的文件**根本不进入比较**，而非被归类为"未跟踪"。

### 3.2 `"absent"` 哨兵

```typescript
const ABSENT_HASH = "absent";     // inventory.ts:85
```

文件不存在折叠为字符串 `"absent"`（`inventory.ts:415-417`），使"存在性"与"内容"统一成一次相等比较，
删除/创建无需独立代码路径。`"absent"` 与 64 位 hex 不可能碰撞。

**副作用**：不可读的文件被 `try/catch` 静默跳过（`inventory.ts:224-227`），**等价于 absent，
可能被误判为删除**。

### 3.3 判定表（`classifyChange`，`inventory.ts:410-462`）

| # | changeType | B | L | R | 语义 |
|---|---|---|---|---|---|
| 1 | `no_change` | 存在 | =B | =B | 无变化 |
| 2 | `local_created` | ∅ | 存在 | ∅ | 本机新建 |
| 3 | `remote_created` | ∅ | ∅ | 存在 | 仓库新建 |
| 4 | `converged` | ∅ | 存在 | L=R | 两端同时新建、内容相同 |
| 5 | `both_modified` ⚠️ | ∅ | 存在 | L≠R | 两端同时新建、内容不同 |
| 6 | `both_deleted` | 存在 | ∅ | ∅ | 两端都删 |
| 7 | `local_deleted` | 存在 | ∅ | =B | 仅本机删 |
| 8 | `remote_deleted` | 存在 | =B | ∅ | 仅仓库删 |
| 9 | `local_deleted_remote_modified` ⚠️ | 存在 | ∅ | ≠B | 本机删 / 仓库改 |
| 10 | `local_modified_remote_deleted` ⚠️ | 存在 | ≠B | ∅ | 本机改 / 仓库删 |
| 11 | `local_only` | 存在 | ≠B | =B | 仅本机改 → capture |
| 12 | `remote_only` | 存在 | =B | ≠B | 仅仓库改 → apply |
| 13 | `converged` | 存在 | ≠B | ≠B，L=R | 两端改成同样内容 |
| 14 | `both_modified` ⚠️ | 存在 | ≠B | ≠B，L≠R | 双边冲突 |

⚠️ = 冲突类型，共 3 种，由 `isBilateralConflict`（`inventory.ts:467`）统一判定。

### 3.4 hash 计算的两条分支

判别条件是 `hasAdapter(config, relPath)`（`inventory.ts:198`）——
**只看 `special[path]` 是否声明且不为 `"direct"`，没有任何按文件名的隐式匹配**。

- **普通文件**：对原始字节求 SHA-256（`inventory.ts:219`）
- **adapter 文件**：先 `normalizeForComparison` 再求 hash（`inventory.ts:206-212`），
  并额外保存 `rawSha256`（原始字节 hash，`:213`）用于 legacy 迁移

内置 `settings` adapter 的规范化（`settings-adapter.ts:228-234`）有三重效果：

1. **白名单投影** —— 只保留 29 个设备无关顶层键（`SETTINGS_WHITELIST`，`settings-adapter.ts:29-59`）
2. **剥离非便携包源** —— 只留 `npm:`/`git:`/`https:`/`ssh:`（`isPortablePackageSource`，`:113-118`）
3. **注入自身包声明 + canonicalize 递归键排序** —— `ensureSyncPackage`（`:134`）、`canonicalize`（`:164`）

推论：仅改动白名单外字段（`sessionDir`、`trackingId` 等）或仅增删 `file:` 包的本机
`settings.json`，会被判为 `no_change`。

**`mode` 不参与比较**：`classifyChange` 只比 `sha256`。纯 `chmod` 改动对三方比较不可见，
但会随基线更新被记录（`inventory.ts:214`）。

### 3.5 legacy 基线迁移

```typescript
// inventory.ts:420-422
let bHash = storedBaselineHash;
if (storedBaselineHash === local?.rawSha256) bHash = lHash;
else if (storedBaselineHash === remote?.rawSha256) bHash = rHash;
```

旧版对 settings.json 存原始字节 hash，新版存规范化 hash，直接比较会全部误判为冲突。
惰性迁移，不改 `state.json`；下次 apply 成功写 `nextBaseline` 时才真正换代。
普通文件 `rawSha256` 为 `undefined`，分支自动短路。

### 3.6 基线写入：唯一权威路径

**基线只在 apply 方向落盘，且严格在文件 I/O 成功之后。** capture 方向不碰 `state.files`。

`buildNextBaseline`（`materialize.ts:317-399`）是**全量重建，非增量合并**：
从空对象起步遍历全部 comparisons，未被写入的路径即被移除。

三层优先级：

1. `useRemoteForConflicts`（`materialize.ts:330`）→ 以 remote 为基线；remote 为 null 则移除
2. `deferApplyPaths`（`materialize.ts:341`）→ 保留旧基线条目，下次重新检测
3. 按 changeType 分派（`materialize.ts:352-395`）

两个提交点（`apply-transaction.ts`）：

| 路径 | 位置 | 说明 |
|---|---|---|
| 纯收敛 | `:34-72` | 无文件读写但基线/commit/branch 有变 → 直接 `updateState`。这是 `converged`/`both_deleted` 无 I/O 也能推进基线的通道 |
| 正常 apply | `:141-229` | 备份 → `executeMaterialize` → `executePackages` → `updateState` |

任一阶段失败则回滚备份，只写 `pendingOperation`，**不动 `files`**（`apply-transaction.ts:164-204`）。

---

## 4. 冲突处理机制

### 4.1 两个层次的冲突

这是理解冲突处理的关键，**两层完全独立、检测时机不同**：

| | (a) 语义层冲突 | (b) git 层冲突 |
|---|---|---|
| **定义** | 三方比较判出的 3 种 changeType | rebase/merge 产生的 CONFLICT，文件含冲突标记 |
| **检测** | `isBilateralConflict`（`inventory.ts:467`） | `gitRebase(...).conflict`（`pull-phase.ts:118`）、`listUnmergedPaths` |
| **粒度** | 单个受管文件（相对 agentDir） | git 索引中的未合并路径（相对 repo 根，含 `sync/` 前缀） |
| **时机** | capture 前、apply 前 | git fetch 之后的 rebase 期间 |
| **可否同时发生** | 可以。rebase 冲突后仍会走 `applyCurrent` 再做一次三方比较 | — |

`conflictPathsFrom`（`pull-flow.ts:255`）负责把 git 层路径经 `normalizeChangedFiles` 转回
相对 agentDir 的受管路径，两层在此汇合。

### 4.2 语义层冲突的处理

**apply 侧**：`planMaterialize` 收集冲突后置 `blocked = true` 提前返回，
除非该路径在 `useRemoteForConflicts` 中（`materialize.ts:158/170/179/195`）。

**capture 侧**：存在冲突且未开 `preferLocalOnConflicts` 时直接返回（`capture.ts:73-75`）；
开启后改为把冲突路径也纳入 capturable（`capture.ts:82-88`），即以本机为准。

**基线处理**：冲突项**不写入基线**（`materialize.ts:390-394` 的三个 case 全部 break 不赋值），
因为计划已 blocked。

### 4.3 git 层冲突：设备恢复分支

```typescript
// commands.ts:1215-1235  preserveRebaseConflictOnDeviceBranch
const branch = await this.getDeviceBranchName();
await gitRebaseAbort(repoPath);                                  // 1. 放弃 rebase
await gitExec(repoPath, ["branch", "-f", branch]);               // 2. 设备分支指向本机 HEAD
await gitExec(repoPath, ["switch", branch]);
try {
    await gitExec(repoPath, ["branch", "-f", config.branch,
                             `origin/${config.branch}`]);        // 3. 主分支重置为远端
    await gitPushDeviceBranch(repoPath, branch);                 // 4. 推设备分支
} finally {
    await gitExec(repoPath, ["switch", config.branch]);          // 5. 必定切回主分支
}
```

**本机提交被完整保存在设备分支上，主分支被重置为远端** —— 这就是"远端优先"的物理实现。
`finally` 保证无论推送成功与否都切回主分支。

设备分支命名（`commands.ts:963-973`）：

```
pisync-device/<host>-<deviceId>
```

`host` 取 `hostname()` 小写、非 `[a-z0-9_-]` 替换为 `-`、截断 40 字符，空则为 `"device"`；
`deviceId` 由 `ensureDeviceId(agentDir)` 持久化在本机 state。
注释（`commands.ts:957-961`）明确："主机名可读但不唯一，因此与仅持久化在本机状态里的 UUID 配对使用。
我们绝不扫描远端分支去猜测。"

### 4.4 "远端优先"的三个入口

`design.md §4.2` 称三处语义一致，代码验证如下：

| 入口 | 位置 | 机制 |
|---|---|---|
| ① pull 前 capture 检测到双侧修改 | `pull-flow.ts:198-206` | 冲突路径记入 `remoteFirstPaths`，丢弃本机未推送漂移 |
| ② rebase 冲突 | `pull-flow.ts:251-281` | `preserveRebaseConflict` + 全部冲突路径加入 `remoteFirstPaths`（`:262`） |
| ③ apply 阶段三方比较冲突 | `pull-flow.ts:265` 传入 `useRemoteForConflicts` | 同一 apply 内以远端优先重试 |

三者最终**汇聚到同一个参数** `useRemoteForConflicts`（`materialize.ts:330`），
在"冲突路径以远端内容覆盖本机"这一点上语义确实一致。`pull-flow.ts:252-253` 的注释写明：
"rebase 冲突后 main 已指向远端（preserve 内部把本机提交保存到设备分支可找回），
继续以远端优先覆盖本机，不再阻塞等待手动。"

> ⚠️ **但三者的可恢复性并不一致，这是 `design.md §4.2` 未言明的差异。**
>
> `pull-flow.ts:199-200` 的注释明确写着："P2：双向冲突时**不再创建设备分支**，
> 改为丢弃本机未推送漂移、以远端覆盖冲突路径。"
>
> 即入口 ① 的本机改动**只有 apply 前的自动备份**（`.pi-sync/backups/`）这一条找回途径；
> 入口 ② 因为走了 `preserveRebaseConflict`，额外有设备恢复分支。
>
> 差异根源：入口 ① 的本机改动尚未 commit（capture 后发现冲突就没走
> `commitCapturedChangesBeforePull`），没有 commit 可推；入口 ② 的改动已经 commit 过。
>
> **这直接影响 Q3c 的判断**：入口 ① 场景下"备份和恢复分支兜底"里只有备份一条腿，
> 而备份只保留最近 5 份（§4.6），更早的漂移救不回来。

### 4.5 冲突转交（D9 后）

`SyncConflictRequest`（`operation-result.ts`）含
`sharedBranch` / `deviceBranch` / `sharedHead?` / `deviceHead` / `paths[]`。
它是**只读的转交载荷**：告诉扩展层"哪个分支、哪些路径冲突了、救命分支叫什么"。

**pi-sync 不再解决 Git 冲突**（决策 3 的 D9）。扩展层 `handleSyncConflict`
（`index.ts`）只有两条出路：

| 选项 | 做什么 |
|---|---|
| 请 agent 解决冲突 | 用 `buildAgentMergePrompt` 组装受约束的任务，投递给 Pi agent，不等待完成 |
| 停止 —— 我自己处理 | 走 `notifyManualMergeMessage`，展示手动步骤与设备恢复分支名 |

Esc 取消（`select` 返回 `undefined`）与选"停止"走同一分支——不做任何自动处理即安全默认。

**D9 之前存在的代码已全部删除**：

| 已删 | 原职责 |
|---|---|
| `commands.resolveConflict()` | 校验选择、抢锁、调用解决流程 |
| `commands.normalizeConflictChoices()` | 不信任 UI 路径，要求恰好覆盖 request 的路径集合 |
| `src/orchestration/conflict-flow.ts` | 编排解决 + 校验 + 收口 apply |
| `src/system/conflict-resolution.ts` | 执行 git merge + 按 stage checkout ours/theirs |
| `ConflictPathChoices` / `AutomaticConflictChoice` / `ConflictResolutionChoice` | 逐路径选边的类型 |

删除理由见 `tui-prd.md` §3.2.1：那套代码只是给 git 的 `ours/theirs` 包了层 UI，
不构成语义合并，能力上介于 agent 与用户之间且不如两者。

**未受影响**：`applyCurrent` 的 `useRemoteForConflicts` /
`automaticConflictResolutionAttempted` 两个参数**保留**。它们服务的是
pull 的"语义层冲突自动远端优先"（D7，见 §4.4），由 materialize 实现，
与 git 合并器无关。

### 4.6 备份与恢复

**触发时机**：`createBackup` 在 apply 事务开头（`apply-transaction.ts:152`），
**早于任何文件写入**；失败则整个 apply 中止（`:154-159`）。

**保留策略：固定 5 份**（`backup.ts` 的 `MAX_BACKUPS`）。
清理由 apply 事务在**基线落盘之后**调用（`apply-transaction.ts` 的
`cleanupOldBackups`）——此前的任何失败路径都仍需要旧备份回滚，所以不能提前清。
清理失败会被吞掉，不影响本次 apply 的成功。

> 本文初版记录的"备份无限增长"缺陷已修复（commit 3f3cb04）。

**恢复途径共三条**：

1. **自动回滚** —— apply 内失败时 `restoreBackup`（`apply-transaction.ts:166/201`）
2. **手动备份** —— `.pi-sync/backups/<timestamp>/`，失败消息里会给出 `backup.path`（`apply-transaction.ts:85`）
3. **设备恢复分支** —— `origin/pisync-device/<host>-<id>`，保留被远端覆盖的本机提交。
   **注意：仅在本机改动已 commit 的路径上存在**（即 §4.4 入口 ②）。
   入口 ① 的未提交漂移不会产生设备分支，只有途径 1、2 可用。

---

## 5. 顺带发现的既有问题（与决策 3 无关，仅记录）

| # | 问题 | 位置 |
|---|---|---|
| 1 | ~~`cleanupOldBackups` 无生产调用点，备份无限增长~~ **已修**（3f3cb04：固定 5 份，接入 apply 事务） | `backup.ts` / `apply-transaction.ts` |
| 2 | `summary` 只统计 9 类，漏了 `both_deleted` 与 2 种删改冲突。UI 不能依赖它判断冲突 | `inventory.ts:358-400` |
| 3 | autoSync 靠中文子串 `"已有同步操作"` 判忙，改文案会静默降级为 `needs_interaction` | `commands.ts:1516` |
| 4 | 不可读文件被静默当作 absent，可能误判为删除 | `inventory.ts:224-227` |
| 5 | 锁无时间阈值；pid 复用致永久持锁、EPERM 致误删他人锁 | `lock.ts:131-145` |
| 6 | ~~**同进程 autoSync 可绕过文件锁**，与 `design.md §5` 声明不符~~ **已修**（§2.4.1：编排层重入自查 + 扩展层 `commandInFlight`） | `commands.ts` `autoSyncOnce` + `index.ts` |
| 7 | `pendingOperation` 的 `push-rebase-conflict` 只有读取者、无写入者，属 v2 迁移遗留 | `state.ts:389-401` |
| 8 | autoSync 的 `gitFetch` 在锁外执行（会写 `.git` 远端引用） | `commands.ts:1477` |

其中 **6** 与决策 3 有直接关联（常驻 TUI 会放大交错窗口），已在 TUI 实现前修掉；
其余属独立待办，可另开条目。

### 5.1 锁相关的测试覆盖缺口

现有覆盖：`test/lock.test.ts`（基本获取/释放/拒绝）、`test/lock-recovery.test.ts`
（并发双抢恰好 1 个成功、陈旧锁与畸形锁自动恢复、非持有者不误删）、
`test/commands-locking.test.ts`（`withCommandLock` 系的 busy 分支）、
`test/commands-pull.test.ts:109-165`（超时后锁必须释放）。

未覆盖：

1. `orchestrationLockHeld` 重入路径无直接断言（仅由端到端"不死锁即通过"间接覆盖）
2. autoSync 的 `reason:"busy"` 分支无用例 → §5 问题 3 的中文子串匹配**无回归保护**
3. §2.4.1 的同进程 autoSync×run 并发漏洞无测试
4. pid 复用与 EPERM 误判无测试
5. 4 处直接 acquire（`resolve-conflict`/`init`/`initAlreadyInitialized`/`clear-repo`）的 busy 分支无测试

---

# 第二部分：待决问题

> 回答方式：直接在本文件每题的 **【答】** 处写，或在对话里按编号答复均可。
> 每题都给了推荐答案（➡️），认可推荐就写"同意"。

## Round 1

### Q1 — 命令集合与裸 `/pisync` 的行为

最终对外暴露哪几个入口？裸 `/pisync` 在**已配置**时具体做什么？

- **A**：`/pisync` → 无配置走初始化、有配置进 TUI；`pull` / `push` / `status` / `diff` 为**绕过 TUI 的直达命令**
- **B**：`/pisync` 保持现状（直接执行双向同步），另开 `/pisync tui` 进界面
- **C**：`/pisync` 进 TUI，`status` / `diff` 撤销为 TUI 内的面板（不再是命令），只留 `pull` / `push`

➡️ **A**。你的方向性意见就是 A，且保留了 `status`/`diff` 的肌肉记忆。C 的问题是 `diff` 输出已是全屏
`ctx.ui.custom` 组件（`index.ts:859-871`），塞进 TUI 需要嵌套全屏组件，风险最高。

**【答】**

---

### Q2 — "双向同步"是否仍是一等动作

拆出 `pull` / `push` 后，"一次搞定 pull+push"的合一动作还留不留？

- **A**：留。TUI 里第一项就是"同步（拉取+推送）"，等价于今天的裸 `/pisync`
- **B**：不留。用户永远显式选 pull 或 push，合一路径删除
- **C**：留但不给命令入口，只在 TUI 里可选

➡️ **A**。合一路径是今天 `run()` 的主干（`commands.ts:730-798`），删掉是伤筋动骨的改动；
日常"开机对齐一次"确实需要它。pull/push 是**补充**而非替代。

**【答】**

---

### Q3 — `/pisync pull` 的语义与提示强度

**Q3a：做到哪一步为止？**

- **A**：fetch + 快进/rebase + apply（R→L）+ 写基线。不 capture、不产生本机 commit、**不推共享分支**
- **B**：同 A 但跳过一切交互，做不到就报错退出
- **C**：等价于 autoSync 一次（要求 L≈B 无漂移，否则整个跳过）

➡️ **A**。B/C 太保守——`pull` 是主动下的命令，不是后台定时器。
C 的"有漂移就啥也不干"对手动命令反直觉。

注：措辞用"不推共享分支"而非"不写远端"，因为 §1.4 的设备分支保命写入应当保留。

**【答】**

---

**Q3b：提示强度取哪一档？**（因 §1.3 坑 A，这是必答项而非白捡）

- **A**：**带计划预览**。先 `plan()` 展示将落地的变更 → 确认 → 执行，扩展选择 UI 保留。
  代价：给 `pull()` 加 `selections` + `expectedPlanFingerprint` 两个形参
- **B**：**裸执行 + 事后汇报**。直接 `pull()`，完成后 notify 实际改了什么。
  代价：远端扩展/包变更静默落地，与 autoSync 同级
- **C**：**分档**。无扩展/包变更时裸执行；涉及扩展或包时回落到确认流程

➡️ **A**。"快速精准"应理解为**跳过 push 这半程**，不是跳过知情权。§1.3 坑 A 的静默落地对**手动命令**
是危险的——autoSync 能静默是因为它有 `L≈B 无漂移` 前置守卫（`commands.ts:1499`），手动 pull 没有。
C 会让"何时问、何时不问"变成隐式规则，更难预期。

**【答】**

---

**Q3c：pull 遇本机漂移 + 远端同文件也变（即将触发远端优先覆盖）时？**

- **A**：先弹框列出**将被覆盖的路径**再确认
- **B**：按 `design.md §4.2` 直接覆盖（有备份 + 设备分支兜底）

➡️ **A**，且 §4.4 的查证把这条从"体贴"升级为"必要"：入口 ① 场景（本机改动尚未 commit）
**不会创建设备恢复分支**，唯一找回途径是 apply 前的自动备份，而备份目录还没有清理策略。
静默丢弃"只有一条腿兜底"的本机改动，风险高于预期。

若 Q3b 选 A，此项可并入同一个预览框，不必单独弹；但**被覆盖路径必须在预览里显式列出并标红**，
不能只显示一个总数。

**【答】**

---

### Q4 — `/pisync push` 的语义

**Q4a：接受"push 必然包含 apply 收口"吗？**

如 §1.1 所述，push 完成后必须走 `applyCurrent(reason="push")`（`push-flow.ts:468`）才能写基线。
即 `/pisync push` 实际是 "capture → commit → push → apply 收口"。

- **A**：接受。收口阶段若发现远端有新内容也一并落地本机（这本就是现有 `run()` 的行为）
- **B**：不接受，push 必须纯粹。要求收口只写基线、不写本机文件
- **C**：接受，但收口会改动本机文件时先提示

➡️ **A**。B 要动 `CLAUDE.md` 列为"有意为之"的核心约束（基线只在 apply 方向写入），
代价与收益不成比例。C 的提示可作为 A 的一条进度消息，不必做成决策点。

**【答】**

---

**Q4b：是否用 `preparePush`/`executePush` 两段式做预览？**

➡️ **用**。机制已经在那儿（`commands.ts:1529`/`:1579`，含指纹重校验 `push-flow.ts:389`），
不用是浪费；且 push 是写远端的操作，预览价值高于 pull。

**【答】**

---

### Q5 — 无配置时的初始化流程形态

➡️ **A：保持现状**（逐步 `input`/`confirm`）。

§1 查证补强了理由：`setup-flow.ts` **完全不接触 `ctx.ui`**，5 个注入回调没有一个是询问用户的，
唯一出站通道是单向 `onProgress`。整个初始化**只有一个用户输入点：git URL**，
走"先失败→补输入→重试"的三段式（`commands.ts:838` → `index.ts:559` → 重跑）。
脚手架创建、URL 不匹配处理都没有确认交互。

**把初始化搬进 TUI = 从零造一个今天根本不存在的表单层。**

**【答】**

---

## Round 2（待 Round 1 敲定后展开，此处仅预告）

- TUI 承载哪些操作（状态总览 / 冲突处理 / 包审批 / include 清单编辑 / autoSync 开关）
- TUI 与现有一次性弹窗（包审批 confirm、冲突逐文件 select）如何共存
- 渲染方案：`ctx.ui.custom` 全屏组件 vs 组合现有对话框（等 pi-tui 能力查证回报）
- 非 TUI 模式（`hasUI === false`）下各命令的降级行为
