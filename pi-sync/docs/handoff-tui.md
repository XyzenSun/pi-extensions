# 交接：pi-sync 决策 3 第二阶段（TUI）

> 给新会话的启动 prompt。读完本文即可接手，不需要回溯此前的对话。
> 本文只讲**当前进度**与**接下来做什么**；机制细节一律指向已有文档，不在此重复。

---

## 0. 先做这件事

按顺序读这四份，别跳：

| 顺序 | 文件 | 为什么必读 |
|---|---|---|
| 1 | `CLAUDE.md` | 项目铁律：缩进跟随文件现状、全中文化、五条关键设计约束 |
| 2 | `docs/tui-prd.md` | **本阶段的需求定稿**。§4 是要实现的范围，§5.2 是验收标准 |
| 3 | `docs/decision-3-review-设计层.md` | 不含代码的机制讲解 + 术语表 + 已敲定的 D1–D8。§8 是 pi-tui 渲染能力查证结论 |
| 4 | `docs/decision-3-review.md` | 带行号的机制报告。**动代码前查这份**，§2.4.1 是本阶段的前置任务 |

补充查阅（按需）：

- `docs/design.md` —— 架构规范（同步语义、adapter、冲突策略）
- `docs/sync-mechanism.md` —— 三方比较判定表、基线写入规则的实现细节
- `docs/pi-extension-notes.md` —— Pi 扩展 API 能力（`ctx.ui` 各方法、事件、状态栏）
- `docs/v0.2.0.md` —— 决策记录总账，D1–D8 也在里面

---

## 1. 当前状态

**版本 0.2.0 已发布到 npm。** 之后在分支 `feat/tui-and-d9-cleanup` 上完成了
D9 清理与 autoSync 绕锁修复（均未发版）。

测试基线：`test:core` **397 passed | 1 skipped**、`test:e2e` 3 passed。
那个 skipped 是 root 环境下依赖 `chmod` 去写权限位的用例，**属正常**，别去"修"它。

### 已交付

| 项 | 内容 |
|---|---|
| `/pisync pull` | 智能化拉取，全程零询问（含包审批自动批准）—— v0.2.0 |
| `/pisync push` | 智能化推送，除冲突外零询问 —— v0.2.0 |
| 备份保留 | 固定 5 份，接入 apply 事务 —— v0.2.0 |
| D9 冲突收窄 | Git 冲突只给"交给 agent"/"我自己处理"两条出路，合并器已删除 |
| autoSync 绕锁 | 编排层重入自查 + 扩展层 `commandInFlight`，两层均有回归测试 |

---

## 2. 已敲定的设计（D1–D9，不要推翻重议）

这些是与用户逐轮访谈敲定的，`docs/v0.2.0.md` 决策 3 有完整表格。摘要：

| # | 决策 |
|---|---|
| D1 | `/pisync` 未配置 → **只配远端仓库、配完询问是否立即拉取**；已配置 → 进 TUI |
| D2 | "智能化拉取/推送" = 给现有 pull/push 流程**命名**，同步引擎零改动 |
| D3 | TUI 两级菜单：拉取{智能化, 以远端覆盖本机}、推送{智能化, 以本机覆盖远端} |
| D4 | **反黑盒**是 TUI 的验收标准：执行前知道将发生什么、执行后知道实际发生了什么 |
| D5 | **分工总纲**：TUI 反黑盒（保留审批与预览），直达命令要快（趋近零询问） |
| D6 | 初始化只配远端；尝试 pull 时发现远端为空则按当前机器生成初始清单（全自动） |
| D7 | 冲突是直达命令的唯一破例：push 遇冲突弹菜单，pull 自动远端优先 |
| D8 | 两个"覆盖"档 = **整机对齐**（丢弃一侧全部未推送改动），仅存在于 TUI，配二次确认 |
| D9 | **Git 冲突不由 pi-sync 解决**：只给"交给 agent"与"我自己处理"两条出路，删除逐文件 ours/theirs 与整体选边 |

