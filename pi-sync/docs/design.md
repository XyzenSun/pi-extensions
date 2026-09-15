# pi-sync 架构设计

> 本文定义 pi-sync 的架构规范：同步模型、adapter 机制、冲突策略、自动同步、安全边界。
> 实现细节与代码行号见 `docs/sync-mechanism.md`；版本决策记录见 `docs/v0.2.0.md`。

---

## 0. 三层同步模型

```
pi-sync.json（清单，位于 config-repo 根）
  include: []        # 准入：哪些文件参与同步。git 仓库为权威，按字节直接覆盖
  exclude: []        # 排除，优先级高于 include
  special: {}        # 处理：路径 → adapter。只有声明在此的文件才做语义化转换
```

- **include 的文件**：仓库为权威，整文件字节覆盖，不读本机内容
- **special 的文件**：经 adapter 做三向转换（推送 / 拉取 / 比较）
- **无黑名单、无秘密扫描**：任何路径都可 include，是否同步完全由用户把关
- **`include` 与 `special` 正交**：在 `special` 里但不在 `include` 里的文件不同步；在 `include` 里但不在 `special` 里的文件按字节处理，**`settings.json` 也不例外**——不存在按文件名隐式启用的 adapter

### 0.1 三方比较

每个候选文件有三个状态：B（baseline，`state.json` 记录的上次同步 hash）、L（本机文件）、R（仓库工作区文件）。比较结果决定该文件是 capture（L→R）、apply（R→L）、无操作还是冲突。完整判定表见 `sync-mechanism.md §2`。

### 0.2 不同步的内容

以下文件默认不在 include 中，是否纳入由用户自行决定：

`auth.json` `models-store.json` `trust.json` `sessions/**` `npm/**` `git/**` `node_modules/**` `**/.env` `**/*.pem` `**/id_rsa` `**/id_ed25519`

纳入前需确认目标仓库确实私有，并理解内容一旦推送即进入 Git 历史。

---

## 1. Adapter 机制

### 1.1 接口

```ts
interface FileAdapter {
  /** 推送：本机内容 → 仓库内容（剥离设备相关/隐私） */
  toRepository?(local: Buffer, ctx: AdapterContext): Buffer | Promise<Buffer>;
  /** 拉取：仓库内容 → 本机内容（回填设备相关字段） */
  toLocal?(repo: Buffer, local: Buffer, ctx: AdapterContext): Buffer | Promise<Buffer>;
  /** 比较：规范化后内容，用于三方 hash（设备差异不产生假冲突） */
  normalizeForComparison?(content: Buffer, ctx: AdapterContext): Buffer | Promise<Buffer>;
}
interface AdapterContext {
  agentDir: string;   // ~/.pi/agent
  repoPath: string;   // config-repo 本地路径
  filePath: string;   // 相对路径，如 settings.json
}
```

三个方法均可省略，省略的方向退化为字节直传。

### 1.2 声明与解析

`special[path]` 取值：
- `"direct"` —— 显式声明字节直传（与只在 include 中等价）
- 内置 adapter 名，如 `"settings"`
- `"./my-adapter.js"` —— 用户 adapter，相对 `pi-sync.json` 所在目录
- 对象形式 `{ "adapter": "..." }`，语义同上

规则：
- 用户 adapter 路径**必须留在 config-repo 内**：含 `..` 段的路径在清单加载时拒绝；不以 `./` 开头的值（含绝对路径）不视为用户文件，按内置名解析，未知即拒绝。理由：`pi-sync.json` 会同步到所有设备，一份清单不能让另一台机器执行仓库外的任意 JS
- 用户 adapter 优先于内置：同名时用户显式路径覆盖
- adapter 是用户代码，同步时被执行，等同本地脚本，信任责任在用户

### 1.3 内置 adapter

| 名称 | 适用 | 说明 |
|---|---|---|
| `settings` | `settings.json` | 字段白名单投影 + 便携包源过滤（§2） |

未来的特殊文件处理（如 `models.json` 的 baseUrl 环境变量化）都作为新内置 adapter 增量加入，不动核心。

---

## 2. 内置 `settings` adapter

启用方式：`special["settings.json"] = "settings"`（脚手架默认已声明）。

### 2.1 三向行为

| 方向 | 行为 |
|---|---|
| `toRepository` | 只保留白名单内顶层键；`packages[]` 中剥离非便携源 |
| `toLocal` | 仓库覆盖白名单内键；保留本机白名单外键原值；本机独有的非便携包源回填 |
| `normalizeForComparison` | 白名单投影 + 剥离非便携包 + 递归键排序后求 hash |

### 2.2 白名单（设备无关偏好）

`defaultProvider` `defaultModel` `defaultThinkingLevel` `thinkingBudgets` `theme` `retry` `compaction` `branchSummary` `warnings` `transport` `steeringMode` `followUpMode` `httpIdleTimeoutMs` `websocketConnectTimeoutMs` `enabledModels` `defaultTools` `doubleEscapeAction` `treeFilterMode` `editorPaddingX` `outputPad` `autocompleteMaxVisible` `showHardwareCursor` `markdown` `terminal` `images` `tuiMode` `fullscreenExitOutput` `fullscreenScrollbar` `packages`

