# 同步机制实现说明

> 本文描述当前代码的实际行为，含源码位置与行号，改代码时需同步更新。
> 架构规范见 `design.md`。所有行号基于 `main` 分支。

目录：
1. 整体同步流程
2. 三方比较（B/L/R）完整规则
3. hash 计算与 adapter 规范化
4. 基线（baseline）写入规则
5. 冲突判定与方向集合
6. 包（package）与扩展（extension）同步机制
7. 便携性检查现状：哪些文件含机器特有内容
8. 已发现的代码问题

---

## 1. 整体同步流程

`/pisync` 一次完整运行的顺序（`commands.ts` → `pull-flow.ts` / `push-flow.ts` / `apply-transaction.ts`）：

```
① 加载 state.json + pi-sync.json
② 三方比较 compareFiles()          → 得到每个文件的 changeType
③ capture（L → R）                 → 把 local_* 类改动写进 repo 工作区，git commit
④ git fetch + rebase / fast-forward
⑤ 三方比较（再次）
⑥ 包计划 preparePackagePlan()      → 需审批则阻断
⑦ apply（R → L）                   → 备份 → 写文件 → 执行包安装 → 写基线
⑧ git push 共享分支 + 设备恢复分支
```

关键位置：
- 三方来源：B = `state.json.files`，L = `~/.pi/agent` 磁盘文件，R = `<config-repo>/sync/` 工作区（**不是** git 远端）
- 基线只在 ⑦ apply 成功后写入；capture 不碰基线
- autoSync 只走 ①②⑤⑦（单向拉取，永不 push，本机有 local_* 改动时跳过）

---

## 2. 三方比较（B/L/R）完整规则

### 2.1 三方定义

| 变量 | 含义 | 来源 |
|---|---|---|
| **B** | Baseline 上次同步基线 | `state.json` 的 `files[relPath].sha256` |
| **L** | Local 本机当前文件 | `agentDir` 磁盘文件 |
| **R** | Repo 仓库镜像文件 | `<repoPath>/<config.root>/` |

候选路径集合 = include 白名单内的 agent 文件 ∪ include 内的 repo 文件 ∪ baseline 中已管理且仍在白名单内的路径（`inventory.ts:280-311`）。第三项保证"两边都删了"的文件仍能被发现。

不在 include 白名单内的文件**根本不进入比较**——被过滤掉，而不是被归类为"未跟踪"。

### 2.2 `classifyChange()` 判定表（`inventory.ts:410-465`）

`∅` = 文件不存在（用哨兵 `"absent"` 占位，与真实 64 位 hex hash 不可能碰撞）；`=B`/`≠B` 指与基线 hash 比较。

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
| 11 | `local_only` | 存在 | ≠B | =B | 仅本机改 |
| 12 | `remote_only` | 存在 | =B | ≠B | 仅仓库改 |
| 13 | `converged` | 存在 | ≠B | ≠B，L=R | 两端改��同样内容 |
| 14 | `both_modified` ⚠️ | 存在 | ≠B | ≠B，L≠R | 双边冲突 |

⚠️ = 冲突类型，共 3 种。

### 2.3 "absent" 哨兵的作用

`null`（文件不存在）被折叠成字符串 `"absent"`，让"存在性"与"内容"统一成一次相等性比较，删除/创建不需要独立代码路径。

副作用：不可读的文件（权限问题）被 `try/catch` 静默跳过，**等价于 absent**，可能被误判为删除。

---

## 3. hash 计算与 adapter 规范化

### 3.1 两条分支（`inventory.ts:198-225`）

判别条件是 `hasAdapter(config, relPath)`——**只看 `special[path]` 是否声明且不为 `"direct"`，没有任何按文件名的隐式匹配**。

**普通文件**：对原始字节求 SHA-256。

**adapter 文件**：先 `normalizeForComparison` 再求 hash，并额外保存 `rawSha256`（原始字节 hash）用于 legacy 迁移。

### 3.2 内置 `settings` adapter 的规范化（`settings-adapter.ts:203-209`）