**D5 是理解全局的钥匙**：TUI 和直达命令是**互补的两条路**，不是同一套标准。
同一个能力，TUI 里保留包审批与预览，直达命令里全部省掉——这是有意的，不是不一致。

**D9 是唯一的例外**：Git 冲突上两条路**用同一套规则**（只展示+转交），没有快慢之分。

---

## 3. 接下来要做什么

### 3.0 ~~D9 清理~~ 已完成

冲突菜单已收窄为两项："请 agent 解决冲突" / "停止 —— 我自己处理"。
Esc 取消等同于第二项。

已删除：`index.ts` 的三个选边分支、`commands.resolveConflict`、
`normalizeConflictChoices`、`src/orchestration/conflict-flow.ts`、
`src/system/conflict-resolution.ts`，以及 `ConflictPathChoices` /
`AutomaticConflictChoice` / `ConflictResolutionChoice` 三个类型。

**保留未动**：`applyCurrent` 的 `useRemoteForConflicts` /
`automaticConflictResolutionAttempted`——服务 pull 的语义层远端优先（D7），
与 git 合并器无关。

### 3.1 ~~前置任务：修 autoSync 绕锁~~ 已完成

两层守卫，覆盖的时段不同，缺一不可：

- **编排层**（根因）：`autoSyncOnce` 开头自查 `orchestrationLockHeld`，
  命中返回 `skipped/busy`。挡的是"同步真正在跑"的时段
- **扩展层**：`index.ts` 的 `commandInFlight` 标志，定时器回调命中即跳过本次 tick。
  挡的是命令处理器**等待用户输入**的时段（对话框、status/diff 全屏输出）——此时并不持锁

第二层对 TUI 尤其重要：常驻界面上用户可能长时间停在某一页，
此时 autoSync 落地会让屏幕上的计划/差异变成陈旧数据，随后指纹校验拒绝执行。

回归保护已验证（移除守卫即失败）：`test/autosync.test.ts` + `test/extension.test.ts`。

**TUI 实现时记得**：新增的 TUI 入口若不走 `pi.registerCommand` 的 handler，
要自己置位 `commandInFlight`。

### 3.2 主线任务：实现 TUI

需求见 `docs/tui-prd.md` §4。要点复述（细节以 PRD 为准）：

**菜单结构**（§4.1）：状态总览 + 拉取/推送各两档 + 查看差异 + 设置。

**两个"覆盖"档是破坏性操作**（§4.2），四条强制要求：
1. 执行前**列出将丢失的具体路径**，不能只报数量
2. 二次确认，**默认选项是取消**
3. 仍走落地前自动备份；本机有已提交内容时仍推设备恢复分支
4. **只存在于 TUI**，不给直达命令形态

**渲染方案已定**（§4.3），不用重新调研：

- 组装 pi-tui 现成组件，**不自绘引擎**。可用：`SelectList`（自带上下键导航/筛选/滚动）、`SettingsList`（`values[]` 循环切值、`submenu` 二级菜单）、`Container`/`Box`/`Text`
- `Component` 接口只要求 `render(width)` 返回字符串数组 + `invalidate()`，`handleInput` 可选
- 参考范本：Pi 包内 `examples/extensions/preset.ts`（SelectList 菜单，约 40 行）、`questionnaire.ts`（多步骤状态机）

**⚠️ 一条硬限制，设计时必须绕开**：
`custom()` 非浮层模式与 `ctx.ui.select()`/`confirm()`/`input()` **抢占同一个编辑器容器**。
在 TUI 内部调用对话框会**把 TUI 顶掉**，且对话框关闭后会恢复编辑器——TUI 就没了。
所以 TUI 必须做成**状态机式单组件**：一个 `custom()` 内部切页（菜单页/确认页/冲突提示页/结果页），
各页自行渲染（都是 SelectList 的变体）。

