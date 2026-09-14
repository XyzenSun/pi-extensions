# @xyzensun/pi-notify

ntfy push notification extension for [pi](https://pi.dev) — push to your phone when a task completes, needs your input, or hits an error. Structured body (session name/id/time/prompt/AI reply). Works anywhere with network access: local machine, VM, headless server. Three-layer control: global / session / mute.

> Forked from [ryanchan720/pi-desktop-notify](https://github.com/ryanchan720/pi-desktop-notify) (MIT)

## Install

```bash
pi install npm:@xyzensun/pi-notify
```

Install the [ntfy](https://ntfy.sh) app on your phone (or self-host) and subscribe to the same topic.

## Usage

| Command | Description |
|---------|-------------|
| `/notify` | Show status overview |
| `/notify on` / `stop` | Toggle notifications (persisted; requires topic to be set before enabling) |
| `/notify session on` / `stop` | Session toggle (current session only, reset on restart) |
| `/notify mute` | Enter mute (default 1 hour) |
| `/notify mute 30m` | Mute for a duration: `10s` `30m` `1h` `1d` (max unit: days) |
| `/notify mute off` | Leave mute |
| `/notify topic <name>` | Set ntfy topic (channel) |
| `/notify server <url>` | ntfy server (default `https://ntfy.sh`) |
| `/notify token <token>` | Access token for auth (optional) |
| `/notify test` | Send a test notification |
| `/notify message fixed` | Fixed completion text |
| `/notify message response` | AI reply first 50 chars (default) |
| `/notify lang en` | Language: `zh` / `en` / `ja` / `ko` |

## Quick start

```bash
/notify topic my-secret-topic-123        # subscribe to the same topic on your phone
/notify server https://ntfy.example.com  # self-hosted server (optional)
/notify token tk_xxx                     # auth token (optional)
/notify test                             # verify on your phone
```

## Features

- 📱 **ntfy push** — self-hosted server & token auth supported, zero dependencies (plain HTTP)
- 📋 **Structured notifications** — multi-session at a glance:

```
session-name: Refactor auth module
session-id: a3f8c2e1-...
time: 2026-09-11 14:32
user-prompt: Refactor the entire user authentication module
ai-text: Done, 3 files modified…
```

- 🔔 **Three kinds** — complete ✅ (AI reply excerpt) / input needed ❓ (agent asking, requires [@juicesharp/rpiv-ask-user-question](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question)) / error 🔴
- 🎚 **Three layers** — global (`/notify on|stop`), session (`/notify session on|stop`), mute (`/notify mute`)
- 🔕 **Mute** — `10s`/`30m`/`1h`/`1d` timed silence, persists to disk, multi-instance auto-sync
- 🤖 Built on `agent_settled`: silent during LLM auto-retries and compaction; user-aborted turns are not notified
- 🌐 Multi-language: `zh` / `en` / `ja` / `ko`
- 🚫 Zero overhead: no event hooks registered when notifications are off

## Test

```bash
npm i -D typescript @types/node && node --experimental-strip-types tests/tests.ts
```

29 unit tests covering content extraction, structured body building, mute duration parsing, and ntfy title encoding.

## Files

- Config: `~/.pi/agent/notify.json` (server/topic/token)
- Log: `$TMPDIR/pi-notify-debug.log`
