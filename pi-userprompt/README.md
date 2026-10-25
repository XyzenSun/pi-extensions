# pi-userprompt

将 `USER.md` 中的日常偏好作为请求级 `user` 消息提供给 pi. 保持 system prompt 不变, 对话压缩后仍携带文件原文.

## 使用

npm 发布后安装:

```bash
pi install npm:@xyzensun/pi-userprompt
```

在仓库中临时加载:

```bash
pi -e ./pi-userprompt/index.ts
```

也可以将本地包加入 pi 配置:

```bash
pi install ./pi-userprompt
```

全局文件为 `~/.pi/agent/USER.md`, 项目文件为 `<当前工作目录>/.pi/USER.md`. 文件名区分大小写. 项目文件优先, 只有不存在时才回退到全局文件, 两份不会合并. 项目文件为空时不注入任何内容, 可以用它停用当前项目的全局偏好. 项目查找不会向父目录遍历.

全局目录跟随 pi 的 `PI_CODING_AGENT_DIR` 设置. 项目文件仅在 `ctx.isProjectTrusted()` 为真时读取, 未受信任时使用全局文件. `USER.md` 是本扩展的约定, pi 不会仅因存在这个文件就弹出信任提示; 需要时先通过 `/trust` 信任工作目录, 然后执行 `/reload`.

文件使用普通 Markdown, 没有 frontmatter 或变量替换:

```markdown
以下是我的日常偏好, 当前任务有明确要求时优先遵循当前任务:
- 简单问题简短回答.
- 解释时先给结论.
- 不主动展开与当前任务无关的背景.
```

扩展在启动、新建、恢复会话和 `/reload` 的 `session_start` hook 中读取文件. 修改、删除或新增文件后执行 `/reload` 生效. 没有文件或正文为空时不注入; 读取出错时报告警告并停用注入, 不沿用旧内容. 扩展不会创建或修改文件.

## 请求与压缩

扩展使用 pi 的 `context` hook, 在每次主对话模型请求前将正文放在历史对话前面, 角色为 `user`. pi 自己负责恢复 system prompt 和工具声明. 本扩展不改工具权限, 不会主动触发模型请求, 也不加命令或后台文件监听.

请求结构为 `system → USER.md 对应的 user 消息 → 历史对话/压缩摘要 → 当前任务`. 工具调用后的后续请求也会携带同一份正文. 连续的 user 消息可能由 provider 合并, 但内容仍属于 user 角色.

这条消息仅存在于请求副本, 不写入会话历史, 因此不会出现在正常聊天记录或会话导出中, 也不会参与历史压缩. 压缩后下一次主对话请求重新注入原文, 无须依赖摘要保留偏好. 压缩模型本身和其他扩展发起的独立模型请求不经过本扩展. 每次请求仍会占用对应 token, 建议正文保持简短. 其他扩展之后的上下文 hook 仍可能修改或删除它.

文件不随会话保存. 恢复会话时使用当时的文件内容; 在其他机器恢复时也需要提供相应文件. 文件内容会发送给当前模型服务商, 不要放入无关凭证或敏感信息.

## 开发

```bash
cd pi-userprompt
npm ci --ignore-scripts
npm run typecheck
npm test
```

测试使用临时配置目录、真实 pi 扩展加载器、`ExtensionRunner` 和 `SessionManager` 验证 hook 与压缩后的请求投影, 不调用模型 API. 当前在 pi 1.4.0 验证, 保持 TypeScript 源码直接加载, 没有构建步骤.

## 发布

首版为 `@xyzensun/pi-userprompt@0.1.0`. 后续发布前更新 `package.json` 和依赖锁文件中的版本, 在 GitHub Actions 手动触发 `Publish pi-userprompt`, 选择 `main` 分支. workflow 安装锁定依赖并执行类型检查和测试, 全部通过后发布公开 npm 包. 鉴权使用仓库 Actions secret `NPM_TOKEN`, 不在本地发布.

## License

MIT.
