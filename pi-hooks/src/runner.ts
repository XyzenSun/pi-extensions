/**
 * 协议执行层：spawn bash 子进程，写入事件 JSON，回收退出码与 stdout/stderr。
 *
 * 设计要点（见 doc/design.md）：
 *   - 不用 pi.exec（stdin 被关闭、shell:false），直接 node:child_process
 *   - detached + 进程组 kill：timeout 与收割时杀整棵进程树，防孤儿
 *   - Linux 父进程退出不级联终止子进程，引擎必须在 session_shutdown 主动收割
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

export interface ExecOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  killed: boolean;
}

/** 单次执行的上下文：事件名、载荷、hook 身份与运行时信息。 */
export interface RunContext {
  eventName: string;
  payload: unknown;
  /** hook 条目指纹，用于分配状态目录 */
  hookId: string;
  /** 会话 id（可能拿不到，降级为 "nosession"） */
  sessionId: string;
  cwd: string;
  sessionFile?: string;
  /** lib.sh 所在目录（插件包内 lib/） */
  libDir: string;
  timeoutSeconds: number;
  /** 中止信号（ctx.signal），Esc 取消时提前终止 hook */
  signal?: AbortSignal;
}

/** stdout/stderr 累积上限，防恶意或失控脚本吃内存。 */
const OUTPUT_CAP = 1024 * 1024;

/** 在途子进程登记表，session_shutdown 时统一收割。 */
const activeChildren = new Set<ChildProcess>();

/** 收割全部在途 hook 子进程（SIGTERM 进程组）。 */
export function reapAllChildren(): void {
  for (const child of activeChildren) {
    killTree(child, "SIGTERM");
  }
}

/** 杀整棵进程树。detached 模式下子进程自成进程组，杀负 pid 即杀全组。 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    // negative pid = 进程组；失败（进程已退）静默
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already dead */
    }
  }
}

/** hook 状态目录：~/.pi/agent/extension-data/pi-hooks/<sessionId>/<hookId>/ */
export function stateDirFor(agentDir: string, sessionId: string, hookId: string): string {
  return join(agentDir, "extension-data", "pi-hooks", sessionId, hookId);
}

/** 临时载荷文件：超大 stdin 的备份通道，执行后删除。 */
function writePayloadFile(payloadJson: string): string {
  const file = join(tmpdir(), `pi-hooks-input-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(file, payloadJson, "utf-8");
  return file;
}

/**
 * 执行一条 hook 的 bash 命令并回收获结果。
 * 任何异常（spawn 失败、信号）都转为 ExecOutcome，绝不向 pi 事件层抛出。
 */
export async function runHook(agentDir: string, run: string, rc: RunContext): Promise<ExecOutcome> {
  const payloadJson = JSON.stringify(rc.payload);
  const stateDir = stateDirFor(agentDir, rc.sessionId, rc.hookId);
  const hookIdShort = rc.hookId.slice(0, 12);
  let payloadFile: string | undefined;

  try {
    mkdirSync(stateDir, { recursive: true });
    payloadFile = writePayloadFile(payloadJson);
  } catch {
    // 状态目录建不出来（磁盘满/权限）：照常执行，只是没有状态与文件通道
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  env.PI_HOOK_EVENT = rc.eventName;
  env.PI_HOOK_STATE_DIR = stateDir;
  env.PI_HOOK_LIB = rc.libDir;
  env.PI_HOOK_ID = hookIdShort;
  env.PI_HOOK_INPUT_FILE = payloadFile ?? "";
  env.PI_CWD = rc.cwd;
  env.PI_SESSION_ID = rc.sessionId;
  if (rc.sessionFile) env.PI_SESSION_FILE = rc.sessionFile;

  let child: ChildProcess;
  try {
    child = spawn("bash", ["-c", run], {
      cwd: rc.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32", // 自成进程组，timeout/收割可杀全组
      windowsHide: true,
    });
  } catch (e) {
    return { code: null, stdout: "", stderr: `spawn 失败: ${e instanceof Error ? e.message : String(e)}`, timedOut: false, killed: false };
  }

  if (child.pid === undefined) {
    return { code: null, stdout: "", stderr: "spawn 失败: 未获得 pid", timedOut: false, killed: false };
  }

  activeChildren.add(child);

  // stdin 写入事件 JSON 后关闭；脚本不读也不影响（管道缓冲足够小载荷）
  child.stdin?.on("error", () => {}); // EPIPE：脚本提前退出，忽略
  child.stdin?.end(payloadJson);

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    if (stdout.length < OUTPUT_CAP) stdout += chunk.toString("utf-8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < OUTPUT_CAP) stderr += chunk.toString("utf-8");
  });

  let timedOut = false;
  let aborted = false;
  let timeoutHandle: NodeJS.Timeout | undefined;
  let killHandle: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;

  if (rc.signal) {
    onAbort = () => {
      aborted = true;
      killTree(child, "SIGTERM");
    };
    if (rc.signal.aborted) onAbort();
    else rc.signal.addEventListener("abort", onAbort, { once: true });
  }

  const code = await new Promise<number | null>((resolve) => {
    child.on("error", (err) => {
      // bash 本体启动失败（如 PATH 里没有 bash）
      stderr += stderr ? `\n${err.message}` : err.message;
      resolve(null);
    });
    child.on("exit", (exitCode) => resolve(exitCode));

    // timeout 收口：SIGTERM，5 秒后 SIGKILL
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      killTree(child, "SIGTERM");
      killHandle = setTimeout(() => killTree(child, "SIGKILL"), 5000);
    }, rc.timeoutSeconds * 1000);
  });

  if (timeoutHandle) clearTimeout(timeoutHandle);
  if (killHandle) clearTimeout(killHandle);
  if (onAbort && rc.signal) rc.signal.removeEventListener("abort", onAbort);
  activeChildren.delete(child);

  if (payloadFile) {
    try {
      rmSync(payloadFile, { force: true });
    } catch {
      /* 临时文件清理失败无害 */
    }
  }

  const killed = timedOut || aborted;
  return { code, stdout, stderr, timedOut, killed };
}

/** hookId 由条目内容 hash 得出（config.ts 传 stableStringify 结果）。 */
export function hashHookId(stable: string): string {
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

/** lib/ 目录定位：index.ts 同级的 lib/。 */
export function resolveLibDir(entryDir: string): string {
  return join(dirname(entryDir), "lib");
}