按 D9，**冲突提示页只做展示 + 两条出路**（不是合并器），所以它就是一个静态清单
加两项选择，实现量很小。

备选路：`custom({ overlay: true })` 走独立 overlay 通道不动编辑器容器，
**但浮层与对话框能否共存未验证**，仅在状态机方案遇阻时再探。

**非 TUI 模式**：`custom()` 返回 `undefined` 而非报错，所以必须显式判 `ctx.mode === "tui"`，
否则 TUI 路径会**静默失效**。

### 3.3 一并要做的：初始化流程改造（D6）

现状的初始化会顺带做首次捕获和一次落地。改成"只配远端就停"，然后问一句"现在拉取吗"。
"远端为空"在**尝试 pull 时**才判定，不在初始化阶段预先探测——这让首台机器与后续机器走同一条路径。

注意：`setup-flow.ts` **完全不接触 UI**，唯一的用户输入点是 Git URL，
走"先返回 needsGitUrl → 扩展层补输入 → 重跑"的三段式。改造时保持这个分层。

---

## 4. 独立待办（不阻塞 TUI，可随时捡）

| # | 问题 | 位置线索 |
|---|---|---|
| 1 | autoSync 靠**中文子串** `"已有同步操作"` 判"忙"，改文案会静默失效，且**无测试保护** | `commands.ts` `autoSyncOnce` |
| 2 | 变更类型汇总漏统计 3 类（含 2 种冲突），UI 不能依赖它判断冲突 | `inventory.ts` summary |
| 3 | 读不出的文件被静默当作"不存在"，可能误判为删除 | `inventory.ts` 枚举处 |
| 4 | 锁无时间阈值；pid 复用致永久持锁；EPERM 致误删他人锁 | `lock.ts` `isStale` |
| 5 | `pendingOperation` 的 `push-rebase-conflict` 只有读取者、无写入者（v2 迁移遗留） | `state.ts` |
| 6 | autoSync 的 `gitFetch` 在锁外执行 | `commands.ts` autoSync preflight |

细节与行号全在 `docs/decision-3-review.md` §5。

---

## 5. 工作方式约定

- **改代码前后都跑** `npm run typecheck && npm run test:core`，两者都绿才提交
- **缩进跟随文件现状**：多数文件用 Tab，但 `path-safety.ts`、`backup.ts`、`validate.ts` 用空格。
  单个文件内不得混用
- **面向用户的文字一律中文**；但**解析 git/npm/pi CLI 输出的匹配串必须保留英文**
  （`docs/v0.2.0.md` 决策 1 有约束表格，改了会静默失效）
- 测试的 `describe`/`it` 描述维持英文
- **测试不得触网**：装包相关用例要注入假 `pi` 可执行文件
  （`test/extension.test.ts` 与 `test/package-trust.test.ts` 有现成写法）。
  真 `pi install` 会打 npm registry，慢且会让超时看门狗误报
- commit 用 Conventional Commits 前缀 + 中文正文，按逻辑单元拆分
- 当前在 `main` 分支。**除非用户明确要求直接提交，否则先开分支**

### 发布流程的已知坑

`npm run pub` 会跑 `scripts/publish.mjs`。**npm 现在要求发布时过 2FA（EOTP）**，
非交互环境跑不通。两条出路：用户自己在终端 `npm publish`，
或者改用 **Granular Access Token**（绑定 `@xyzensun` scope，按新政策发布不再要 OTP）。
这一步需要用户的凭据，agent 无法代劳。

---

## 6. 建议的开场白

```
接手 pi-sync 的决策 3 第二阶段（TUI）。

已读 docs/handoff-tui.md。当前 v0.2.0 已发布，main 干净。

D9 清理与 autoSync 绕锁修复都已完成（见 §3.0 / §3.1）。
接下来按 tui-prd.md §4 实现 TUI，以及 D6 的初始化流程改造（§3.3）。

开始前我会先跑一遍 typecheck + test:core 确认基线。
```
