// 执行层冒烟：spawn、stdin JSON、env 注入、exit code、timeout、hook_out 链路
import { runHook, stateDirFor } from "../src/runner.ts";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else console.log(`ok: ${msg}`);
}

const agentDir = mkdtempSync(join(tmpdir(), "pi-hooks-test-"));
const libDir = new URL("../lib", import.meta.url).pathname;
const base = {
  eventName: "tool_call",
  payload: { type: "tool_call", toolName: "bash", input: { command: "git push" }, toolCallId: "t1" },
  hookId: "deadbeef1234",
  sessionId: "test-session",
  cwd: "/tmp",
  libDir,
  timeoutSeconds: 10,
};

// 1. stdin 收到事件 JSON + env 注入
{
  const out = await runHook(
    agentDir,
    `jq -r '.input.command' && echo "$PI_HOOK_EVENT $PI_HOOK_ID $PI_CWD" && ls "$PI_HOOK_LIB/lib.sh" > /dev/null && echo LIB_OK`,
    base,
  );
  assert(out.code === 0, "脚本 exit 0");
  assert(out.stdout.includes("git push"), "stdin 收到事件 JSON");
  assert(out.stdout.includes("tool_call deadbeef1234 /tmp"), "env 注入 PI_HOOK_EVENT/PI_HOOK_ID/PI_CWD");
  assert(out.stdout.includes("LIB_OK"), "PI_HOOK_LIB 指向 lib.sh");
}

// 2. exit 2 阻断语义
{
  const out = await runHook(agentDir, `echo "危险" >&2; exit 2`, base);
  assert(out.code === 2 && out.stderr.includes("危险"), "exit 2 + stderr 回收");
}

// 3. hook_out 链路（source lib.sh 后管道输出协议 JSON）
{
  const out = await runHook(
    agentDir,
    `source "$PI_HOOK_LIB/lib.sh"; printf '%s\\n' '多行' '带"引号"文本' | hook_out`,
    base,
  );
  assert(out.code === 0, "hook_out exit 0");
  const parsed = JSON.parse(out.stdout);
  assert(parsed.content === '多行\n带"引号"文本\n', "hook_out 转义多行+引号");
}

// 4. hook_out 带落点
{
  const out = await runHook(agentDir, `source "$PI_HOOK_LIB/lib.sh"; echo hi | hook_out message`, base);
  const parsed = JSON.parse(out.stdout);
  assert(parsed.to === "message" && parsed.content === "hi\n", "hook_out 指定落点");
}

// 5. timeout 收口
{
  const start = Date.now();
  const out = await runHook(agentDir, `sleep 60`, { ...base, timeoutSeconds: 1 });
  assert(out.timedOut === true, "1 秒超时触发");
  assert(Date.now() - start < 5000, "超时后及时返回（进程组被杀）");
}

// 6. 状态目录与 hook_every/hook_once
{
  const out = await runHook(
    agentDir,
    `source "$PI_HOOK_LIB/lib.sh"; hook_every 3 && echo "ROUND=$HOOK_ROUND"; hook_once && echo FIRST`,
    base,
  );
  assert(out.code === 0, "计数函数 exit 0");
  const sd = stateDirFor(agentDir, "test-session", "deadbeef1234");
  assert(existsSync(join(sd, "every.count")), "状态目录与计数文件落盘");
  const count = readFileSync(join(sd, "every.count"), "utf-8");
  assert(count.trim() === "1", "计数为 1");
  assert(out.stdout.includes("FIRST"), "hook_once 首次返回真");
  const out2 = await runHook(
    agentDir,
    `source "$PI_HOOK_LIB/lib.sh"; hook_every 3 && echo "ROUND=$HOOK_ROUND"; hook_once && echo FIRST`,
    base,
  );
  assert(!out2.stdout.includes("ROUND="), "第 2 次不触发 every 3");
  assert(!out2.stdout.includes("FIRST"), "第 2 次 once 已消费");
  const out3 = await runHook(agentDir, `source "$PI_HOOK_LIB/lib.sh"; hook_every 3 && echo "ROUND=$HOOK_ROUND"`, base);
  assert(out3.stdout.includes("ROUND=3"), "第 3 次触发 every 3");
}

// 7. PI_HOOK_INPUT_FILE 备份通道
{
  const out = await runHook(agentDir, `jq -r '.toolName' < "$PI_HOOK_INPUT_FILE"`, base);
  assert(out.stdout.includes("bash"), "PI_HOOK_INPUT_FILE 可读载荷");
}

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