三重效果：
1. 白名单投影——只保留 29 个设备无关顶层键（`SETTINGS_WHITELIST`，`:20-50`），白名单外键不参与比较
2. 剥离非便携包源——`packages[]` 中只保留 `npm:`/`git:`/`https:`/`ssh:`，`file:`/相对路径/`~/` 不影响比较
3. canonicalize 递归键排序——JSON 键序变化不产生假差异

推论：仅改动白名单外字段（如 `sessionDir`、`trackingId`）或仅增删 `file:` 包的本机 `settings.json`，会被判为 `no_change`。

### 3.3 `mode` 不参与比较

`classifyChange` 只比 `sha256`。纯 `chmod` 改动对三方比较不可见，但会随基线更新被记录。

### 3.4 legacy baseline 迁移（`inventory.ts:421-425`）

旧版本对 settings.json 存原始字节 hash，新版存规范化 hash。若直接比较会全部误判为冲突。修复：
- 若 B == L 的 `rawSha256` → 把 B 重解释为 L 的规范化 hash
- 否则若 B == R 的 `rawSha256` → 重解释为 R 的规范化 hash
- 都不匹配 → 保持原值

惰性迁移，不改 state.json；下次 apply 成功写入 `nextBaseline` 时才真正换代。普通文件 `rawSha256` 为 `undefined`，分支自动短路。

---

## 4. 基线（baseline）写入规则

### 4.1 唯一权威写入路径

**基线只在 apply 方向落盘，且严格在文件 I/O 成功之后。** capture（push）方向不碰 `state.files`。push 完成后走 `applyCurrent`，此时 L=R 判为 `converged`/`no_change`，基线取 remote 值。

### 4.2 `buildNextBaseline()`（`materialize.ts:307-404`）

**全量重建，非增量合并**：从空对象起步遍历全部 comparisons，未被写入的路径即被移除。

三层优先级：
1. `useRemoteForConflicts`（冲突已选远端）→ 以 remote 为基线；remote 为 null 则移除
2. `deferApplyPaths`（用户推迟）→ 保留旧基线条目，下次重新检测
3. 按 changeType 分派：

| changeType | 基线行为 |
|---|---|
| `no_change` / `converged` / `remote_only` / `remote_created` | 取 remote（回退 local → 旧基线） |
| `remote_deleted` / `both_deleted` | 移除 |
| `local_only` / `local_created` / `local_deleted` | apply 中不应出现；若出现保留旧基线 |
| 3 种冲突 | 不写入（计划已 blocked） |

### 4.3 两个提交点（`apply-transaction.ts`）

1. **纯收敛路径**（`:34-70`）：无文件读写但基线/commit/branch 有变 → 直接 `updateState`。这是 `converged`/`both_deleted` 无 I/O 也能推进基线的通道。
2. **正常 apply 路径**（`:206-217`）：备份 → `executeMaterialize` → `executePackages` → `updateState`。任一阶段失败则回滚备份，只写 `pendingOperation`，**不动 `files`**。

---

## 5. 冲突判定与方向集合

### 5.1 冲突（`isBilateralConflict` / `hasBilateralConflicts`，`inventory.ts`）

`both_modified` / `local_modified_remote_deleted` / `local_deleted_remote_modified`。

`materialize.ts`（冲突收集）、`capture.ts`（三处）、`commands.ts`（冲突路径归类）统一调用 `isBilateralConflict`。`materialize.ts` 的 `buildNextBaseline` switch 分支为穷举分派，保留 case 列举。

冲突阻断：apply 侧 `planMaterialize` 置 `blocked=true` 提前返回；capture 侧直接返回（除非 `preferLocalOnConflicts`）。

覆盖机制：`useRemoteForConflicts`（apply 侧，以远端强制解决）/ `preferLocalOnConflicts`（capture 侧，以本机为准）。

### 5.2 方向集合完全不相交

