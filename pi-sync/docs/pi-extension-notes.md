# Pi 扩展（Extension）机制笔记

本文只记录 **Pi coding agent 平台本身的扩展机制**，不涉及本项目的同步业务逻辑。
目的：把从上游模板（`@jachy/pi-git-sync`）与 Pi 源码中学到的平台知识固化下来，之后开发本项目扩展时不再需要回读上游代码。

## 资料来源与版本

| 来源 | 路径 |
|------|------|
| Pi 运行时源码 | `<node_modules>/@earendil-works/pi-coding-agent/dist/` |
| Pi 官方文档 | `<node_modules>/@earendil-works/pi-coding-agent/docs/` |
| Pi 官方示例 | `<node_modules>/@earendil-works/pi-coding-agent/examples/extensions/` |
| 本项目扩展入口 | `/workspace/pi-sync/index.ts` |
| 本项目包声明 | `/workspace/pi-sync/package.json` |

下文每个 API 都标注了「来源」：`dist/...` 表示类型定义或实现代码，`docs/...` 表示官方文档。
本项目 `package.json` 中 peer 依赖版本为 `@earendil-works/pi-coding-agent ^0.82.1` 与 `@earendil-works/pi-tui ^0.82.1`；本机安装的运行时为同一系列的较新版本，本文以本机安装版本的源码为准。

---

## 1. 扩展的两种形态

Pi 有两条独立的扩展装载路径：**目录扩展（自动发现）** 和 **包扩展（`pi install` + settings.json 声明）**。两者最终都变成一组「扩展入口文件路径」交给同一个 loader。

### 1.1 目录扩展（auto-discovery）

来源：`dist/core/extensions/loader.js` → `discoverAndLoadExtensions()` / `discoverExtensionsInDir()` / `resolveExtensionEntries()`；`docs/extensions.md` §Extension Locations。

自动扫描的目录，按加载顺序：

1. 项目级：`<cwd>/.pi/extensions/`（`CONFIG_DIR_NAME` 常量，默认 `.pi`）
2. 全局：`<agentDir>/extensions/`，`agentDir` 默认 `~/.pi/agent`
3. `settings.json` 的 `extensions[]` 里显式配置的路径

每个目录内的发现规则（`discoverExtensionsInDir`，**只下探一层，不递归**）：

| 形态 | 规则 |
|------|------|
| 单文件 | `extensions/*.ts` 或 `*.js` → 直接作为扩展加载 |
| 子目录 + 入口 | `extensions/<name>/index.ts` 或 `index.js` → 加载该 index |
| 子目录 + 清单 | `extensions/<name>/package.json` 且含 `pi.extensions` → 加载清单声明的路径 |

入口解析优先级（`resolveExtensionEntries`）：**`package.json` 的 `pi.extensions` > `index.ts` > `index.js`**。
`pi.extensions` 中声明但文件不存在的条目会被静默跳过；若一条都不存在，则回退到 `index.ts` / `index.js`。

值得注意：`discoverExtensionsInDir` 对 `entry.isSymbolicLink()` 做了显式处理，**符号链接的文件和目录都会被发现**（`loader.js` 中 `entry.isFile() || entry.isSymbolicLink()` 与 `entry.isDirectory() || entry.isSymbolicLink()` 两个分支）。这正是「把开发目录 `ln -s` 进 `extensions/`」这一开发方式能工作的原因。

项目级 `.pi/extensions` 只有在项目被信任（project trust）后才会加载——来源：`docs/extensions.md` §Extension Locations、`docs/settings.md` §Project Trust。

### 1.2 包扩展（pi package）

来源：`docs/packages.md`；`dist/core/package-manager.js`；`dist/core/settings-manager.d.ts`。

安装命令（`docs/packages.md` §Install and Manage）：

```bash
pi install npm:@scope/pkg@1.2.3      # npm 源，带版本号即为 pin
pi install git:github.com/user/repo@v1  # git 源，ref 为 pin
pi install https://github.com/user/repo # 裸协议 URL 也可
pi install /absolute/path/to/package    # 本地路径，不复制，只写入 settings
pi remove npm:@scope/pkg
pi list
pi update --extensions                  # 更新包并对齐 pinned git ref
```

`install` / `remove` 默认写入**用户设置** `~/.pi/agent/settings.json`；加 `-l` 写入项目设置 `.pi/settings.json`。

安装后的磁盘布局（来源：`dist/core/package-manager.js` 的 `getManagedNpmInstallPath()` / `getGitInstallRoot()`，与 `docs/packages.md` 一致）：

| 源类型 | 用户级（scope=user） | 项目级（scope=project） |
|--------|----------------------|--------------------------|
| npm | `~/.pi/agent/npm/node_modules/<pkgName>` | `<cwd>/.pi/npm/node_modules/<pkgName>` |
| git | `~/.pi/agent/git/<host>/<path>` | `<cwd>/.pi/git/<host>/<path>` |
| 临时（`-e`） | `~/.pi/agent/tmp/extensions/...`（`getExtensionTempFolder()`，权限 `0700`） | — |

`npm/` 目录本身是一个被 Pi 托管的 npm 工程（`ensureNpmProject`），实际磁盘上会有 `npm/package.json`、`npm/package-lock.json`、`npm/node_modules/`。git 包在 clone 或 ref 变化后，若存在 `package.json` 会自动执行 `npm install`。

`settings.json` 的 `packages` 字段（类型定义见 `dist/core/settings-manager.d.ts` 的 `PackageSource`）：

```typescript
export type PackageSource = string | {
    source: string;
    autoload?: boolean;
    extensions?: string[];
    skills?: string[];
    prompts?: string[];
    themes?: string[];
};
```

字符串形式加载包内全部资源；对象形式做过滤：

```json
{
  "packages": [
    "npm:pi-open-tui",
    "npm:@xyzensun/pi-sync",
    {
      "source": "npm:my-package",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": []
    }
  ]
}
```

