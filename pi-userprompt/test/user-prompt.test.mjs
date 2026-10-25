import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { ExtensionRunner, SessionManager } from "@earendil-works/pi-coding-agent";
import { loadUserPrompt } from "../user-prompt.ts";

// 使用当前安装的 pi 加载器和 runner, 验证真实 hook 契约, 不伪造 ExtensionAPI.
const piRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const { loadExtensions } = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")));
const entryPath = fileURLToPath(new URL("../index.ts", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-userprompt-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, cwd, agentDir, projectFile: join(cwd, ".pi/USER.md"), globalFile: join(agentDir, "USER.md") };
}

async function harness(t, files) {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = files.agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  const loaded = await loadExtensions([entryPath], files.cwd);
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.warnings, []);
  assert.equal(loaded.extensions.length, 1);
  const manager = SessionManager.inMemory(files.cwd);
  // 这些事件不访问 modelRegistry, 无须创建模型或读取凭证.
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, files.cwd, manager, undefined);
  const errors = [];
  runner.onError((error) => errors.push(error));
  t.after(() => assert.deepEqual(errors, []));
  await runner.emit({ type: "session_start", reason: "startup" });
  return { runner, manager, extension: loaded.extensions[0] };
}

function userMessage(text, timestamp = 100) {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function systemMessage() {
  return {
    role: "system",
    content: "",
    sections: {
      preamble: "Original assistant identity",
      tools: "<tools>Original tool guidance</tools>",
      docs: "<docs>Original documentation</docs>",
      project_context: "<project_context>Original AGENTS.md</project_context>",
      skills: "<skills>Original skills</skills>",
    },
    toolsAdded: [{ name: "read", description: "Read files", parameters: { type: "object", properties: {} } }],
    timestamp: 1,
  };
}

function promptCount(messages, text) {
  return messages.filter((message) => message.role === "user" && message.content?.some((part) => part.text === text)).length;
}

async function fileSnapshot(directory) {
  const snapshot = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(snapshot, await fileSnapshot(path));
    else snapshot[path] = await readFile(path, "utf8");
  }
  return snapshot;
}

test("没有文件时不加载任何正文", async (t) => {
  const files = await fixture(t);
  assert.equal(await loadUserPrompt(files.cwd, files.agentDir, true), undefined);
});

test("全局文件保留 Markdown 和空白, 只移除 BOM", async (t) => {
  const files = await fixture(t);
  await writeFile(files.globalFile, "\uFEFF# Preferences\n\n- 简短回答.\n");
  assert.equal(await loadUserPrompt(files.cwd, files.agentDir, true), "# Preferences\n\n- 简短回答.\n");
});

test("项目文件覆盖全局文件, 两份不合并", async (t) => {
  const files = await fixture(t);
  await writeFile(files.globalFile, "Global preferences");
  await writeFile(files.projectFile, "Project preferences");
  assert.equal(await loadUserPrompt(files.cwd, files.agentDir, true), "Project preferences");
});

test("空项目文件停用全局正文", async (t) => {
  const files = await fixture(t);
  await writeFile(files.globalFile, "Global preferences");
  await writeFile(files.projectFile, "\uFEFF \n\t ");
  assert.equal(await loadUserPrompt(files.cwd, files.agentDir, true), undefined);
});

test("空全局文件不注入", async (t) => {
  const files = await fixture(t);
  await writeFile(files.globalFile, " \n ");
  assert.equal(await loadUserPrompt(files.cwd, files.agentDir, true), undefined);
});

test("未受信任的项目不加载项目文件", async (t) => {
  const files = await fixture(t);
  await writeFile(files.globalFile, "Global preferences");
  await writeFile(files.projectFile, "Project preferences");
  assert.equal(await loadUserPrompt(files.cwd, files.agentDir, false), "Global preferences");
  await rm(files.globalFile);
  assert.equal(await loadUserPrompt(files.cwd, files.agentDir, false), undefined);
});

test("不会向父目录查找项目文件", async (t) => {
  const files = await fixture(t);
  await writeFile(files.projectFile, "Parent preferences");
  await writeFile(files.globalFile, "Global preferences");
  const nestedCwd = join(files.cwd, "nested");
  await mkdir(nestedCwd);
  assert.equal(await loadUserPrompt(nestedCwd, files.agentDir, true), "Global preferences");
});

test("读取错误报告文件位置, 不静默回退全局文件", async (t) => {
  const files = await fixture(t);
  await writeFile(files.globalFile, "Global preferences");
  await mkdir(files.projectFile);
  await assert.rejects(loadUserPrompt(files.cwd, files.agentDir, true), (error) => {
    assert.match(error.message, /无法读取/);
    assert.ok(error.message.includes(files.projectFile));
    return true;
  });
});

test("仅注册 session_start 与 context hook", async (t) => {
  const files = await fixture(t);
  const { extension } = await harness(t, files);
  assert.deepEqual([...extension.handlers.keys()].sort(), ["context", "session_start"]);
  assert.equal(extension.commands.size, 0);
  assert.equal(extension.tools.size, 0);
});

test("context 注入 user 角色, 保持 system、工具和原历史不变", async (t) => {
  const files = await fixture(t);
  await writeFile(files.globalFile, "Global preferences");
  const { runner, manager } = await harness(t, files);
  const messages = [systemMessage(), userMessage("Current task")];
  const original = structuredClone(messages);
  const projected = await runner.emitContext(messages);
  assert.deepEqual(projected[0], messages[0]);
  assert.equal(projected[1].role, "user");
  assert.deepEqual(projected[1].content, [{ type: "text", text: "Global preferences" }]);
  assert.deepEqual(projected[2], messages[1]);
  assert.deepEqual(messages, original);
  assert.deepEqual(manager.getEntries(), []);
});

