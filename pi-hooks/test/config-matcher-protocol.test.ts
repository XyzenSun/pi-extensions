// 冒烟测试：config 校验、matcher 目标串、protocol 解析
import { parseFileContent } from "../src/config.ts";
import { buildTarget, matches } from "../src/matcher.ts";
import { interpret, parseStdout } from "../src/protocol.ts";

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else console.log(`ok: ${msg}`);
}

// ── config 校验 ──
const good = parseFileContent(
  JSON.stringify({
    hooks: [
      { on: "tool_call", match: "^bash\\(", run: "./check.sh", timeout: 5 },
      { on: "input", run: "echo hi | hook_out" },
      { on: "context", run: "cat f | hook_out", enabled: false },
    ],
  }),
  "global",
  "/tmp/g.json",
);
assert(good.hooks.length === 3, "3 条合法条目通过");
assert(good.problems.length === 0, "无问题");
assert(good.hooks[0].match instanceof RegExp, "match 编译为 RegExp");
assert(good.hooks[2].enabled === false, "enabled 默认 true、显式 false 生效");

const bad = parseFileContent(
  JSON.stringify({
    hooks: [
      { on: "nope", run: "x" }, // 未知事件
      { on: "tool_call" }, // 缺 run
      { on: "tool_call", run: "x", match: "(" }, // 非法正则
      { on: "tool_call", run: "x", timeout: -1 }, // 非法 timeout
      { on: "input", run: "ok" }, // 合法
    ],
  }),
  "project",
  "/tmp/p.json",
);
assert(bad.hooks.length === 1, "4 条非法被拒、1 条通过");
assert(bad.problems.length === 4, "4 条问题报告");

const syntaxErr = parseFileContent("{ broken", "global", "/tmp/b.json");
assert(syntaxErr.hooks.length === 0 && syntaxErr.problems.length === 1, "JSON 语法错误整份不生效");

// ── matcher 目标串 ──
assert(
  buildTarget({ type: "tool_call", toolName: "bash", input: { command: "git push origin main" }, toolCallId: "1" } as never) ===
    "bash(git push origin main)",
  "bash 目标串",
);
assert(
  buildTarget({ type: "tool_call", toolName: "edit", input: { path: "src/a.ts" }, toolCallId: "2" } as never) === "edit(src/a.ts)",
  "edit 目标串",
);
assert(
  buildTarget({ type: "tool_call", toolName: "custom_tool", input: { x: 1 }, toolCallId: "3" } as never) === "custom_tool",
  "自定义工具退化为工具名",
);
assert(buildTarget({ type: "input", text: "你好", source: "interactive" } as never) === "你好", "input 目标串");
assert(buildTarget({ type: "agent_start" } as never) === undefined, "通知事件无目标串");

assert(matches(new RegExp("^bash\\("), "bash(git push)"), "锚定匹配 bash");
assert(!matches(new RegExp("^bash\\("), "edit(bash)"), "锚定不误伤 edit(bash)");
assert(matches(undefined, undefined), "无 match 放行");
assert(!matches(new RegExp("x"), undefined), "有 match 无目标串则跳过");

// ── protocol ──
assert(interpret({ code: 0, stdout: "", stderr: "", timedOut: false, killed: false }).kind === "none", "exit 0 空 stdout = none");
assert(interpret({ code: 0, stdout: '{"content":"hi"}', stderr: "", timedOut: false, killed: false }).kind === "output", "合法 JSON = output");
assert(interpret({ code: 0, stdout: "plain text", stderr: "", timedOut: false, killed: false }).kind === "error", "纯文本 = error");
assert(interpret({ code: 0, stdout: "[1,2]", stderr: "", timedOut: false, killed: false }).kind === "error", "JSON 数组 = error");
assert(interpret({ code: 2, stdout: "", stderr: "危险命令", timedOut: false, killed: false }).kind === "block", "exit 2 = block");
assert(
  (interpret({ code: 2, stdout: "", stderr: "危险命令", timedOut: false, killed: false }) as { reason: string }).reason === "危险命令",
  "stderr 是理由",
);
assert(interpret({ code: 1, stdout: "", stderr: "boom", timedOut: false, killed: false }).kind === "error", "exit 1 = error");
assert(interpret({ code: null, stdout: "", stderr: "", timedOut: true, killed: true }).kind === "error", "超时 = error");

const parsed = parseStdout('{"to":"message","content":"已对话 10 轮"}');
assert(parsed?.to === "message" && parsed?.content === "已对话 10 轮", "to+content 解析");

process.exit(failed > 0 ? 1 : 0);