过滤语义（`docs/packages.md` §Package Filtering）：省略某个 key = 全加载；`[]` = 全不加载；`!pattern` 排除；`+path` / `-path` 为「相对包根的精确路径」强制包含 / 排除。过滤只能在清单已允许的范围内收窄。

同一个包同时出现在全局与项目设置时：项目条目胜出；除非项目条目带 `autoload: false`，此时项目条目作为增量叠加在全局条目之上。身份判定：npm 看包名，git 看去掉 ref 的仓库 URL，local 看解析后的绝对路径。

### 1.3 两种形态的取舍

- 目录扩展：适合本机私有扩展、开发调试；可被 `/reload` 热重载。
- 包扩展：适合分发；同样会被 `/reload` 重新加载资源，但代码更新需要 `pi update`。
- 一个仓库可以同时满足两者：仓库根有 `package.json` + `pi.extensions`，既能被 `pi install npm:...` 装成包，也能被 `ln -s` 到 `extensions/` 当目录扩展用（因为 `resolveExtensionEntries` 优先读同一份 `pi.extensions`）。本项目就是这种结构。

---

## 2. 在 package.json 里声明一个 pi 包

来源：`dist/core/pi-manifest.js`（`readPiManifest`）；`docs/packages.md` §Creating a Pi Package。

Pi 只认 `package.json` 顶层的 `pi` 对象，且只读取四个字段：

```javascript
const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"];
```

每个字段必须是**字符串数组**，否则该字段被忽略（`readPiManifest` 对 `Array.isArray(entries) && entries.every(entry => typeof entry === "string")` 做校验）。路径相对包根解析；数组支持 glob 与 `!exclusions`（`docs/packages.md`）。

本项目的声明（`/workspace/pi-sync/package.json`）：

```json
{
  "name": "@xyzensun/pi-sync",
  "type": "module",
  "main": "./index.ts",
  "keywords": ["pi-package", "pi-extension", "git-sync", "pi", "sync", "config", "dotfiles"],
  "pi": {
    "extensions": ["./index.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "^0.82.1",
    "@earendil-works/pi-tui": "^0.82.1"
  }
}
```

要点：

