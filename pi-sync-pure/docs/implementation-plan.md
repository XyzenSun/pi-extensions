# pi-sync-pure 实现计划

本文档记录实现层面的模块划分、旧版复用策略与步骤顺序，是给实现者的施工图。架构决策 (是什么、为什么) 见 `design.md`，本文只讲怎么做；两者冲突时以 `design.md` 为准。

## 模块结构

```text
pi-sync-pure/
├── index.ts              # 入口: 注册 /pisync 命令, 检测初始化状态分发流程
├── package.json          # @xyzensun/pi-sync-pure, 遵循仓库根层插件约定
├── README.md             # 面向用户的用法说明
├── src/
│   ├── config.ts         # pi-sync.json 解析/校验/默认值 + 本地状态文件读写
│   ├── device-id.ts      # 平台机器 UUID 获取 (machine-id/MachineGuid/IOPlatformUUID) + 短哈希 + 随机退化
│   ├── git.ts            # git 命令封装: fetch/push -f/reset --hard/merge (-X ours|theirs)/branch -m 等
│   ├── glob.ts           # include/exclude 过滤引擎 (从旧版复用)
│   ├── capture.ts        # agent → repo 镜像 (简化重写)
│   ├── materialize.ts    # repo → agent 镜像 (简化重写)
│   ├── adapters.ts       # special 路由 + 内置 settings adapter + 用户自定义 adapter 加载
│   ├── operations.ts     # 8 个子命令的编排, 每个操作 = git 序列 + capture/materialize 的组合
│   ├── commands.ts       # 子命令解析 (push/pull/publish/align/merge-up/merge-down/remote/rename/status)
│   └── ui.ts             # 交互选择器/输入框/确认弹窗; 非交互会话全部短路
```

## 旧版复用策略

旧版源码在 `../pi-sync/src/`，逐个文件判断：

- `sync/glob.ts` 基本独立，直接搬。它自带的行为约定一并保留: 隐藏文件默认排除 (`.gitignore` 除外)，符号链接不跟随，exclude 优先于 include。
- `sync/settings-adapter.ts` 的白名单字段清单与双向投影逻辑是核心资产，搬；但它依赖 `adapter-runtime.ts` 的类型，需先简化 adapter-runtime: 只保留 `transformToRepository` / `transformToLocal` / `validate` 三个方向接口，砍掉 `normalizeForComparisonWithAdapter` 等三方比较专用接口。
- `sync/config.ts` 的 schema 解析与校验可搬，字段裁剪: 保留 include/exclude/special/autoSync/schemaVersion，砍掉 branch (main 固定)、root (固定 sync/)、delete、pullTimeoutMs、以及旧版状态相关字段。
- 其余全部重写，不要参考: capture/materialize 旧版掺了三方比较与基线检测，orchestration/system/extension 目录整体不搬。

## capture 与 materialize 的简化语义

这是新版与旧版行为差异最大的地方，实现时严格按以下语义:

capture (agent → repo) 是无条件镜像: 按 glob 扫描 agent 目录，命中文件按相对路径复制进 repo 的 `sync/`；agent 中已删除的已管理文件在 repo 中同步删除；special 声明的文件交给 adapter 的 `transformToRepository`，其余字节直传。不做基线对比、不做冲突检测、不询问任何问题。capture 只改仓库工作区，不 commit。

materialize (repo → agent) 同理反向: `sync/` 内容镜像回 agent 目录，传播删除，special 文件走 `transformToLocal` (settings adapter 负责保留 trackingId、sessionDir 等设备本地键)。

## 各操作对应的 git 序列

实现 operations.ts 时每条操作就是一个固定序列，不要加额外步骤:

| 操作 | 序列 |
| --- | --- |
| push | capture → `git add -A` → commit (空改动则跳过并提示) → `push -f origin HEAD` |
| pull [分支] | `fetch origin` → (指定分支时先 checkout 该分支) → `reset --hard origin/<设备分支>` → materialize |
| publish | capture → commit → `push -f origin HEAD:main` (main 不存在则由此创建) |
| align | `fetch origin` → `reset --hard origin/main` → materialize |
| merge-up | capture → commit → `checkout main` (本地无则 `checkout -b main origin/main`) → `merge <设备分支>` (可选 `-X ours`/`-X theirs`，默认冲突即 abort 并保持原状) → `push origin main` → `checkout <设备分支>` |
| merge-down | `fetch origin` → `merge origin/main` (可选 `-X theirs`/`-X ours`，默认冲突即 abort) → 无冲突则 materialize |
| remote <url> | 记录旧 url → `remote set-url origin <新>` → `fetch origin` 验证 → 失败则回滚 set-url 并报错 |
| rename <新名> | `branch -m <旧> <新>` → `push -f origin <新>` → 旧远端分支保留 → 更新状态文件 |
| status | `git status` + ahead/behind (`rev-list --left-right --count`) 的薄包装 |

merge 冲突即停时输出冲突文件清单，提示用户处理后重试或换用带覆盖参数的形式。所有操作执行前 `fetch`，autoSync 除外 (它本身就是 merge-down)。

## 实现步骤

1. 脚手架: package.json、index.ts 骨架、tsconfig。
2. 基础层: git.ts、device-id.ts、config.ts (含状态文件 `~/.pi/agent/pi-sync-pure.json`)。
3. 搬运层: glob.ts (复用)、adapters.ts (复用+简化)、capture.ts、materialize.ts。
4. operations.ts: 按上表实现 8 操作 + status。
5. 初始化流程: 检测 `~/.pi/config-repo/` 不存在 → 输入设备名 (默认 device-id) → clone → 远端有 `device/*` 时列出认领 → capture + commit + push -f；以及 remote/rename 两个管理操作。
6. commands.ts + ui.ts: 交互会话弹选择器，force 系 (pull/align/publish) 确认默认取消；非交互直接执行子命令，`/pisync` 无参数打印用法。pi 扩展 API 参考 `../docs/extensions.md`。
7. autoSync: 定时器 + merge-down --theirs，仅本机 `git status --porcelain` 为空时执行。
8. 文档与发布: README.md、`.github/workflows/pi-sync-pure.yml` (手动触发)、根 README.md 插件清单加一行。

> 注: 实施后根据用户决定移除了 vitest 测试与 Test 步骤, CI 门禁仅保留 typecheck。

## 验收清单

- 8 个子命令 + status + 初始化 + autoSync 全部可用，行为与 `design.md` 操作语义表一致。
- 非交互会话 (pi -p) 不弹任何 UI；交互会话 force 系有一步确认。
- `pi -e ./pi-sync-pure/index.ts` 加载无报错。
- typecheck 通过。
- 根 README.md 插件清单已更新，workflow 文件就位 (不执行发布)。
