# pi-sync

通过私有 Git 仓库在多台机器间同步 Pi coding agent 配置的 Pi 扩展。
npm 包名 `@xyzensun/pi-sync`，分叉自 `@jachy/pi-git-sync` 0.7.1，现已独立演进。

## 目录结构

```
index.ts              扩展入口：注册 /pisync 命令、session_start 事件、autoSync 定时器、所有交互 UI
src/
  sync/               同步核心：清单解析、三方比较、capture/materialize、adapter 运行时
  orchestration/      流程编排：setup / pull / push / apply 事务、命令分派
  system/             系统设施：git 调用、state.json、备份、锁、包安装、路径安全
  extension/          Pi 扩展侧：状态栏、输出格式化、操作运行器
test/                 vitest 单测（e2e 在 test/e2e/，helpers 在 test/helpers/）
examples/             自定义 adapter 参考实现（json-sort-adapter.js）
scripts/              publish.mjs（npm 发布）、bootstrap.sh（新机器 curl 安装）、check-*.mjs
docs/                 见下方"何时读哪份文档"
```

## 技术栈与环境

- TypeScript + ESM，直接以 `.ts` 分发（`package.json` 的 `main` 与 `pi.extensions` 均指向 `index.ts`），**没有构建步骤**
- 运行时 Node >= 22.19.0；Pi 宿主 `@earendil-works/pi-coding-agent` 为 peerDependency
- 测试用 vitest；import 路径必须带 `.ts` 后缀（ESM 要求）
- 开发机是 root 环境：依赖 `chmod` 去写权限位来触发失败的用例在此恒不生效，已用 `it.skipIf(process.getuid?.() === 0)` 跳过，看到它被 skip 属正常

## 核心命令

```bash
npm run typecheck     # tsc --noEmit，改完代码必跑
npm run test:core     # 单测，排除 e2e，最常用
npm run test:e2e      # 双机同步端到端，较慢
npm run test:coverage # 单测 + 覆盖率门禁（test:ci 会跑，改动较大时本地先验）
npm test              # 全量
npm run pub           # 发布 patch 版本（会先跑 typecheck + test）
```

改动代码后至少跑 `npm run typecheck && npm run test:core`，两者都绿再提交。

## 编码约定

- **缩进跟随文件现状，不做跨文件统一**：本仓库继承自上游，风格本就不一致——多数文件用 Tab，但 `src/system/path-safety.ts`、`src/system/backup.ts`、`src/sync/validate.ts` 用空格。改动前先看该文件既有缩进并沿用。这一条覆盖全局规范中的"统一使用空格缩进"；但**单个文件内部不得 Tab 与空格混用**，该项与全局规范一致，不覆盖
- 面向使用者的一切文字用中文：TUI 提示、错误消息、进度输出、内部日志、代码注释。技术值（URL、路径、命令、文件名、包名）保留原文
- 测试的 `describe`/`it` 描述维持英文
- Git commit 保留 Conventional Commits 前缀，正文中文：`feat: 添加自动同步开关`

## 关键设计约束

改这些地方前先确认理解，它们是有意为之而非疏漏：

- **`include` 与 `special` 正交**：`include` 决定"哪些文件参与同步"（一律字节直传覆盖），`special` 决定"如何处理"（走 adapter）。不存在按文件名隐式启用 adapter 的逻辑，`settings.json` 也不例外
- **基线只在 apply 方向写入**：capture（push）方向绝不碰 `state.json` 的 `files`。push 完成后统一走 apply 收口，这是基线的唯一权威写入路径
- **无黑名单、无秘密扫描**：任何路径都能被 `include` 同步，安全边界由用户的清单把关。不要重新引入强制拒绝逻辑
- **包源便携性**：`packages[]` 中只有 `npm:`/`git:`/`https:`/`ssh:` 跨机同步；`file:` 等本机源推送时剥离、拉取时回填，永不触发 `pi install`
- **插件自排除**：pi-sync 自身安装目录与运行时数据目录 `.pi-sync/` 在 include 解析前被硬剔除，用户配置无法覆盖（`.pi-sync` 的 state 记录自身 hash，被同步会永久冲突死循环）

## 何时读哪份文档

- 要改同步语义、adapter 机制、冲突策略 → 先读 `docs/design.md`（架构规范，无行号，改代码不必同步更新）
- 要读懂三方比较判定表、基线写入规则、包安装链路的**具体实现** → `docs/sync-mechanism.md`（含行号，改到对应代码时要同步更新）
- 要用 Pi 的扩展 API（`ctx.ui` 各方法、事件、状态栏、包布局） → `docs/pi-extension-notes.md`
- 要确认某项行为是不是已定的决策 → `docs/v0.2.0.md`（决策记录，新决策追加到此）

## 提交前

工作区改动分逻辑单元提交，不要按文件拆碎。当前分支若为 `main`，除非用户明确要求直接提交，否则先开分支。