- **`pi.extensions` 是唯一必需的加载声明**。没有它时 Pi 才回退到约定目录 / `index.ts`。
- 若完全不写 `pi` 清单，Pi 按约定目录自动发现（`docs/packages.md` §Convention Directories）：`extensions/` 收 `.ts`/`.js`，`skills/` 递归找 `SKILL.md` 目录并把顶层 `.md` 当技能，`prompts/` 收 `.md`，`themes/` 收 `.json`。
- **`pi-package` 关键字**：官方文档只说明它用于「可发现性」和 [pi.dev 包画廊](https://pi.dev/packages) 的展示，**加载逻辑不依赖它**。画廊还支持 `pi.video`（仅 MP4）与 `pi.image`（PNG/JPEG/GIF/WebP）预览字段，两者同时存在时 video 优先。
- 本项目 keywords 里的 `pi-extension` 未在 Pi 源码或文档中出现，**未在源码中确认其有任何作用**，应视为纯标签。
- **依赖归属**（`docs/packages.md` §Dependencies）：运行时第三方依赖放 `dependencies`（Pi 安装包时会跑 `npm install`，且默认 `--omit=dev`，所以 `devDependencies` 在运行时不可用）。Pi 自带并注入这几个包，**必须放 `peerDependencies` 且不要打包**：`@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`typebox`。官方文档建议这些 peer 范围写 `"*"`；本项目当前写的是 `^0.82.1`，属于更严格的写法。
- 依赖其它 pi 包时必须 bundle：放进 `dependencies` + `bundledDependencies`，并在 `pi.extensions` 里用 `node_modules/<pkg>/extensions` 这样的路径引用。Pi 以独立 module root 加载各包，不会串模块。

---

## 3. 扩展入口的形态与生命周期

### 3.1 工厂函数

来源：`dist/core/extensions/loader.js`（`loadExtensionModule` / `loadExtension`）；`dist/core/extensions/types.d.ts`（`ExtensionAPI`）；`docs/extensions.md` §Writing an Extension。

扩展模块必须 **default export 一个函数**，接收 `ExtensionAPI`：

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) { /* ... */ }
```

loader 的实际判定是 `typeof factory !== "function"` 就报错 `Extension does not export a valid factory function`，即**只要求 default 导出可调用**。工厂可以是 `async`：`await factory(api)`，Pi 会等它 resolve 后才继续启动，因此异步初始化保证发生在 `session_start`、`resources_discover` 以及 `pi.registerProvider()` 队列 flush 之前。

模块通过 [jiti](https://github.com/unjs/jiti) 加载，**TypeScript 无需预编译**（`createJiti(..., { moduleCache: false })`）。`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`、`typebox` 由 Pi 通过 jiti 的 `alias`（Node 模式）或 `virtualModules`（Bun 二进制模式）注入，扩展里 `import` 到的就是宿主进程内的同一份实例。Node 内置模块与扩展自己 `node_modules/` 下的依赖正常可用。

本项目入口的实际形态：

```typescript
export default function (pi: ExtensionAPI) {
	const cmds = new PiSyncCommands();
	registerExtensionSelfExclusion();
	let sessionGeneration = 0;
	let statusGeneration = 0;
	// ...
	pi.on("session_start", (_event, ctx) => { /* ... */ });
	pi.on("session_shutdown", (_event, ctx) => { /* ... */ });
	pi.registerCommand("pisync", { /* ... */ });
}
```

### 3.2 加载阶段的能力边界

来源：`dist/core/extensions/loader.js`（`createExtensionRuntime` / `createExtensionAPI`）。

`ExtensionAPI` 的方法分两类：

- **注册类**（`on`、`registerCommand`、`registerTool`、`registerShortcut`、`registerFlag`、`registerMessageRenderer`、`registerEntryRenderer`、`registerMarkdownTransformer`）：写入扩展对象，工厂阶段可安全调用。
- **动作类**（`sendMessage`、`sendUserMessage`、`appendEntry`、`setSessionName`、`setLabel`、`getActiveTools`、`setActiveTools`、`getCommands`、`setModel`、`getThinkingLevel`/`setThinkingLevel`）：委托给 runtime。**在工厂加载阶段调用会抛 `Extension runtime not initialized`**，必须等到 `Runner.bindCore()` 之后（即事件回调、命令 handler、工具 execute 内）。
- `pi.registerProvider()` 在加载阶段会被排队，绑定完成后 flush；加载阶段之后调用则立即生效，不需要 `/reload`。

另有 stale 保护：会话被替换（`newSession` / `fork` / `switchSession`）或 `reload` 之后，旧的 `pi` / 旧 `ctx` 会被 `invalidate()`，再使用就抛错，提示改用 `withSession` 传入的新 ctx。

### 3.3 长生命周期资源的正确位置

来源：`docs/extensions.md` §Long-lived resources and shutdown。

**不要在工厂函数里启动进程、socket、文件监听、定时器**——工厂可能运行在根本不会开启会话的调用里。正确做法：在 `session_start`（或真正需要它的命令/事件）里启动，在 `session_shutdown` 里做幂等清理。

本项目的 autoSync 定时器就是这个模式：

```typescript
	let autoSyncTimer: ReturnType<typeof setInterval> | null = null;

	pi.on("session_start", (_event, ctx) => {
		// ...
		void (async () => {
			try {
				const lifecycle = await cmds.inspectLifecycleState();
				const autoConfig = lifecycle.kind === "initialized"
					? await autoSyncConfigFor(lifecycle.repoPath)
					: null;
				if (autoConfig?.enabled === true && generation === sessionGeneration) {
					autoSyncTimer ??= setInterval(() => {
						void runAutoSyncTick(cmds, ctx);
					}, Math.max(5, autoConfig.intervalMinutes) * 60_000);
				}
			} catch {
				// 配置读取失败等：不开定时器，静默。
			}
		})();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		sessionGeneration++;
		if (autoSyncTimer !== null) {
			clearInterval(autoSyncTimer);
			autoSyncTimer = null;
		}
		updateStatus(ctx.ui, SyncStatus.None);
	});
```

这里的 `sessionGeneration` / `statusGeneration` 计数器是应对「异步回调返回时会话已被换掉」的通用写法：回调落地时先比对代次，代次不符就丢弃结果。

### 3.4 定位扩展自身的安装目录

`import.meta.url` 在扩展中可用，可用于推断自身安装位置。本项目用它计算「本扩展相对 agent 目录的路径」：

```typescript
function defaultAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) return envDir;
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
	return join(home, ".pi", "agent");
}

const extRoot = dirname(fileURLToPath(import.meta.url));
const rel = relative(defaultAgentDir(), extRoot);
```

注意这是扩展侧的自行推断；Pi 内部对应的权威实现是 `dist/config.js` 的 `getAgentDir()`（见 §8）。另外 Pi 导出了 `CONFIG_DIR_NAME` 常量，`docs/extensions.md` §ctx.cwd 明确建议用它而不是硬编码 `.pi`，以兼容 rebrand 的分发版。

---

## 4. 注册斜杠命令

来源：`dist/core/extensions/types.d.ts`（`RegisteredCommand`、`ExtensionAPI.registerCommand`）；`dist/core/extensions/loader.js`；`dist/core/extensions/runner.js`；`docs/extensions.md` §pi.registerCommand。

### 4.1 签名

```typescript
registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;

export interface RegisteredCommand {
    name: string;
    sourceInfo: SourceInfo;
    description?: string;
    getArgumentCompletions?: (argumentPrefix: string) =>
        AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}
```

- `name` 不带前导斜杠，`registerCommand("pisync", ...)` 对应用户输入 `/pisync`。
- `handler` 的 `args` 是命令名之后的**整串原始文本**（没有自动分词），`ctx` 是 `ExtensionCommandContext`（比事件回调的 `ExtensionContext` 多出会话控制能力，见 §6.3）。
- `sourceInfo` 由 Pi 注入，扩展不能也不需要提供。
- **重名处理**：多个扩展注册同名命令时 Pi 全部保留，按加载顺序分配 `invocationName`，如 `/review:1`、`/review:2`（`runner.js`）。

### 4.2 子命令与参数补全

`getArgumentCompletions(prefix)` 在用户输入 `/cmd <prefix>` 时被调用，返回补全项数组，返回 `null` 表示「没有建议，交回默认行为」。返回类型是 `pi-tui` 的 `AutocompleteItem`：

```typescript
export interface AutocompleteItem { value: string; label: string; description?: string; }
```

本项目用的是 `pi-tui` 的 `SelectItem`，字段完全同构（`value` / `label` / `description?`），因此可以直接传入：

```typescript
const pisyncSubcommands: SelectItem[] = [
	{ value: "status", label: "status", description: "Show detailed sync status" },
	{ value: "diff", label: "diff", description: "Show pending changes before sync" },
];

function getPiSyncArgumentCompletions(prefix: string): SelectItem[] | null {
	if (/\s/.test(prefix)) return null;          // 已经输入过空格 → 不再补全子命令
	const query = prefix.toLowerCase();
	const matches = pisyncSubcommands.filter((command) =>
		command.value.toLowerCase().includes(query),
	);
	return matches.length > 0 ? matches : null;
}
```

### 4.3 完整注册示例（本项目）

「子命令」在 Pi 里没有一等公民概念，就是在 handler 内部对 `args` 自己分派：

```typescript
	pi.registerCommand("pisync", {
		description: "Set up or sync Pi configuration via Git",
		getArgumentCompletions: getPiSyncArgumentCompletions,
		async handler(args, ctx) {
			switch (args?.trim()) {
				case "":
				case undefined:
					await handlePiSync(cmds, pi, ctx, () => updateStatus(ctx.ui, SyncStatus.None));
					break;
				case "status":
					await handleStatus(cmds, ctx);
					break;
				case "diff":
					await handleDiff(cmds, ctx);
					break;
				default:
					ctx.ui.notify(
						"Unsupported argument. Supported commands: /pisync, /pisync status, and /pisync diff.",
						"warning",
					);
			}
		},
	});
```

### 4.4 相关的其它注册接口

来源：`dist/core/extensions/types.d.ts` 的 `ExtensionAPI`。

| API | 用途 |
|-----|------|
| `registerTool(definition)` | 注册 LLM 可调用的工具；加载期和运行期都可调用，运行期注册会立即刷新工具表 |
| `registerShortcut(keyId, { description?, handler })` | 注册键盘快捷键，handler 收到 `ExtensionContext` |
| `registerFlag(name, { type, description?, default? })` + `getFlag(name)` | 注册并读取 CLI flag |
| `registerMessageRenderer(customType, renderer)` | 自定义消息渲染（消息参与 LLM 上下文） |
| `registerEntryRenderer(customType, renderer)` | 自定义条目渲染（条目**不**参与 LLM 上下文） |
| `registerMarkdownTransformer(transformer)` | 渲染前改写 Markdown，仅影响显示 |
| `pi.getCommands()` | 列出当前会话可用斜杠命令（扩展 → 模板 → 技能顺序） |
| `pi.events` | 扩展之间通信的共享事件总线（`emit` / `on`） |

---

## 5. 事件监听

### 5.1 订阅方式与 handler 签名

来源：`dist/core/extensions/types.d.ts`。

```typescript
export type ExtensionHandler<E, R = undefined> =
    (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

pi.on("session_start", (event, ctx) => { /* ... */ });
```

`pi.on` 在类型定义里是一组重载，事件名与事件对象、返回值类型一一对应。**事件回调拿到的是 `ExtensionContext`，不是 `ExtensionCommandContext`**——所以事件里不能调用 `ctx.reload()` / `ctx.newSession()` 等会话控制方法（官方说明：这些方法从事件回调中调用可能死锁）。

### 5.2 完整事件名清单

来源：`dist/core/extensions/types.d.ts` 中 `ExtensionAPI.on` 的重载列表（这是最权威的事件名来源）。

| 分类 | 事件 | 可返回值 / 备注 |
|------|------|------------------|
| 启动/信任 | `project_trust` | 必须返回 `{ trusted: "yes" \| "no" \| "undecided", remember? }`；仅用户级/全局与 CLI `-e` 扩展参与 |
| 资源 | `resources_discover` | 返回 `{ skillPaths?, promptPaths?, themePaths? }`；`reason: "startup" \| "reload"` |
| 会话 | `session_start` | `reason: "startup" \| "reload" \| "new" \| "resume" \| "fork"`，`previousSessionFile?` |
| | `session_info_changed` | 会话显示名变化 |
| | `session_before_switch` | 可返回 `{ cancel: true }` |
| | `session_before_fork` | 可返回 `{ cancel: true }` |
| | `session_before_compact` / `session_compact` | 前者可取消或提供自定义摘要 |
| | `session_before_tree` / `session_tree` | `/tree` 导航 |
| | `session_shutdown` | `reason: "quit" \| "reload" \| "new" \| "resume" \| "fork"` |
| Agent | `before_agent_start` | 可注入消息、改系统提示 |
| | `agent_start` / `agent_end` / `agent_settled` | `agent_settled` = 无重试/压缩/排队续跑 |
| | `turn_start` / `turn_end` | |
| | `message_start` / `message_update` / `message_end` | |
| 上下文/请求 | `context` | 可改 messages |
| | `before_provider_headers` | 就地改 headers，返回值忽略，值为 `null` 表示删除该头 |
| | `before_provider_request` | 可替换 payload |
| | `after_provider_response` | 拿到 status + headers，在消费流之前 |
| 工具 | `tool_call` | 可返回 `{ block: true, reason }` 拦截 |
| | `tool_result` | 可改结果 |
| | `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | |
| 模型 | `model_select` / `thinking_level_select` | |
| 用户输入 | `input` | 可拦截、改写或直接处理 |
| | `user_bash` | 用户 `!` / `!!` 执行的命令 |

生命周期时序图见 `docs/extensions.md` §Lifecycle Overview。关键点：`session_start` 之后才是 `resources_discover`；`/new`、`/resume`、`/fork`、`/reload` 都会走「`session_shutdown` → 重新加载扩展 → `session_start`」的完整替换流程，所以**扩展实例的内存状态在会话替换后会重建**。

### 5.3 本项目的用法

```typescript
	pi.on("session_start", (_event, ctx) => {
		const generation = ++sessionGeneration;
		const currentStatusGeneration = statusGeneration;

		// 状态栏检查优先（与原行为一致：立即调用 needsSync）。
		void cmds
			.needsSync()
			.then((needsSync) => {
				if (generation === sessionGeneration && currentStatusGeneration === statusGeneration) {
					updateStatus(ctx.ui, needsSync ? SyncStatus.SyncNeeded : SyncStatus.None);
				}
			})
			.catch(() => { /* 失败也把状态清空 */ });
		// ...
	});
```

模式要点：`session_start` 里**不 await 长任务**（会拖慢启动），而是 fire-and-forget + 代次校验；UI 更新通过 `ctx.ui` 完成，而 `ctx` 会被闭包捕获给后续定时器使用。

---

## 6. `ctx` API

### 6.1 `ctx.ui` 方法清单

来源：`dist/core/extensions/types.d.ts` 的 `ExtensionUIContext`（下表签名逐条摘自该接口）。

| 方法 | 签名 | 用途 |
|------|------|------|
| `select` | `(title: string, options: string[], opts?: ExtensionUIDialogOptions) => Promise<string \| undefined>` | 单选对话框；取消/超时返回 `undefined`。注意 **options 是纯字符串数组，返回的也是被选中的字符串本身** |
| `confirm` | `(title: string, message: string, opts?) => Promise<boolean>` | 确认框；取消/超时返回 `false` |
| `input` | `(title: string, placeholder?: string, opts?) => Promise<string \| undefined>` | 单行输入；取消/超时返回 `undefined` |
| `editor` | `(title: string, prefill?: string) => Promise<string \| undefined>` | 多行编辑器 |
| `notify` | `(message: string, type?: "info" \| "warning" \| "error") => void` | 非阻塞通知，追加进正文流，不抢焦点 |
| `custom` | `custom<T>(factory: (tui, theme, keybindings, done) => Component \| Promise<Component>, options?: { overlay?, overlayOptions?, onHandle? }) => Promise<T>` | 自定义全屏/浮层组件，直到 `done(value)` 才 resolve |
| `onTerminalInput` | `(handler: (data: string) => { consume?: boolean; data?: string } \| undefined) => () => void` | 监听原始终端输入，**仅 TUI 模式**；返回取消订阅函数 |
| `setStatus` | `(key: string, text: string \| undefined) => void` | footer 状态条目；`undefined` 清除 |
| `setWidget` | `(key, content: string[] \| ((tui, theme) => Component) \| undefined, options?: { placement?: "aboveEditor" \| "belowEditor" }) => void` | 编辑器上/下方的常驻小部件 |
| `setFooter` | `(factory: ((tui, theme, footerData) => Component) \| undefined) => void` | 整体替换 footer；`undefined` 恢复内置 |
| `setHeader` | `(factory: ((tui, theme) => Component) \| undefined) => void` | 替换启动头部 |
| `setTitle` | `(title: string) => void` | 设置终端窗口/标签标题 |
| `setWorkingMessage` | `(message?: string) => void` | 流式输出时的「工作中」文案；无参恢复默认 |
| `setWorkingVisible` | `(visible: boolean) => void` | 显示/隐藏内置工作指示行 |
| `setWorkingIndicator` | `(options?: { frames?: string[]; intervalMs?: number }) => void` | 自定义指示器帧；`frames: []` 完全隐藏；帧原样渲染，要颜色需自己加 |
| `setHiddenThinkingLabel` | `(label?: string) => void` | 折叠 thinking 块的标签 |
| `pasteToEditor` | `(text: string) => void` | 以「粘贴」语义写入编辑器（含大内容折叠处理） |
| `setEditorText` / `getEditorText` | `(text: string) => void` / `() => string` | 读写主输入框文本 |
| `addAutocompleteProvider` | `(factory: (current: AutocompleteProvider) => AutocompleteProvider) => void` | 在内置补全之上叠加自定义补全 |
| `setEditorComponent` / `getEditorComponent` | `(factory: EditorFactory \| undefined) => void` / `() => EditorFactory \| undefined` | 替换主编辑器（vim 模式等） |
| `theme` | `readonly theme: Theme` | 当前主题，`theme.fg(color, text)` / `bold` / `italic` / `strikethrough` |
| `getAllThemes` / `getTheme` / `setTheme` | 见类型定义 | 主题枚举、按名加载、切换 |
| `getToolsExpanded` / `setToolsExpanded` | `() => boolean` / `(expanded: boolean) => void` | 工具输出展开状态 |

对话框选项（`ExtensionUIDialogOptions`）：

```typescript
export interface ExtensionUIDialogOptions {
    signal?: AbortSignal;  // 程序化关闭
    timeout?: number;      // 毫秒，自动关闭并显示倒计时
}
```

**`notify` 的一个易踩点**：`type` 为 `"error"` / `"warning"` 时，交互模式会分别加上 `Error: ` / `Warning: ` 前缀并用对应颜色渲染；`"info"` 走 `showStatus`，以 dim 色追加且**不加任何前缀**（来源：`dist/modes/interactive/interactive-mode.js` 的 `showExtensionNotify` / `showError` / `showWarning` / `showStatus`）。本项目正是利用这一点：可恢复状态用 `info` 输出，避免 Pi 给多行提示加上 `Error:`，同时自己用 `theme.fg` 上色：

```typescript
function notifyManualMergeMessage(message: string, ctx: ExtensionCommandContext): void {
	// This is a recoverable state, not an extension error. Use an info
	// notification so Pi does not prepend "Error:", while retaining the
	// normal log in the text colour and highlighting the required next steps.
	ctx.ui.notify(formatManualMergeMessageForDisplay(message, ctx.ui.theme), "info");
}
```

#### 本项目中的实际用例

`confirm` —— 带标题与多行正文：

```typescript
		const confirmed = await ctx.ui.confirm("Sync plan", formatSyncPlanMessage(plan));
		if (!confirmed) {
			ctx.ui.notify("pi-sync: Sync cancelled before changes were made.", "warning");
			return null;
		}
```

`select` —— 传字符串数组、用返回的字符串反查内部枚举：

```typescript
	const selectedLabel = await ctx.ui.select(
		"Sync conflict detected",
		conflictChoices.map((item) => item.label),
	);
	const choice = conflictChoices.find((item) => item.label === selectedLabel)?.choice;
```

`input` —— 带占位符，空值即视为取消：

```typescript
		gitUrl = await ctx.ui.input(
			"Enter your config repo Git URL:",
			"git@github.com:you/pi-config.git",
		);
		if (!gitUrl) {
			ctx.ui.notify("Setup cancelled.", "warning");
			return;
		}
```

`theme.fg` + `notify` —— 自定义前缀与配色：

```typescript
	const color = notification.level === "info" ? "accent" : notification.level;
	ctx.ui.notify(ctx.ui.theme.fg(color, `◆ ${notification.message}`), notification.level);
```

`onTerminalInput` —— 用 `pi-tui` 的 `matchesKey` 识别 Esc 并 `consume` 掉，实现长任务取消：

```typescript
				onCancel:
					ctx.mode === "tui"
						? (cancel) =>
								ctx.ui.onTerminalInput((data) => {
									if (!matchesKey(data, "escape")) return;
									cancel();
									return { consume: true };
								})
						: undefined,
```

`custom` —— 最小可用的只读文本查看器（实现 `render` / `invalidate` / `handleInput` 三个方法即满足 `Component`）：

```typescript
async function showOutput(ctx: ExtensionCommandContext, text: string): Promise<void> {
	await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
		const lines = text.split("\n");
		return {
			render: (_w: number) => lines.map((l) => theme.fg("text", l)),
			invalidate: () => {},
			handleInput: () => done(),
		};
	});
}
```

### 6.2 `ExtensionContext` 的其余字段

来源：`dist/core/extensions/types.d.ts` 的 `ExtensionContext`。

| 成员 | 说明 |
|------|------|
| `ui` | 上表 |
| `mode: "tui" \| "rpc" \| "json" \| "print"` | 运行模式；TUI 专属能力（`custom`、组件工厂、终端输入）必须先判 `mode === "tui"` |
| `hasUI: boolean` | TUI 与 RPC 为 `true`，print(`-p`) 与 json 为 `false`；调用对话框类方法前应先判它 |
| `cwd` | 当前工作目录 |
| `sessionManager` | 只读会话管理器 |
| `modelRegistry` / `model` / `scopedModels` / `thinkingLevel` | 模型与鉴权信息 |
| `signal: AbortSignal \| undefined` | 当前 agent 轮次的中止信号，空闲时为 `undefined` |
| `isIdle()` / `abort()` / `hasPendingMessages()` | 流程控制 |
| `isProjectTrusted()` | 项目级信任是否生效 |
| `shutdown()` | 请求优雅退出（会先发 `session_shutdown`） |
| `getContextUsage()` / `compact(options?)` / `getSystemPrompt()` | 上下文用量、触发压缩、读当前系统提示 |

本项目对 `hasUI` 与 `mode` 的守卫用法：

```typescript
	if (!ctx.hasUI) {
		ctx.ui.notify(
			"pi-sync: Synchronization requires an interactive confirmation. Run /pisync in a Pi session with a UI.",
			"warning",
		);
		return null;
	}