| changeType | capturable（L→R） | applicable（R→L） | 备注 |
|---|:--:|:--:|---|
| `local_only` / `local_created` / `local_deleted` | ✅ | ❌ | |
| `remote_only` / `remote_created` | ❌ | ✅ | |
| `remote_deleted` | ❌ | ✅ | 真删需 `delete: "tracked"` 且基线有记录 |
| `both_deleted` | ❌ | ✅ | 无文件 I/O，仅清基线 |
| `converged` | ❌ | ✅ | 无文件 I/O，仅推进基线 |
| `no_change` | ❌ | ❌ | 仍参与 `buildNextBaseline` |
| 3 种冲突 | ❌ | ❌ | 阻断 |

`delete: "none"` 时永不传播删除。

---

## 6. 包（package）与扩展（extension）同步机制

### 6.1 Pi 的两种扩展安装方式（前提知识）

| 方式 | 位置 | 如何进入 Pi | pi-sync 如何处理 |
|---|---|---|---|
| **目录扩展** | `~/.pi/agent/extensions/<name>/` 下的 `.ts` 文件 | Pi 启动时直接加载，不走 `pi install` | 作为**普通文件**走 `include: extensions/**`，按字节三方比较、capture/apply |
| **包扩展** | `pi install npm:xxx` → 装到 `~/.pi/agent/npm/`；`pi install git:xxx` → `~/.pi/agent/git/` | 由 `settings.json` 的 `packages[]` 声明 | **不同步安装目录**（默认 include 不含 `npm/**`、`git/**`），只同步 `packages[]` 声明；目标机自己执行 `pi install` |

所以"package 系统"对应的文件就是 **`settings.json` 里的 `packages` 数组**，没有其他文件。`npm/`、`git/` 目录不同步，不是因为代码级禁止（hard-deny 已移除），而是默认 `include` 没覆盖它们；若手动写进 include 会被当普通文件同步（含 `node_modules`，不建议）。

### 6.2 `packages[]` 声明的同步：两层防护

**第一层：settings adapter**（`settings-adapter.ts`，推送/拉取时）

`isPortablePackageSource()`（`:104-109`）判定：
- 不可便携：`file:`、`./`、`../`、`/`、`~/`
- 可便携：`npm:`、`git:`、`https://`、`ssh://`

`toRepository`（push）：剥离不可便携源，`file:` 不进仓库。
`toLocal`（pull）：仓库覆盖白名单内键，但本机独有的不可便携包通过 `localOnlyNonPortable()`（`:125-137`）回填——**`file:` 本地开发插件不会因 pull 被删除**。

**第二层：packages 系统**（`packages.ts`，执行时）

`validatePackageSource()`（`:68-84`）再次拦截 `file:`（抛 "Local package paths are not allowed"）。
- 本地侧解析用 `{ skipInvalid: true }` 静默跳过
- 远程侧解析不带该选项，远程 settings.json 混入 `file:` 直接抛错（防御性一致）

结果：`file:` 永远不会触发 `pi install` / `pi remove`。

### 6.3 包计划与审批（`packages.ts:188-237`）

`planPackageChanges()` 按 `normalizePackageName`（去掉 `npm:` 前缀和版本号）对齐本地与远程声明，产出 added / changed / unchanged / removed。

**审批规则**：added 与 changed 中，非内置可信源（`npm:@xyzensun/pi-sync` 免审）且未在 `package-trust.json` 记录过的，进 `approvalRequired`。理由（`packages.ts:1-6` 注释）："Remote settings are data, not permission to execute code"——`git:`/`https:`/`ssh:` 指向可执行代码，必须显式批准。

`remember: true` 的批准只在**全部安装成功后**才写入 trust store，失败不扩大信任。

### 6.4 执行（`packages.ts:404-544`）

顺序：`pi --version` 探测 CLI → 逐个 `pi install`（changed 先 `pi remove` 旧的）→ 任一失败则反向回滚已装的 → 确认过的 removed 项 `pi remove`（失败仅警告，不阻断）。

在 apply 事务中的位置：备份 → 写文件 → **执行包** → 写基线。包安装失败会回滚已写文件。