test("没有正文时 context 保持原消息不变", async (t) => {
  const files = await fixture(t);
  const { runner } = await harness(t, files);
  const messages = [systemMessage(), userMessage("Current task")];
  assert.deepEqual(await runner.emitContext(messages), messages);
});

test("工具结果后的请求仍注入一份, 保持 tool call 与结果配对", async (t) => {
  const files = await fixture(t);
  await writeFile(files.globalFile, "Global preferences");
  const { runner } = await harness(t, files);
  const messages = [
    systemMessage(),
    userMessage("Read a file"),
    { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "sample.ts" } }], timestamp: 200 },
    { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "File content" }], isError: false, timestamp: 300 },
  ];
  const original = structuredClone(messages);
  const projected = await runner.emitContext(messages);
  assert.equal(promptCount(projected, "Global preferences"), 1);
  assert.deepEqual(projected.slice(2), messages.slice(1));
  assert.deepEqual(messages, original);
});

test("每次请求只注入一份, 元数据稳定, 请求副本修改不污染下一次", async (t) => {
  const files = await fixture(t);
  await writeFile(files.globalFile, "Global preferences");
  const { runner } = await harness(t, files);
  const messages = [systemMessage(), userMessage("Current task")];
  const first = await runner.emitContext(messages);
  const second = await runner.emitContext(messages);
  assert.deepEqual(first, second);
  assert.equal(promptCount(first, "Global preferences"), 1);
  assert.equal(promptCount(second, "Global preferences"), 1);
  first[1].content[0].text = "Modified by a later hook";
  const third = await runner.emitContext(messages);
  assert.equal(promptCount(third, "Global preferences"), 1);
});

test("编辑文件后保持缓存, reload 后加载新正文, 删除后停用", async (t) => {
  const files = await fixture(t);
  await writeFile(files.globalFile, "Original preferences");
  const { runner } = await harness(t, files);
  const messages = [userMessage("Current task")];
  await writeFile(files.globalFile, "Updated preferences");
  assert.equal(promptCount(await runner.emitContext(messages), "Original preferences"), 1);
  await runner.emit({ type: "session_start", reason: "reload" });
  assert.equal(promptCount(await runner.emitContext(messages), "Updated preferences"), 1);
  await rm(files.globalFile);
  await runner.emit({ type: "session_start", reason: "reload" });
  assert.deepEqual(await runner.emitContext(messages), messages);
});

test("新建与恢复会话事件重新加载, 不会累积旧正文", async (t) => {
  const files = await fixture(t);
  await writeFile(files.globalFile, "Initial preferences");
  const { runner } = await harness(t, files);
  const messages = [userMessage("Current task")];
  for (const reason of ["new", "resume"]) {
    await writeFile(files.globalFile, `${reason} preferences`);
    await runner.emit({ type: "session_start", reason });
    const projected = await runner.emitContext(messages);
    assert.equal(projected.length, 2);
    assert.equal(promptCount(projected, `${reason} preferences`), 1);
  }
});

test("读取失败后清除旧正文, 无 UI 模式只向 stderr 报告", async (t) => {
  const files = await fixture(t);
  await writeFile(files.globalFile, "Old preferences");
  const { runner } = await harness(t, files);
  await rm(files.globalFile);
  await mkdir(files.globalFile);
  const warnings = [];
  const originalWrite = process.stderr.write;
  // 只校准错误输出接口, 文件访问和事件分发继续使用真实实现.
  process.stderr.write = (chunk) => { warnings.push(String(chunk)); return true; };
  try {
    await runner.emit({ type: "session_start", reason: "reload" });
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes(files.globalFile));
  const messages = [userMessage("Current task")];
  assert.deepEqual(await runner.emitContext(messages), messages);
});

test("真实 SessionManager 压缩投影后重新携带原文, 不落盘、不写历史", async (t) => {
  const files = await fixture(t);
  await writeFile(files.globalFile, "Persistent preferences");
  const beforeFiles = await fileSnapshot(files.root);
  const { runner, manager } = await harness(t, files);
  manager.appendMessage(systemMessage());
  manager.appendMessage(userMessage("Old task"));
  const keptId = manager.appendMessage(userMessage("Recent task", 200));
  const beforeProjection = await runner.emitContext(manager.buildSessionContext().messages);
  assert.equal(promptCount(beforeProjection, "Persistent preferences"), 1);

  // 直接记录压缩结果来验证 pi 的上下文重建, 不调用摘要模型或伪造其响应.
  manager.appendCompaction("Summary of old task", keptId, 1000);
  const compacted = manager.buildSessionContext().messages;
  assert.ok(compacted.some((message) => message.role === "compactionSummary"));
  assert.equal(promptCount(compacted, "Old task"), 0);
  assert.equal(promptCount(compacted, "Persistent preferences"), 0);
  const originalEntries = structuredClone(manager.getEntries());
  const projected = await runner.emitContext(compacted);
  assert.equal(projected[0].role, "system");
  assert.deepEqual(projected[0].sections, systemMessage().sections);
  assert.equal(promptCount(projected, "Persistent preferences"), 1);
  assert.equal(promptCount(projected, "Recent task"), 1);
  assert.ok(projected.some((message) => message.role === "compactionSummary"));
  assert.deepEqual(manager.getEntries(), originalEntries);

  manager.appendCompaction("Updated summary", null, 500);
  const repeatedProjection = await runner.emitContext(manager.buildSessionContext().messages);
  assert.equal(promptCount(repeatedProjection, "Persistent preferences"), 1);
  assert.equal(promptCount(repeatedProjection, "Recent task"), 0);
  assert.ok(repeatedProjection.some((message) => message.role === "compactionSummary"));
  assert.deepEqual(await fileSnapshot(files.root), beforeFiles);
});