```

```typescript
					`pi-sync [${formatElapsed(elapsedMs)}] ${message}${ctx.mode === "tui" ? " — Esc to cancel" : ""}`,
```

### 6.3 `ExtensionCommandContext`（仅命令 handler）

来源：`dist/core/extensions/types.d.ts`。在 `ExtensionContext` 基础上多出：

| 方法 | 说明 |
|------|------|
| `getSystemPromptOptions()` | 当前系统提示的构造输入（含上下文文件内容，属敏感数据） |
| `waitForIdle()` | 等 agent 完全静默（含重试、自动压缩、排队续跑） |
| `newSession(options?)` | 新建会话，支持 `setup` 与 `withSession` 回调 |
| `fork(entryId, options?)` | 从某条目 fork，`position: "before" \| "at"` |
| `navigateTree(targetId, options?)` | 树内导航 |
| `switchSession(sessionPath, options?)` | 切换会话文件 |
| `reload()` | 等价于 `/reload`：重载扩展、技能、提示模板、主题、上下文文件 |

`reload()` 的关键语义（`docs/extensions.md` §ctx.reload）：它会为当前扩展运行时发 `session_shutdown`，然后重载资源并发 `session_start(reason: "reload")`；**但当前 handler 仍然在旧代码的调用栈里继续执行**，因此约定写成 `await ctx.reload(); return;`，把 reload 当作 handler 的终点。工具（`ExtensionContext`）不能直接 reload，官方建议由工具排队一条 `/命令` 作为 follow-up 消息来触发。

本项目的 reload 提示流程：

```typescript
	if (result.reload) {
		const shouldReload = await ctx.ui.confirm(
			"Reload Pi?",
			"Synchronization updated your configuration. Reload Pi now to apply the changes?",
		);
		if (shouldReload) await ctx.reload();
	}
