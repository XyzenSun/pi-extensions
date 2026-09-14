# pi-sync

在每台机器上保持一致的 Pi 配置。

[![npm](https://img.shields.io/npm/v/@xyzensun/pi-sync)](https://www.npmjs.com/package/@xyzensun/pi-sync)

pi-sync 把 Pi 的配置存放在一个私有 Git 仓库里，并在多台机器之间同步。
架构说明见 `docs/design.md`。

```text
机器 A ── /pisync ──> 私有 Git 仓库 <── /pisync ── 机器 B
```

## 1. 快速开始

### 环境要求

- Pi `0.82.1` 或更高版本（Node.js `>=22.19.0`）
- 已安装 Git，并配置好 SSH 或 HTTPS 凭据

### 首台机器

1. 新建一个**空的私有仓库**（GitHub、Codeup 等均可）。**不要**勾选自动创建
   README —— 带初始文件的仓库不是空仓库，脚手架会拒绝接管。

2. 安装扩展：

   ```bash
   pi install npm:@xyzensun/pi-sync
   ```

3. 在 Pi 会话里运行 `/pisync`，按提示填入仓库地址。

### 其他机器

安装同一个扩展，运行 `/pisync`，填入**相同的仓库地址**即可。

> **从上游迁移**：如果这台机器上装过 `@jachy/pi-git-sync`，请先执行
> `pi remove npm:@jachy/pi-git-sync` 卸载。两个扩展都会注册 `/pisync`
> 命令，同时存在会被 Pi 重命名成 `/pisync1`、`/pisync2`。
> 另外记得把配置仓库里 `sync/settings.json` 的 `packages` 字段
> 从旧包名改成 `npm:@xyzensun/pi-sync`，否则同步会把旧包装回其他机器。

### 版本说明

`0.1.0` 是本包的首个版本，从 `@jachy/pi-git-sync` 0.7.1 分叉而来，
公开命令、`pi-sync.json` schema v2、状态 schema v3 与上游兼容。

涉及重大影响的同步操作需要交互式 Pi 界面确认；非交互式会话会直接停止，
不产生任何副作用。

本项目是个人维护的分叉，供私有多设备场景使用。反馈问题时，请勿附带任何
凭据、令牌、仓库地址或已同步的文件内容。

---

😄 **以上步骤即可完成多机同步，后面都是更详细的说明，可以跳过。**

---

### 日常使用

| 命令 | 用途 |
| --- | --- |
| `/pisync` | 打开面板（TUI）；未初始化时走初始化流程 |
| `/pisync pull` | 智能化拉取：零询问，冲突自动以远端为准 |
| `/pisync push` | 智能化推送：除 Git 冲突外零询问 |
| `/pisync status` | 查看 Git 状态与三方比较结果 |
| `/pisync diff` | 预览待同步的差异 |

**面板与直达命令是互补的两条路**：面板负责看清楚，直达命令负责快。

```text
/pisync
├── 智能化拉取        只拉取；保留包审批
├── 以远端覆盖本机     整机对齐（破坏性）
├── 智能化推送        只推送；保留包审批
├── 以本机覆盖远端     整机对齐（破坏性）
├── 查看差异
├── 设置：自动同步
└── 退出
```

顶部常驻状态总览（分支、待推送/待拉取、待同步变更数、冲突数、autoSync 开关）。
每个动作执行前告诉你将发生什么，执行后告诉你实际发生了什么。

两个"覆盖"档是**整机对齐**，只在面板里提供，没有直达命令形态：

| 档位 | 语义 |
| --- | --- |
| 以远端覆盖本机 | 丢弃本机全部未推送改动，本机变成远端当前的样子 |
| 以本机覆盖远端 | 远端变成本机当前的样子，含删除远端独有的文件 |

它们执行前会**逐条列出将被丢弃的具体路径**，二次确认默认停在"取消"。
删除是彻底的，不受 `delete: "none"` 约束——整机对齐的语义就是两边完全一致。
落地前仍自动备份，本机有已提交内容时仍推设备恢复分支。

改动 Pi 配置后运行 `/pisync` 即可。运行过程中按 `Esc` 可中断，并终止其
Git/SSH 子进程。非 TUI 会话（`-p`、rpc、json）下 `/pisync` 退回对话框流程。

### 同步范围

| 内容 | 行为 |
| --- | --- |
| 扩展、技能、提示词、主题 | 从 `sync/` 下的对应目录同步 |
| `settings.json` | 通过内置 `settings` adapter 做白名单投影同步（需在 `special` 中声明） |
| `models.json` 及其他文件 | 纳入 `include` 后按字节整文件同步（`direct`） |
| `auth.json`、`sessions/**` 等 | **只有你显式写进 `include` 才会同步** —— 本项目没有强制黑名单 |
| `AGENTS.md`、`SYSTEM.md`、`APPEND_SYSTEM.md`、`keybindings.json` | 复制到 Pi agent 目录 |
| 第三方包 | 在 `settings.json` 中声明；新增或变更的包源需要逐项确认是否安装 |

pi-sync 没有内置黑名单，也不做秘密扫描。一个文件
是否被同步，**完全由你的 `include`/`exclude` 清单决定**。凡是你放进白名单的
内容 —— 包括 `auth.json` 或本地 `.env` —— 都会原样进入你的私有仓库。
`node_modules` 也只有写进 `exclude` 才会被排除。

> ⚠️ 没有兜底黑名单意味着风险由你自己把关。以下路径默认不在 `include` 中，
> 纳入前请确认目标仓库确实是私有的，并且清楚这些内容会进入 Git 历史 —— 历史一旦
> 推送就难以彻底清除：
> `auth.json` `models-store.json` `trust.json` `sessions/**` `npm/**` `git/**`
> `node_modules/**` `**/.env` `**/*.pem` `**/id_rsa` `**/id_ed25519`

### settings.json 的白名单 adapter

脚手架生成的 `pi-sync.json` 里带有 `"special": { "settings.json": "settings" }`，
它让 `settings.json` 走内置的 `settings` adapter。该 adapter 只同步与设备
无关的偏好字段（主题、provider/模型、重试、压缩、`packages` 等）。设备本地的
键（`trackingId`、`sessionDir`、`lastChangelogVersion` 等）留在各自机器上，
不会产生跨设备冲突。

`packages` 中指向本机路径的 `file:` 类包源，在推送前会被剥离、拉取时再合并
回本机，因此本地开发中的扩展不会污染共享仓库。

**adapter 是按路径显式启用的**：只写在 `include` 而没有 `special` 声明的文件，
一律按字节整体覆盖 —— **`settings.json` 也不例外**。如果你移除它的 `special`
声明，拉取时本机的整个 `settings.json` 都会被仓库版本覆盖。

通过 `pi install npm:…` / `pi install git:…` 安装的包，是以可移植的
`settings.json` 声明形式同步的，不会复制 `npm/` 或 `git/` 目录。包源经确认后，
由目标设备在本地执行 `pi install`。

在应用变更前，`/pisync` 会把 `extensions/**` 的改动和包声明归类成一份扩展计划。
你可以逐项选择：安装、清理残留文件、应用共享扩展、推迟到下次同步、分享本地扩展、
或仅保留在当前设备。被推迟的选择会保持待处理状态，下次 `/pisync` 时再次询问。

隐藏文件默认排除（`.gitignore` 除外）。符号链接永远不会被跟随。

## 2. 深入了解

### 同步模型

```text
agent 文件
   │
   ├─ 捕获并提交本地改动
   ├─ 拉取所配置的分支
   ├─ 变基本地提交，或快进纯远端改动
   ├─ 把结果配置应用到 Pi
   └─ 推送共享分支与本设备的恢复分支
```

任一步骤失败都会中止本次运行。手动 pull 时以仓库为权威（远端优先）：
远端改动会被应用，同一路径上未推送的本地改动会被丢弃。

### 仓库与配置

仓库会被克隆到本地：

```text
~/.pi/config-repo/
├── pi-sync.json       # 同步配置
└── sync/              # 被同步的 Pi 文件
    ├── settings.json
    ├── extensions/
    ├── skills/
    ├── prompts/
    └── themes/
```

`~/.pi/config-repo/pi-sync.json` 默认内容：

```json
{
  "schemaVersion": 2,
  "branch": "main",
  "root": "sync",
  "include": [
    "settings.json",
    "AGENTS.md",
    "SYSTEM.md",
    "APPEND_SYSTEM.md",
    "keybindings.json",
    "extensions/**",
    "skills/**",
    "prompts/**",
    "themes/**"
  ],
  "exclude": [
    "**/.DS_Store",
    "**/*.tmp",
    "**/*.log",
    "extensions/pi-sync/**",
    "extensions/**/.cache/**",
    "extensions/**/cache/**",
    "extensions/**/coverage/**",
    "extensions/**/logs/**",
    "extensions/**/temp/**",
    "extensions/**/tmp/**"
  ],
  "delete": "tracked",
  "pullTimeoutMs": 10000,
  "special": { "settings.json": "settings" },
  "autoSync": { "enabled": false, "intervalMinutes": 30 }
}
```

- **过滤优先级**：`exclude` > `include`。没有内置的强制黑名单。
- **`special`**：把路径映射到 adapter，取值为 `"direct"`、内置 adapter 名
  （`"settings"`），或用户自定义 adapter `"./my-adapter.js"`（相对 `pi-sync.json`
  所在目录）。用户 adapter 优先于内置；未实现的方向自动退化为字节直传。

  用户 adapter 路径**必须留在配置仓库内**：清单加载时会拒绝含 `..` 的路径；
  不以 `./` 开头的值（含绝对路径）不会被当作用户 adapter。
  源码仓库的 `examples/json-sort-adapter.js` 是一个可直接参考的完整示例。
- **`autoSync`**：开启后静默执行单向拉取。以仓库为权威，仅当
  本机没有未推送改动时才应用；它永远不会自动推送，也不会在其他同步持锁时运行。
- **`delete: "tracked"`**：只对已纳入基线管理的文件传播删除；`"none"` 则完全
  不传播删除。
- **`pullTimeoutMs`**：控制每次 pull、fetch、rebase 操作的超时。一次完整的
  `/pisync` 运行超过 60 秒会停止。

### 冲突与安全

pi-sync 扩展**永远不会同步自己**：它的安装目录在解析 `include` 之前就被剔除，
无论你怎么配置 `include` 都不会被捕获。

手动 pull 时以仓库为准：当远端和本机改了同一个文件，远端内容会被应用，本机
未推送的改动会被丢弃。

被覆盖的内容并非无法找回 —— 变基冲突场景下本机提交会保存到设备恢复分支；
每次应用前也会自动创建备份（`.pi-sync/backups/`，保留最近 5 份）。
推送冲突仍保留设备恢复分支。

**Git 冲突不由 pi-sync 解决。** 遇到 Git 层冲突时只给两条出路：

| 选项 | 行为 |
| --- | --- |
| 请 agent 解决冲突 | 把一份带约束的合并任务投递给 Pi agent，完成后提示你重跑 `/pisync` |
| 停止 —— 我自己处理 | 打印手动步骤与设备恢复分支名，不做任何自动处理 |

按 `Esc` 等同于第二项。pi-sync 不提供逐文件选 ours/theirs 之类的"半自动
合并"——那只是给 git 命令包了层界面，既不如 AI 理解内容语义，也不如你自己
操作透明。注意这与手动 pull 的"冲突以远端为准"是两回事，后者是三方比较层
的裁决，不涉及 git 合并。

### 开发

```bash
# 本地加载，然后在 Pi 中执行 /reload
ln -s $(pwd) ~/.pi/agent/extensions/pi-sync

# 或临时加载
pi -e ./index.ts
```

```bash
npm install
npm test           # 完整测试套件，含 E2E
npm run test:core  # 核心测试，不含 E2E
npm run test:e2e   # 双机 E2E 测试
npm run test:smoke # 快速的 glob 与 UI 检查
npm run test:ci    # 类型检查 + 覆盖率门禁 + E2E
```

升级扩展后，先运行 `/pisync status` 确认状态，再运行 `/pisync`。

## 许可证

MIT
