# @xyzensun/pi-notify

[pi](https://pi.dev) 的 ntfy 推送通知扩展 — 任务完成、需要输入、出错时推送到手机，正文结构化（会话名/会话 ID/时间/用户提问/AI 回复）。适用于本机、虚拟机、服务器等任何能访问 ntfy 服务器的场景。三层控制：全局 / 会话 / 勿扰。

> 基于 [ryanchan720/pi-desktop-notify](https://github.com/ryanchan720/pi-desktop-notify) 修改，原项目采用 MIT 许可

## 安装

```bash
pi install npm:@xyzensun/pi-notify
```

手机端安装 [ntfy](https://ntfy.sh) App（或自建服务器），订阅同一 topic 即可接收。

## 使用

| 命令 | 说明 |
|---------|-------------|
| `/notify` | 显示状态总览 |
| `/notify on` / `stop` | 通知开关（持久化；开启前需先配置 topic） |
| `/notify session on` / `stop` | 会话级开关（仅当前 pi 会话，重启后重置） |
| `/notify mute` | 进入勿扰（默认 1 小时） |
| `/notify mute 30m` | 勿扰指定时长：`10s` `30m` `1h` `1d`（单位上限为天） |
| `/notify mute off` | 解除勿扰 |
| `/notify topic <名称>` | 设置 ntfy topic（频道名） |
| `/notify server <url>` | ntfy 服务器地址（默认 `https://ntfy.sh`） |
| `/notify token <token>` | 访问令牌（自建服务器鉴权用，可选） |
| `/notify test` | 发送测试通知 |
| `/notify message fixed` | 固定完成文本 |
| `/notify message response` | AI 回复前 50 字（默认） |
| `/notify lang zh` | 语言：`zh` / `en` / `ja` / `ko` |

## 快速上手

```bash
/notify topic my-secret-topic-123   # 手机订阅同一 topic
/notify server https://ntfy.example.com   # 自建服务器（可选）
/notify token tk_xxx                 # 鉴权 token（可选）
/notify test                         # 手机确认收到
```

## 特性

- 📱 **ntfy 推送** — 支持自建服务器与 token 鉴权，零依赖纯 HTTP
- 📋 **结构化通知** — 多会话一眼可辨：

```
session-name: 重构用户模块
session-id: a3f8c2e1-...
time: 2026-09-11 14:32
user-prompt: 帮我重构整个用户认证模块的代码
ai-text: 已完成，共修改 3 个文件…
```

- 🔔 **三种通知** — 完成 ✅（AI 回复摘要）/ 需要输入 ❓（agent 提问，需安装 [@juicesharp/rpiv-ask-user-question](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question)）/ 错误 🔴
- 🎚 **三层开关** — 全局（`/notify on|stop`）、会话（`/notify session on|stop`）、勿扰（`/notify mute`）
- 🔕 **勿扰** — `10s`/`30m`/`1h`/`1d` 限时静音，持久化，多实例自动同步
- 🤖 基于 `agent_settled`：LLM 自动重试、上下文压缩期间不打扰；用户主动中断（aborted）不通知
- 🌐 多语言：`zh` / `en` / `ja` / `ko`
- 🚫 通知关闭时不注册任何事件 hook，零开销

## 测试

```bash
npm i -D typescript @types/node && node --experimental-strip-types tests/tests.ts
```

29 个单元测试，覆盖内容提取、结构化正文、勿扰时长解析、ntfy 标题编码。

## 文件

- 配置：`~/.pi/agent/notify.json`（含 server/topic/token）
- 日志：`$TMPDIR/pi-notify-debug.log`