```

### 6.4 向 agent 投递消息

来源：`dist/core/extensions/types.d.ts`；`docs/extensions.md` §pi.sendUserMessage。

```typescript
sendUserMessage(content: string | (TextContent | ImageContent)[], options?: {
    deliverAs?: "steer" | "followUp";
    expandPromptTemplates?: boolean;
}): void;
```

agent 正在流式输出时**必须**给 `deliverAs`，否则抛错：`"steer"` 在当前助手轮次的工具调用执行完后插入，`"followUp"` 等全部工具结束。空闲时可省略，立即触发新一轮。

本项目按 `ctx.isIdle()` 分支：

```typescript
		if (ctx.isIdle()) pi.sendUserMessage(prompt);
		else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
```

另外 `pi.sendMessage()` 发的是自定义消息（配合 `registerMessageRenderer`，参与 LLM 上下文），`pi.appendEntry()` 存的是自定义条目（配合 `registerEntryRenderer`，**不**参与 LLM 上下文，用于跨重启持久化扩展状态）。

---

## 7. 状态栏 / footer

来源：`dist/core/extensions/types.d.ts`；`dist/modes/interactive/interactive-mode.js`（`setExtensionStatus`）；`dist/modes/interactive/components/footer.js`；`dist/core/footer-data-provider.js`。

```typescript
setStatus(key: string, text: string | undefined): void;
```

- `key` 是扩展自己的命名空间，同一 key 重复设置即覆盖，传 `undefined` 清除。
- 实现链路：`ctx.ui.setStatus` → `interactiveMode.setExtensionStatus` → `footerDataProvider.setExtensionStatus` → `ui.requestRender()`。
- footer 渲染时把所有扩展状态**按 key 字母序排序**、做 `sanitizeStatusText`、用空格连接成一行，再按终端宽度截断（超出部分显示 dim 的 `...`）。所以状态文案应尽量短。
- 状态文本里可以带 ANSI（用 `ctx.ui.theme.fg(...)` 上色），官方示例即 `ctx.ui.setStatus("my-ext", ctx.ui.theme.fg("accent", "● active"))`。
- `setFooter(factory)` 可以整体替换 footer；工厂的第三个参数 `ReadonlyFooterDataProvider` 提供了「其它途径拿不到」的数据：git 分支和各扩展通过 `setStatus` 设置的状态。token 统计、模型信息等应从 `ctx.sessionManager` / `ctx.model` 取。
- `setWidget(key, content, { placement })` 是另一条展示通道：编辑器上方（默认 `aboveEditor`）或下方常驻，内容可以是字符串数组或组件工厂。

本项目把状态栏收敛成一个小模块（`src/extension/status-manager.ts`），保证 key 唯一且清除逻辑集中：

```typescript
const STATUS_KEY = "pi-sync";

