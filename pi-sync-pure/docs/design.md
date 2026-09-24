# pi-sync-pure 架构设计

本文档是 pi-sync-pure 的架构决策记录，来自 2025 年 5 月的设计访谈，所有条目均与用户逐条确认。改代码前先读本文，尤其是"操作语义"与"明确不做的事"两节；若实现与本文冲突，以本文为准，或先与用户重新确认再改。

## 背景与动机

旧版 pi-sync 以三方比较引擎为核心：本机文件、仓库基线、远端三方对比，配合变基、冲突裁决、扩展计划、TUI 面板等机制。功能完整但复杂度高，维护成本大。pure 版的设计立场是：既然配置同步的载体本来就是 git 仓库，就让 git 原语 (force 覆盖、merge、分支) 直接表达所有同步语义，插件只保留"文件在 agent 目录与仓库之间搬运"这一不可省略的本体。

## 分支模型

每台设备拥有一个独立分支 `device/<设备名>`，本地仓库的 HEAD 永远停留在设备分支上。main 分支只是远端的汇聚点，本地不长期驻留 main，需要操作 main 时临时 checkout，操作完切回设备分支。

设备名在初始化时输入，不输入则默认生成本机唯一 ID：取平台机器 UUID (Linux /etc/machine-id、Windows MachineGuid、macOS IOPlatformUUID) 的短哈希，取不到时退化为随机短 ID。不用 hostname 做默认值，因为它在一些机器上会是 localhost 这类无区分度的值；选机器 UUID 则让删除本地仓库重新初始化时默认名保持不变，便于自动对上旧分支。分支名不附加任何哈希后缀：机器 UUID、MAC、hostname 在重装后都会改变，哈希防撞防不住真正需要防的场景，因此设备名的唯一性由用户自己保证，插件不做防撞机制。

设备分支的含义是"本机现状的镜像"。由此推出一个关键简化：对设备分支的一切操作都是 force 语义 (`push -f`、`reset --hard`)，无需分叉检测——force 不会丢失任何其他设备的数据，每台设备的内容始终完整保存在自己的分支里。

main 不存在时 (远端空仓库首次 publish) 直接由 `push -f origin 设备分支:main` 创建，无需特判流程。

## 操作语义

全部操作以子命令暴露，交互式 TUI 中同样以菜单项出现。merge 系默认冲突即停，覆盖方向通过可选参数切换。

| 子命令 | git 语义 | 说明 |
| --- | --- | --- |
| `push` | capture 后 commit，`push -f origin HEAD` | 推到自己的远端设备分支 |
| `recover [分支名]` | `fetch` 后设备分支 `reset --hard origin/设备分支` | 无脑覆盖恢复，不做文件对比；显式指定分支名时先 checkout 该分支 (即认领) |
| `publish [目标]` | `push -f origin 设备分支:目标` (默认 main) | 设备分支强制覆盖目标分支 |
| `align [源]` | 设备分支 `reset --hard origin/源` (默认 main) | 源分支强制覆盖设备分支 |
| `merge-up [目标] [--ours\|--theirs]` | 先 push 存档，临时 checkout 目标 (默认 main)，merge 设备分支，push，切回 | 默认冲突即停；参数为冲突时本机/目标优先 |
| `merge-down [源] [--theirs\|--ours]` | 先 push 存档，设备分支上 merge origin/源 (默认 main) | 默认冲突即停；theirs 指向指定的源分支 |
| `remote <url>` | `git remote set-url` 后 `fetch` 验证 | 连通性验证失败则回滚为原 url |
| `rename <新名>` | `git branch -m` + push 新分支 | 旧远端分支保留不删 |

merge 冲突即停时，仓库保持操作前状态，向用户报告冲突路径，由用户自行处理或换用带覆盖参数的形式重试。分支参数中裸名自动补 device/ 前缀，main 保持原样；设备间交换配置可直接 `merge-down <对方分支>`，不必经过 main。

## 初始化与分支认领

初始化流程：输入设备名 (默认为本机唯一 ID，生成方式见分支模型一节) → clone 远端仓库到 `~/.pi/config-repo/` → 若远端已存在 `device/*` 分支，列出清单供用户认领 → capture 当前配置并 commit → `push -f` 到远端设备分支。初始化不做任何针对 main 的操作。

