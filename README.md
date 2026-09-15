# pi-extensions

Xyzen 开发并开源的 [pi](https://pi.dev) 扩展插件合集。每个一级子目录是一个完全独立的插件包，各自发布到 npm，发布通过 GitHub Actions 手动触发。

## 插件清单

| 插件 | 功能 | 安装 |
|------|------|------|
| [pi-notify](./pi-notify) | ntfy 推送通知：任务完成、等待输入或出错时推送到手机，结构化消息体，global / session / mute 三层控制，本地、VM、无头服务器均可用 | `pi install npm:@xyzensun/pi-notify` |
| [pi-sync](./pi-sync) | 通过私有 Git 仓库在多台机器间同步 Pi 配置，基于适配器处理特殊文件，架构说明见其 `docs/design.md` | `pi install npm:@xyzensun/pi-sync` |
| [pi-mctx](./pi-mctx) | 手动上下文管理：`/mctx new` 蒸馏会话为 kickoff prompt 换新会话；`/mctx sink` 把用完的工具结果移出上下文（无损 obs 读回），设计见其 `docs/design.md` | `pi install npm:@xyzensun/pi-mctx` |

## 开发说明

- 插件为 TypeScript 源码，直接发布，零构建流程。
- 本地临时加载验证：`pi -e ./<plugin-name>`（各插件入口以其 README 为准）。
- 开发参考文档见 [docs/](./docs/)，为 pi 0.85.1 官方文档快照。

## License

[MIT](./LICENSE)