export enum SyncStatus {
	None = "",
	SyncNeeded = "Sync needed",
}

export function setStatus(ui: StatusUi, status: SyncStatus): void {
	ui.setStatus(STATUS_KEY, status || undefined);
}
```

注意这里用了结构化的最小接口 `StatusUi { setStatus(key, value): void }` 而不是直接依赖 `ExtensionUIContext`——这样业务代码不必依赖整个 Pi 类型，也便于测试。

---

## 8. 目录约定

### 8.1 `PI_CODING_AGENT_DIR`

来源：`dist/config.js`。

```javascript
export const APP_NAME = piConfigName || "pi";
export const CONFIG_DIR_NAME = pkg.piConfig?.configDir || ".pi";
export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;

export function getAgentDir() {
    const envDir = process.env[ENV_AGENT_DIR];
    if (envDir) return expandTildePath(envDir);
    return join(homedir(), CONFIG_DIR_NAME, "agent");
}
```

要点：

- 环境变量名是**按 `APP_NAME` 动态生成的**：官方发行版 `APP_NAME = "pi"` → `PI_CODING_AGENT_DIR`；rebrand 的分发版会是别的名字（`docs/development.md` §Forking / Rebranding 说明 `piConfig.name` / `piConfig.configDir` 可改）。
- 默认值 `~/.pi/agent`，支持 `~` 展开。
- 相关环境变量（`docs/environment-variables.md`）：`PI_CODING_AGENT_SESSION_DIR`（会话目录，被 `--session-dir` 覆盖）、`PI_PACKAGE_DIR`（包目录，用于 Nix/Guix）、`PI_OFFLINE`、`PI_SKIP_VERSION_CHECK`。
- 进程标记：Pi 会给子进程设置 `AI_AGENT=pi` 与 `PI_CODING_AGENT=true`；bash 工具还会注入 `PI_SESSION_ID`、`PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL`、`PI_REASONING_LEVEL`。

### 8.2 `~/.pi/agent`（agentDir）下各条目

`dist/config.js` 中有明确 getter 的项：

| 路径 | 来源 | 用途 |
|------|------|------|
| `settings.json` | `getSettingsPath()` | 全局设置，含 `packages` / `extensions` / `skills` / `prompts` / `themes` |
| `auth.json` | `getAuthPath()` | `/login` 保存的凭据 |
| `models.json` | `getModelsPath()` | 自定义 provider / model 覆盖 |
| `themes/` | `getCustomThemesDir()` | 用户自定义主题 `.json` |
| `prompts/` | `getPromptsDir()` | 提示模板 `.md` |
| `sessions/` | `getSessionsDir()` | 会话 JSONL，按工作目录组织 |
| `tools/` | `getToolsDir()` | 工具目录（`dist/migrations.js` 显示托管二进制已从 `tools/` 迁到 `bin/`） |
| `bin/` | `getBinDir()` | 托管二进制（`fd`、`rg`） |
| `pi-debug.log` | `getDebugLogPath()` | `/debug` 命令输出，文件名为 `${APP_NAME}-debug.log` |

其它在源码/文档中出现、由各子系统各自 join 的路径：

| 路径 | 来源 | 用途 |
|------|------|------|
| `extensions/` | `dist/core/extensions/loader.js` | 全局目录扩展自动发现根 |
| `skills/` | `dist/core/skills.js`、`dist/core/resource-loader.js` | 全局技能 |
| `npm/` | `dist/core/package-manager.js` | npm 包安装根（`npm/node_modules/<pkg>`，附 `package.json` / `package-lock.json`） |
| `git/` | `dist/core/package-manager.js` | git 包 clone 根（`git/<host>/<path>`） |
| `tmp/extensions/` | `getExtensionTempFolder()` | `pi -e npm:/git:` 的临时安装位置，目录权限 `0700` |
| `keybindings.json` | `dist/core/keybindings.js` | 自定义键位；改后 `/reload` 生效 |
| `trust.json` | `dist/core/trust-manager.js` | 项目信任决策 |
| `AGENTS.md` | `docs/usage.md` | 全局 agent 指令（上下文文件） |
| `SYSTEM.md` / `APPEND_SYSTEM.md` | `dist/core/resource-loader.js` | 全局系统提示（替换 / 追加） |
| `models-store.json` | `docs/providers.md` | 动态网关模型目录缓存 |

项目级对应目录为 `<cwd>/.pi/`：`settings.json`、`extensions/`、`skills/`、`prompts/`、`themes/`、`npm/`、`git/`、`SYSTEM.md`、`APPEND_SYSTEM.md`，全部需要项目被信任后才加载。

设置文件里的相对路径解析基准（`docs/settings.md` §Resources）：`~/.pi/agent/settings.json` 里的相对路径相对 `~/.pi/agent`；`.pi/settings.json` 里的相对 `.pi`；绝对路径与 `~` 均支持。

---

## 9. 开发与调试

### 9.1 快速试跑：`pi -e`

来源：`docs/usage.md` CLI 表、`docs/packages.md`、`docs/extensions.md` 顶部提示。

```bash
pi -e ./index.ts            # 加载本地扩展文件（可重复）
pi -e npm:@foo/bar          # 临时安装 npm 包，仅本次运行有效
pi -e git:github.com/u/repo # 同上，git 源
pi --no-extensions -e ./index.ts   # 关掉自动发现，只跑这一个扩展，便于隔离排查
```

`-e` 装到临时目录（`~/.pi/agent/tmp/extensions/`），不写 settings。官方明确建议：`-e` 只用于快速验证，**因为它不在自动发现位置，享受不到 `/reload` 热重载**。

### 9.2 常驻开发：软链 + `/reload`

`docs/extensions.md` 的提示是「把扩展放进 `~/.pi/agent/extensions/`（全局）或 `.pi/extensions/`（项目级）以获得自动发现，这些位置的扩展可以用 `/reload` 热重载」。

由于 `discoverExtensionsInDir` 显式支持符号链接目录，且 `resolveExtensionEntries` 会读取该目录里的 `package.json` → `pi.extensions`，把开发仓库软链进去即可：

```bash
ln -s /workspace/pi-sync ~/.pi/agent/extensions/pi-sync
# 在 Pi 会话中改完代码后：
/reload
```

Pi 会因此加载 `/workspace/pi-sync/index.ts`（`pi.extensions: ["./index.ts"]`）。

**未在源码中确认**：官方文档没有把「`ln -s` 到 `extensions/` + `/reload`」写成推荐工作流，也没有说明 `/reload` 对软链目标的缓存行为（`loader.js` 有一个 `extensionCache`，但 `clearExtensionCache()` 的触发时机与 `/reload` 的关系未逐行核实）。上面的做法是从「符号链接被显式支持」+「自动发现位置可热重载」两条源码/文档事实推出的，实际使用前建议验证一次。

### 9.3 `/reload` 覆盖范围

`docs/usage.md` 命令表：`/reload` 重新加载 **keybindings、extensions、skills、prompts、themes 和上下文文件**。它等价于 `ctx.reload()`，同样会走 `session_shutdown` → 重载 → `session_start(reason: "reload")`。

不需要 `/reload` 的情况：

- `pi.registerTool()` 在运行期注册的工具立即可用（`docs/extensions.md` §Dynamic Tool Loading）。
- 加载阶段之后调用的 `pi.registerProvider()` / `unregisterProvider()` 立即生效。

### 9.4 错误处理与模式差异

来源：`docs/extensions.md` §Error Handling、§Mode Behavior。

- 扩展抛错会被记录，agent 继续运行；`tool_call` 处理器抛错则**拦截该工具调用**（fail-safe）。
- 工具 `execute` 内部的失败必须靠 `throw` 表达，Pi 会捕获、以 `isError: true` 反馈给 LLM 并继续。
- 模式对照：

| 模式 | `ctx.mode` | `ctx.hasUI` | 说明 |
|------|-----------|-------------|------|
| 交互 | `"tui"` | `true` | 完整 TUI |
| RPC (`--mode rpc`) | `"rpc"` | `true` | 对话框/通知走 JSON 协议；`custom()` 返回 `undefined` |
| JSON (`--mode json`) | `"json"` | `false` | 事件流到 stdout；UI 方法是 no-op |
| Print (`-p`) | `"print"` | `false` | 扩展会运行但无法提问 |

### 9.5 安全提醒

`docs/packages.md` / `docs/extensions.md` 都有明确警示：**扩展以用户完整系统权限执行任意代码**，pi 包同理（技能还能指挥模型执行任意动作）。安装第三方包前应审阅源码。项目级扩展与项目级设置只在项目被信任后才加载，这是 Pi 侧的主要防线。

---

## 10. 速查：写一个最小扩展

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // 1) 事件：会话级资源在这里启动，在 session_shutdown 里清理
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("my-ext", ctx.ui.theme.fg("accent", "● ready"));
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus("my-ext", undefined);
  });

  // 2) 命令：ctx 是 ExtensionCommandContext，可用 reload/newSession 等
  pi.registerCommand("my-cmd", {
    description: "Do something",
    getArgumentCompletions: (prefix) =>
      ["alpha", "beta"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    async handler(args, ctx) {
      if (!ctx.hasUI) {
        ctx.ui.notify("my-ext: needs an interactive session.", "warning");
        return;
      }
      const ok = await ctx.ui.confirm("Proceed?", `args = ${args || "(none)"}`);
      ctx.ui.notify(ok ? "done" : "cancelled", "info");
    },
  });
}
```

配套 `package.json` 最小声明：

```json
{
  "name": "my-extension",
  "type": "module",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./index.ts"] },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*"
  }
}
```

---

## 附：本文中标注为「未在源码中确认」的条目

1. `keywords` 中的 `pi-extension` 标签在 Pi 源码与文档中均未出现，作用未确认（§2）。
2. 「`ln -s` 开发目录到 `extensions/` + `/reload`」作为推荐开发工作流，官方文档未明确记载；`/reload` 与 `loader.js` 中 `extensionCache` 对软链目标的缓存交互未逐行核实（§9.2）。

除以上两条外，本文所有 API 签名、事件名、目录路径均取自本机安装的 Pi 源码（`dist/`）或官方文档（`docs/`），并在各节标注了来源文件。