认领与新建是两条不同的路径。认领的目的是找回旧配置：只 checkout 被认领的分支并记录状态，不 capture、不推送——否则新机器的空配置会覆盖旧分支，认领就失去了意义；认领完成后提示用户执行 `/pisync recover` 把旧配置恢复到本机。非交互会话中，`init <url> <设备名> --new` 可跳过认领流程强制新建设备分支；分支名的唯一性由用户自己保证，不做同名保护。

重装系统后所有机器标识都会改变，找回旧分支依赖两条路径：初始化时的认领清单，以及 `/pisync recover <分支名>` 显式指定。

## autoSync

autoSync 在 pi 会话启动时执行一次 (不设定时器——配置更新后需要 /reload 才生效，定时拉取意义不大)，等价于自动的 merge-down --main --theirs：先把本机现状 capture + commit + push -f 到设备分支完成存档 (设备分支是本机镜像，push 它不影响任何其他设备)，再 fetch 并 `merge -X theirs origin/main`，有新内容则 materialize 后提示用户执行 /reload，无变化 (HEAD 未移动) 则静默。语义上 sync = 与 main 保持一致，同时保留本地不冲突的改动。

## 文件布局与配置

仓库克隆到 `~/.pi/config-repo/` (沿用旧版目录，老用户无缝迁移)，被同步的文件放在仓库 `sync/` 根目录下。`pi-sync.json` 位于仓库根目录，随分支同步到所有设备，包含 include/exclude 清单、special adapter 映射与 autoSync 配置；include/exclude 与 special 的默认值沿用旧版清单。

本地状态文件 `~/.pi/agent/pi-sync-pure.json` 持久化 remote url 与当前设备分支名。虽然这两项理论上可从 git config 与 HEAD 读出，但独立状态文件让读取逻辑更直白，也让"已初始化"的判定不依赖仓库完整性。

## 保留与砍掉

保留的机制：include/exclude glob 过滤引擎、special 配置 + 内置 settings adapter + 用户自定义 adapter 加载 (完整保留旧版 special 机制)、capture (agent 目录 → 仓库) 与 materialize (仓库 → agent 目录) 两个搬运逻辑、并发锁 (防止两个 /pisync 同时运行)。capture 与 materialize 的本体保持简单——只做复制与删除传播，对 special 文件调用 adapter 转换；一切“剥离/校验”行为统一归 adapter 的转换方向负责，例如 settings adapter 在 transformToRepository 中剥离 `file:` 等不可便携包源，本机存在这类包源不阻止推送。

明确不做的事，开发中不要顺手加回来：三方比较引擎、变基、自动备份目录、设备恢复分支、包审批流程与 `pi install` 自动执行、完整 TUI 面板。冲突安全网完全交给 git 分支历史。同步完成后如检测到 packages 声明变化，仅提示用户可运行 `pi update --extensions`。

## UI 与确认策略

交互式会话中 `/pisync` 弹出简单列表选择器 (全部操作 + status)，不做状态总览、diff 预览、设置页。publish/align 执行前弹一步确认，列表来自 git 两点 diff 对比两侧分支头的受影响文件 (文件级，不做行级展示)，默认停在取消；recover 无脑覆盖不做对比，只确认操作本身；merge 系不确认，git 冲突机制本身是安全网。

非交互式会话 (pi -p、rpc、json) 不弹任何 UI，直接使用子命令，不弹确认——子命令即明确意图。`/pisync` 不带子命令时打印用法说明。`/pisync status` 输出 git status 与 ahead/behind 的简单包装。

## 测试与发布

不维护自动化测试，验证方式为 typecheck 加 `pi -e` 手动验证；改动 git 序列时在临时目录手工搭建 fixture 验证，不触碰真实 agent 目录。

发布通过 `.github/workflows/pi-sync-pure.yml` 手动触发 (workflow_dispatch)，门禁为 typecheck；触发前确认 package.json 的 version 已更新。

## 旧版处置

旧 pi-sync 包不主动维护，但接受 PR；npm 包不删除，README 不加迁移提示。
