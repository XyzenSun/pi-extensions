# pi-sync-pure 说明

本目录是 pi-sync 插件的彻底重写版 (pure 版)。旧版 pi-sync 以三方比较引擎为核心，复杂度高、维护成本大；本插件放弃三方比较，把所有同步语义退化为 git 原语 (force 覆盖与 merge)，用分支结构天然表达多设备关系。架构决策的完整记录见 `docs/design.md`，动手改代码前必读，尤其是"操作语义"与"明确不做的事"两节——那里写明了哪些旧版功能被有意砍掉，不要在开发中顺手加回来。

## 目录结构

```
pi-sync-pure/
├── AGENTS.md        # 本文件
├── docs/
│   └── design.md    # 架构设计文档 (访谈共识的沉淀, 改代码前必读)
├── index.ts         # 插件入口, export default function (pi: ExtensionAPI)
├── package.json     # npm 包定义 (@xyzensun/pi-sync-pure)
├── README.md        # 面向用户的功能说明与用法
└── src/             # TS 源码 (git 操作, capture/materialize, glob, adapter, 命令, UI)
```

发布产物即 TS 源码，零构建流程，遵循仓库根层 AGENTS.md 的插件约定。

## 核心设计约束

这些约束是设计访谈中与用户逐条敲定的，属于本插件的立身之本，修改任何一条前必须先与用户确认：

- 每台设备一个独立分支，分支名完全由用户决定 (推荐 `device/<名称>` 前缀习惯，插件不做任何改写)，本地 repo 的 HEAD 永远停留在设备分支上；main 只是远端汇聚点，本地不长期驻留 main。
- 分支名不含哈希后缀。设备名的唯一性由用户自己保证，插件不做防撞机制；重装后的找回依赖初始化时的分支认领流程与 `recover <分支名>` 显式指定。
- 对设备分支的一切操作都是 force 语义 (`push -f` / `reset --hard`)。设备分支的含义就是"本机现状的镜像"，force 不会丢失其他设备的数据，因此无需分叉检测。
- 不做三方比较、变基、自动备份、恢复分支、包审批与自动安装。冲突安全网完全交给 git 本身：分支历史即备份。同步完成后仅提示用户可运行 `pi update --extensions` 安装 packages 声明的包，插件自身绝不执行 `pi install`。
- 交互式会话中 force 系操作 (recover / align / publish) 执行前弹一步确认，默认停在取消；非交互式会话不弹任何确认，子命令即明确意图，直接执行。

## 开发与验证

本地加载测试: `pi -e ./pi-sync-pure/index.ts`，改动后在 pi 中执行 `/reload` 再验证。类型检查: `cd pi-sync-pure && npm run typecheck`。

本项目不维护自动化测试，验证方式为 typecheck 加 `pi -e` 手动验证；改动 git 序列时在临时目录手工搭建 fixture 验证，不得触碰真实的 `~/.pi/config-repo/` 与 `~/.pi/agent/`。

发布通过 `.github/workflows/pi-sync-pure.yml` 手动触发，不在本地执行 npm publish；触发前确认 package.json 的 version 已更新。