### 6.5 扩展目录的三方比较

`extensions/**` 下的目录扩展就是普通文件，走 §2 的规则。`/pisync` 会把 `extensions/**` 改动和 `packages[]` 变化归类成"扩展计划"逐项询问（安装 / 清理残留 / 应用 / 推迟 / 分享 / 仅本机保留）。推迟的项通过 `deferApplyPaths` 保留旧基线，下次再问。

插件自身目录 `extensions/pi-sync/**` 在默认 exclude 中，且代码在解析 include 前额外剔除，永不被 capture。

---

## 7. 便携性检查现状：哪些文件含机器特有内容

### 7.1 现有检查分布（两套并存）

| 位置 | 触发方式 | 检查内容 |
|---|---|---|
| `settings-adapter.ts` | 按 `special` 声明（adapter） | `packages[]` 便携源过滤 + 白名单投影 |
| `validate.ts:202-204` | **按文件名硬编码** `normalizedPath === "settings.json"` | `packages[]` 绝对路径 error、非便携源 warning、缺同步插件 warning、`/home/` `/Users/` 路径 warning、`externalEditor` 绝对路径 warning |

**问题**：`validate.ts` 的检查与 `special` 无关。即使把 `settings.json` 从 `special` 移除改成 `direct` 字节同步，`validateFiles` 仍会按文件名对它做便携性校验，并可能以 `error` 阻断 apply。这与 A2 决策（"只有 `special` 才做特殊处理"）不一致。

### 7.2 各文件的机器特有内容（基于 Pi 默认布局）

| 文件 | 机器特有内容 | 当前处理 |
|---|---|---|
| `settings.json` | `packages[]` 中 `file:`；`sessionDir`、`trackingId`、`lastChangelogVersion`；`externalEditor` 绝对路径；`outputPath` 等 | adapter 白名单投影 + `validate.ts` 硬编码检查 |
| `models.json` | 可能含本地 API endpoint、绝对路径 | 无检查，若入 include 则按字节同步 |
| `auth.json` | 凭据 | 无检查，默认不在 include |
| `keybindings.json` | 一般无 | 字节���步 |
| `AGENTS.md` / `SYSTEM.md` / `APPEND_SYSTEM.md` | 用户写的提示词，可能含本机路径 | 字节同步 |
| `extensions/**` 目录扩展 | 扩展自身可能读写本机路径，源码里可能有硬编码路径 | 字节同步；`cache/`、`logs/`、`tmp/` 等默认 exclude |
| `npm/**` / `git/**` | 已安装包本体，含 `node_modules` | 默认不在 include |
| `themes/**` / `skills/**` / `prompts/**` | 一般无 | 字节同步 |

结论：真正含机器特有内容的就 `settings.json` 一个，其他文件的"机器特有"是用户内容层面的，工具无法判断。

---

## 8. 已知问题

1. **`summary` 计数不完整**：`inventory.ts` 的 `summary` 只统计 9 类，漏了 `both_deleted`、`local_modified_remote_deleted`、`local_deleted_remote_modified`。UI 不能依赖 `summary` 做冲突判断，应直接遍历 `comparisons`。
2. **`validate.ts` 按文件名硬编码 settings.json 检查**：与 `special` 机制平行、不受 adapter 声明控制（§7.1）。已列入 `v0.2.0.md` 决策 2。
3. **`validate.ts` 与 `settings-adapter.ts` 的便携判定不一致**：`validate.ts` 只对 `/` 和 `~/` 开头报 error，`file:` 只落到 warning；adapter 侧 `file:` 与 `/` 同级都判不可便携。随决策 2 一并统一。
4. **`state.json` 丢失且仓库不在默认路径时无自动恢复**：`inspectLifecycleState` 只探测 `join(agentDir, "..", "config-repo")`。

已修复（不再存在于代码中）：`untracked_local` 死枚举值、冲突三元组三处重复（现统一为 `isBilateralConflict`）、`isPathAllowed` 返回值的恒假 `denied` 字段、`getRepoPathSafe` 无用参数。
