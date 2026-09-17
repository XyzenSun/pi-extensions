# pi-hooks 子项目规范

本目录是独立插件包 `@xyzensun/pi-hooks`（配置驱动 hook 引擎），父仓库规则见根目录 AGENTS.md，冲突时以本文为准。

## 目录约定

TS 源码即发布产物，零构建。`index.ts` 为入口（package.json 的 pi manifest 指向它），`src/` 按模块分层，依赖方向单向：`index.ts → adapters.ts → { matcher, runner, protocol } → config.ts`，禁止反向引用。`lib/lib.sh` 与 `examples/*.sh` 是 bash，随包发布但不参与编译；`doc/` 三份文档分工：design.md 讲抽象设计思路，research.md 是调研结论存档，development.md 是开发参考（模块职责、协议数据流、测试方式、扩展点），改代码必须同步对应文档。

## 核心不变量

改动任何代码前先确认没有破坏这几条，它们是引擎的生存底线：

所有事件 handler 顶层 try/catch 兜底，绝不向 pi 事件层抛错——`tool_call` 在 pi runner 内层无异常隔离，抛错等于工具被幻影拦截。执行层 `runHook` 的所有异常路径转为 `ExecOutcome` 返回，这是第二道防线。配置问题（语法错误、校验失败）必须显式报错，不允许静默失效。协议保持 JSON-only：stdout 非空必须是对象，非法时提示改用 `hook_out`，不引入纯文本宽容。`config.ts` 的 `PI_EVENTS` 白名单是 36 个事件名的唯一事实来源，pi 升级时只改这里。

## 开发与测试

```bash
cd pi-hooks
npx tsc --noEmit                             # 类型检查
npx tsx test/config-matcher-protocol.test.ts # 纯函数冒烟
npx tsx test/runner.test.ts                  # 执行层冒烟
```

小改动做定向验证（上述三项）；大版本更新才做全量端到端（真实 pi 加载 + 拦截/注入链路），且全量测试前与用户确认。端到端验证注入链路时用 `before_provider_request` 检查 payload，不要依赖模型对注入指令的遵循度。

本地临时加载：`pi -e ./pi-hooks/index.ts`。

## 发布

不在本地执行 npm publish。发布前确认 package.json 的 version 已更新，然后提醒用户到 GitHub 手动触发 pi-hooks 的发布 workflow（workflow 文件按仓库约定与用户确认后再创建）。