白名单外顶层键（含 Pi 未来新增字段）不进仓库、不被覆盖、不参与比较。典型的设备相关键：`lastChangelogVersion` `trackingId` `sessionDir` `shellPath` `npmCommand` `externalEditor` `httpProxy` `extensions` `skills` `prompts` `themes`。

字段语义依据 Pi `settings-manager.d.ts` 的 `Settings` 接口判定；Pi 升级新增字段后，由维护者决定是否加入白名单。

### 2.3 便携包源

`packages[]` 中只有以下前缀可跨机同步：`npm:` `git:` `https://` `ssh://`。

`file:`、相对路径、绝对路径、`~/` 开头的源是本机私有：推送时剥离，拉取时回填，永不触发 `pi install`/`pi remove`。

---

## 3. 包与扩展

Pi 有两种扩展形态，pi-sync 分别处理：

| 形态 | pi-sync 处理 |
|---|---|
| 目录扩展（`extensions/<name>/*.ts`） | 普通文件，走 `include: extensions/**` 按字节同步 |
| 包扩展（`pi install npm:/git:`） | 不同步安装目录，只同步 `settings.json` 的 `packages[]` 声明，目标机自行 `pi install` |

### 3.1 包审批

远程 `packages[]` 是数据，不是执行代码的许可。新增或变更的包源在安装前需要显式批准：
- 内置可信源 `npm:@xyzensun/pi-sync` 免审
- 已批准并选择"记住"的源记录在本机 `.pi-sync/package-trust.json`，下次免审
- "记住"只在全部安装成功后才写入，失败不扩大信任
- 安装失败回滚已装的包，并回滚本次 apply 写入的文件

### 3.2 插件自排除

pi-sync 自身永不参与同步：
- 脚手架默认 exclude `extensions/pi-sync/**`
- 代码在 include 解析前额外剔除自身安装目录与运行时数据目录 `.pi-sync/`（硬排除，用户配置无法覆盖；`.pi-sync` 的 state 记录自身 hash，被同步会造成永久冲突死循环）
- 清单 `pi-sync.json` 在 `sync/` 镜像之外，天然不同步
- 包计划中 `npm:@xyzensun/pi-sync` 排除在 added/changed/removed 之外

---

## 4. 冲突策略

### 4.1 冲突定义

`both_modified`（两端都改且内容不同）、`local_modified_remote_deleted`、`local_deleted_remote_modified` 三种。

### 4.2 手动 pull：远端优先

冲突路径以仓库内容覆盖本机，本机未推送改动丢弃。三个入口语义一致：
- pull 前 capture 检测到双侧修改 → 冲突路径记为远端优先
- rebase 本机提交时产生 git 冲突 → 本机提交先保存到设备恢复分支，主分支重置为远端
- apply 阶段三方比较出现冲突 → 同一 apply 内以远端优先重试一次

被覆盖的内容可找回：设备恢复分支 + apply 前自动备份（`.pi-sync/backups/`）。

### 4.3 push 冲突：交互决策

推送遇到远端更新导致 rebase 冲突时，进入交互菜单：交给 agent 处理 / 中止 / 逐文件选择 / 全用本机 / 全用远端。设备恢复分支始终保留。

---

## 5. 自动同步（autoSync）

```json
{ "autoSync": { "enabled": false, "intervalMinutes": 30 } }
```

- 默认关闭；`intervalMinutes` 最小 5
- **单向**：只从仓库拉取到本机，永不自动 push
- **前提**：R≠B（仓库有更新）且 L≈B（本机无未推送漂移）才静默 apply
- 本机有漂移、离线、需交互（包审批、冲突）→ 跳过本次，等手动 `/pisync`
- 与手动同步共用锁，不并发

---

## 6. 状态与存储

| 数据 | 位置 |
|---|---|
| Git 远端 URL | `<config-repo>/.git/config`（git 自身管理，pi-sync 不另存） |
| 本地克隆路径 `repoPath` | `state.json` |
| 同步基线 `files` | `state.json` |
| 包信任记录 | `.pi-sync/package-trust.json` |
| 备份 | `.pi-sync/backups/` |

`.pi-sync/` 物理位置在 `<config-repo>/.pi-sync/`（gitignored），`~/.pi/agent/.pi-sync` 是指向它的符号链接。

`state.json` 丢失时，若仓库在默认路径 `~/.pi/config-repo`，可从 `git remote get-url origin` 恢复；非默认路径无自动恢复。

---

## 7. 风险边界

| 项 | 说明 |
|---|---|
| 无黑名单 | `auth.json`、`.env`、私钥等被 include 即同步，用户自行把关 |
| 明文凭据进 git 历史 | `models.json` 若含 apiKey 且被 include，历史不可删 |
| adapter 是用户代码 | 自定义 adapter 在同步时执行，仅信任自己写的 |
| 远端优先会丢改动 | 手动 pull 冲突时本机改动被覆盖，靠备份和恢复分支找回 |
