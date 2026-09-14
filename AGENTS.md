# pi-extensions 仓库说明

本仓库存储本人开发的 pi 插件 (extensions) 源码。每个一级子目录是一个独立插件包，通过 GitHub Action 手动触发发布到 npm。

## 目录结构

```
pi-extensions/
├── AGENTS.md            # 本文件
├── README.md            # 仓库简介与插件清单
├── LICENSE              # MIT
├── .gitignore           # 根级排除规则 (node_modules/ 等)
├── .github/workflows/   # 各插件的发布 workflow，均为手动触发 (workflow_dispatch)
├── docs/                # pi 官方文档快照，插件开发参考
└── <plugin-name>/       # 每个一级子目录 = 一个独立插件包
    ├── package.json     # npm 包定义 (包名、pi manifest、依赖声明)
    ├── README.md        # 该插件的功能说明与用法
    └── *.ts             # TS 源码，即最终发布产物
```

## 核心约定

- 各插件子目录完全独立，自带各自的 package.json 与依赖声明；根目录仅存放 AGENTS.md、README.md、LICENSE、.gitignore、.github/ 与 docs/，不放置 package.json。
- 仓库内容以插件源码为限，node_modules/ 等非源码内容一律通过 .gitignore 排除，提交前确认未被误加。
- 新增插件时必须同步更新根 README.md 的插件清单 (插件名与一句话功能说明)。
- 发布一律通过 GitHub 上手动触发对应插件的 workflow 完成，不要在本地执行 npm publish 等发布命令。需要发布时，先确认该插件 package.json 的 version 已更新，再提醒用户到 GitHub 手动触发。
- 新增插件若需发布，需在 .github/workflows/ 中为其添加独立的手动发布任务，具体形式与用户确认后再动手。

## 插件开发规范

- 插件为 TypeScript 模块，默认入口导出 `export default function (pi: ExtensionAPI)`。
- package.json 必须包含:
  - `"type": "module"`，与 ESM TS 源码保持一致；
  - `"keywords": ["pi-package"]`，便于被 pi package gallery 收录发现；
  - `pi` manifest，明确指向入口文件，单一 extension 的插件通常为 `"pi": { "extensions": ["./index.ts"] }`；
  - 包名统一使用 `@xyzensun/pi-xxx` scope 命名，发布时需 `--access public` (由 workflow 处理)。
- 依赖声明:
  - pi 核心包 (`@earendil-works/pi-coding-agent`、`typebox` 等) 放 `peerDependencies`，版本为 `"*"`；
  - 运行时第三方依赖放 `dependencies`。
- 发布产物即 TS 源码: pi 原生加载 .ts 文件，保持零构建流程，新增插件时同样遵循此约定。
- 本地快速验证插件: `pi -e ./<plugin-name>/index.ts` 临时加载测试。

## 参考文档
本仓库`doc`目录中记录了一些必要的开发文档。
本仓库 `docs/extensions.md` (扩展 API、事件、ExtensionContext) 与 `docs/packages.md` (pi manifest、依赖声明规则)。docs/ 为 pi 0.85.1 的官方文档快照，pi 升级后需重新同步；其中指向 `../examples/` 的链接是本仓库未包含的官方示例代码，需要时可查看 pi 安装目录下的 examples/ (`npm root -g` 定位到 `@earendil-works/pi-coding-agent/`)。
