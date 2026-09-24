# pi-sync-pure

`pi-sync-pure` 通过 Git 分支同步多台设备的 Pi 配置。每台设备在 `device/<设备名>` 上维护本机配置快照，远端 `main` 作为汇聚点；同步采用 Git 的 `push -f`、`reset --hard` 与 merge 语义，不执行三方比较、自动备份或包安装。

## 安装与初始化

```bash
pi install npm:@xyzensun/pi-sync-pure
```

首次交互式初始化：

```text
/pisync
```

在操作菜单选择 `init`，然后输入配置仓库的 Git remote URL 和设备名。默认设备名基于平台机器 UUID 的短哈希；无法读取机器 UUID 时使用随机短 ID。若仓库已有 `device/*` 分支，可在初始化中认领现有分支。认领只切换分支并记录状态，不会推送任何内容；随后执行 `/pisync recover` 即可把旧分支的配置恢复到本机。

非交互模式通过子命令明确表达意图：

```text
/pisync init git@github.com:you/pi-config.git laptop
/pisync init git@github.com:you/pi-config.git laptop device/old-laptop
/pisync init git@github.com:you/pi-config.git laptop --new
```

`--new` 跳过认领流程强制创建新设备分支；分支名的唯一性由用户自己保证，同名 push 会覆盖远端同名分支。

初始化会 clone 到 `~/.pi/config-repo/`，同步源文件放在仓库 `sync/`，本地状态保存在 `~/.pi/agent/pi-sync-pure.json`。初始化不自动导入 `main`。

## 命令

```text
/pisync push
/pisync recover [device/<分支名>]
/pisync publish [目标分支]
/pisync align [源分支]
/pisync merge-up [目标分支] [--ours|--theirs]
/pisync merge-down [源分支] [--theirs|--ours]
/pisync remote <url>
/pisync rename <新设备名>
/pisync status
```

`push` 把本机配置镜像到设备分支并强制推送。`recover` 从远端设备分支无脑覆盖恢复本机，不做文件对比；指定分支时先认领该分支。`publish` 强制以本机设备分支覆盖目标分支（默认 main），`align` 则强制以源分支（默认 main）覆盖本机设备分支。交互式 TUI 在 publish/align 前会展示 git 对比出的受影响文件并要求确认，取消为默认行为；recover 只确认操作本身；非交互模式不弹 UI。

`merge-up` 临时切到目标分支（默认 main），合并设备分支并推送，之后切回设备分支。`merge-down` 在设备分支合并源分支（默认 origin/main）。两个 merge 都会先把本机改动 push 到设备分支存档，再执行合并；默认冲突即停止并报告冲突文件，`--ours` / `--theirs` 用于选择冲突解决方向（theirs 指你指定的源分支）。分支参数中裸名自动补 `device/` 前缀，main 保持原样——例如 `merge-down laptop-b` 直接合并 `origin/device/laptop-b`，设备间交换配置不必经过 main。`remote` 更新并验证 origin URL，失败后恢复旧 URL。`rename` 推送新设备分支但不删除旧远端分支。`status` 显示工作区状态和远端 ahead/behind。

不带参数执行 `/pisync` 会在 TUI 中打开简单操作菜单；非交互模式打印帮助。

## pi-sync.json

首次初始化时会在配置仓库生成 `pi-sync.json`，默认配置如下：

```json
{
  "schemaVersion": 2,
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
    "extensions/pi-sync-pure/**",
    "extensions/**/.cache/**",
    "extensions/**/cache/**",
    "extensions/**/coverage/**",
    "extensions/**/logs/**",
    "extensions/**/temp/**",
    "extensions/**/tmp/**"
  ],
  "special": { "settings.json": "settings" },
  "autoSync": { "enabled": false }
}
```

include/exclude 使用 glob；隐藏文件默认不参与同步 (`.gitignore` 除外)，符号链接不跟随，exclude 优先。`special` 可为文件选择内置 `settings` adapter 或仓库内的用户 adapter 路径 (`"./my-adapter.js"`)。adapter 可导出 `transformToRepository`、`transformToLocal`、`validate`，缺省转换方向保持原字节。

内置 `settings` adapter 仅同步设备无关的白名单字段，合并或恢复回本机时保留本机 `trackingId`、`sessionDir` 等白名单外字段，并保留本机非便携包源。adapter 会维护 `npm:@xyzensun/pi-sync-pure` 包声明，确保本插件可持续加载。

启用启动时自动同步：

```json
"autoSync": { "enabled": true }
```

autoSync 在 pi 会话启动时执行一次，等价于自动的 `merge-down --main --theirs`：先把本机现状 push 到设备分支完成存档，再从 main 合并（冲突取 main）。main 有新内容时会提示执行 `/reload` 使其生效，无变化则静默。没有定时器——配置更新后需要 reload 才生效，定时拉取意义不大。同步配置可能改变 `settings.json` 中的 `packages` 声明；插件不会安装包，用户可自行运行 `pi update --extensions`。

## 开发与验证

```bash
pi -e ./pi-sync-pure/index.ts
```

改动后在 pi 中执行 `/reload` 验证。类型检查: `cd pi-sync-pure && npm run typecheck`。

发布通过 GitHub Actions 手动触发 `.github/workflows/pi-sync-pure.yml` 完成，门禁为 typecheck；发布前更新 `package.json` 版本。本地不要运行 `npm publish`。
