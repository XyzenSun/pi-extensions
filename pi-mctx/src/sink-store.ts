/**
 * sink 存储管理: 目录布局 / wx 幂等写入 / undo / 集合重建。
 *
 * 核心原则 (设计文档 §3.3): "文件即状态" —— 文件存在 == 该条已下沉,
 * 内存 Set 只是文件名的镜像, 可随时从目录重建, 不需要持久化。
 * 文件全丢 = 下沉自动撤销 = 全文原样回到上下文, 零数据损失。
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dbg } from "./debug.ts";

// toolCallId 白名单: 实测 (2521 条真实样本) 全部为 call_... 形式。
// 白名单防御极少见的非规范 provider, 同时杜绝路径穿越。
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isSafeId(id: string): boolean {
  return SAFE_ID_PATTERN.test(id);
}

export function sinkDir(sessionId: string): string {
  return join(tmpdir(), "pi-mctx", sessionId);
}

export function sinkFile(sessionId: string, id: string): string {
  return join(sinkDir(sessionId), `${id}.txt`);
}

/**
 * 从目录重建已沉集合。目录不存在 (ENOENT) 返回空集合 ——
 * 等价于"未下沉", 这是 tmpdir 被系统清理后的自动回滚路径。
 */
export function loadSunkIds(sessionId: string): Set<string> {
  const ids = new Set<string>();
  try {
    const entries = readdirSync(sinkDir(sessionId));
    for (const name of entries) {
      if (!name.endsWith(".txt")) continue;
      ids.add(name.slice(0, -".txt".length));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      dbg("sink-store", "读取下沉目录失败, 视为空集合", { dir: sinkDir(sessionId), error: String(error) });
    }
  }
  return ids;
}

/**
 * 写入一条下沉文件。wx 标志保证不覆盖已存在文件;
 * EEXIST 视为"已沉"幂等跳过 (支持多次 /mctx sink);
 * 其它错误记录并跳过该条, 不影响其余。
 * 返回 true 表示本次实际写入。
 */
export function writeSunkFile(sessionId: string, id: string, text: string): boolean {
  if (!isSafeId(id)) {
    dbg("sink-store", "toolCallId 含非法字符, 跳过该条", { id });
    return false;
  }
  const dir = sinkDir(sessionId);
  try {
    // 0700/0600: 下沉内容是会话原文, 可能含敏感信息, 收紧权限。
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `${id}.txt`), text, { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    dbg("sink-store", "写入下沉文件失败, 跳过该条", { file: join(dir, `${id}.txt`), error: String(error) });
    return false;
  }
}

/** 撤销本会话全部下沉: 删除目录下所有文件, 返回删除数。 */
export function removeAllSunkFiles(sessionId: string): number {
  const dir = sinkDir(sessionId);
  let removed = 0;
  try {
    const entries = readdirSync(dir);
    for (const name of entries) {
      if (!name.endsWith(".txt")) continue;
      rmSync(join(dir, name));
      removed++;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      dbg("sink-store", "撤销时读取下沉目录失败", { dir, error: String(error) });
    }
  }
  return removed;
}

/**
 * 删除单条下沉文件 (恢复该条为可见)。文件不存在时静默返回 false。
 * 供 --keep 目标状态语义使用: 调用方以集合成员关系为准制恢复决定,
 * 即使文件已被外部删除, 也应同步调用 deleteSunkId 修正集合与目录的漂移。
 */
export function removeSunkFile(sessionId: string, id: string): boolean {
  if (!isSafeId(id)) return false;
  try {
    rmSync(sinkFile(sessionId, id));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      dbg("sink-store", "删除下沉文件失败", { id, error: String(error) });
    }
    return false;
  }
}

/** 读回一条已沉结果, ENOENT 等错误原样抛出由调用方处理。 */
export function readSunkFile(sessionId: string, id: string): string {
  return readFileSync(sinkFile(sessionId, id), "utf8");
}

// ---------------------------------------------------------------------------
// 当前会话的内存镜像状态。
// session_start 时 rebind 重建; 会话切换 (new/resume/fork) 会触发扩展重载
// 并再次 session_start, 因此钩子路径直接读取该状态即可, 无需每轮做 I/O。
// ---------------------------------------------------------------------------

let currentSessionId: string | null = null;
let currentSunkIds: Set<string> = new Set();

/** 绑定/刷新当前会话的已沉集合 (从目录重建)。幂等, 可反复调用。 */
export function rebindSession(sessionId: string): void {
  if (currentSessionId === sessionId) return;
  currentSessionId = sessionId;
  currentSunkIds = loadSunkIds(sessionId);
  dbg("sink-store", "会话绑定", { sessionId, sunkCount: currentSunkIds.size });
}

export function getSunkIds(): ReadonlySet<string> {
  return currentSunkIds;
}

export function addSunkId(id: string): void {
  currentSunkIds.add(id);
}

export function deleteSunkId(id: string): void {
  currentSunkIds.delete(id);
}

export function clearSunkIds(): void {
  currentSunkIds.clear();
}
