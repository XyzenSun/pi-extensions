/**
 * 备份与回滚
 *
 * 备份目录：$PI_CODING_AGENT_DIR/.pi-sync/backups/<timestamp>/
 *
 * 备份记录：
 * - apply 前存在的文件内容和 mode
 * - apply 前不存在但将被创建的路径
 * - 计划删除的文件
 * - repo commit 和操作类型
 */
import { chmod, mkdir, writeFile, readFile, rename, readdir, unlink, stat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { sha256File } from "../sync/inventory.ts";
import { normalizePath } from "../sync/glob.ts";
import type { MaterializePlan } from "../sync/materialize.ts";
import { assertNoSymlinkComponents, resolveWithinRoot } from "./path-safety.ts";

// ========== 类型 ==========

export interface Backup {
  timestamp: string;
  commit: string;
  reason: string;
  path: string;
  /** 操作类型 */
  operation: string;
  /** 记录的文件信息 */
  files: Record<string, { action: "backed_up" | "will_create" | "will_delete"; sha256?: string; mode?: number }>;
}

function normalizeBackupRelativePath(relativePath: string): string {
  const normalizedPath = normalizePath(relativePath);
  if (normalizedPath === "") throw new Error("备份文件路径不能为空");
  return normalizedPath;
}

function validateBackupPlan(plan: MaterializePlan | undefined): void {
  if (!plan) return;
  for (const item of plan.toWrite) normalizeBackupRelativePath(item.relativePath);
  for (const relativePath of plan.toDelete) normalizeBackupRelativePath(relativePath);
}

// ========== 创建备份 ==========

type PreparedBackupFile = {
  relativePath: string;
  action: "backed_up" | "will_create" | "will_delete";
  content?: Buffer;
  sha256?: string;
  mode?: number;
};

async function prepareBackupFile(
  agentDir: string,
  relativePath: string,
  action: "backed_up" | "will_delete",
): Promise<PreparedBackupFile> {
  const normalizedPath = normalizeBackupRelativePath(relativePath);
  const agentPath = await resolveWithinRoot(agentDir, normalizedPath, "backup");

  try {
    const fileStat = await stat(agentPath);
    if (!fileStat.isFile()) {
      throw new Error(`无法备份非普通文件：${normalizedPath}`);
    }
    const content = await readFile(agentPath);
    return {
      relativePath: normalizedPath,
      action,
      content,
      sha256: await sha256File(agentPath),
      mode: fileStat.mode & 0o777,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        relativePath: normalizedPath,
        action: action === "backed_up" ? "will_create" : "will_delete",
      };
    }
    throw error;
  }
}

async function verifyBackupData(
  dataDir: string,
  records: Backup["files"],
): Promise<void> {
  for (const [relativePath, record] of Object.entries(records)) {
    if (!record.sha256) continue;
    const normalizedPath = normalizeBackupRelativePath(relativePath);
    const backupPath = join(dataDir, normalizedPath);
    if ((await stat(backupPath)).isFile() === false) {
      throw new Error(`备份数据不是普通文件：${normalizedPath}`);
    }
    if (await sha256File(backupPath) !== record.sha256) {
      throw new Error(`创建后备份数据 hash 不匹配：${normalizedPath}`);
    }
  }
}

/**
 * 创建完整预操作备份。
 *
 * 备份采用 fail-closed 语义：所有计划文件先完成读取和元数据快照，
 * 数据与 manifest 写入并校验成功后才返回。任意文件无法备份都会抛错，
 * 调用方因此不会继续执行 materialize。
 */
export async function createBackup(
  agentDir: string,
  commit: string,
  reason: string,
  plan?: MaterializePlan,
): Promise<Backup> {
  validateBackupPlan(plan);
  await assertNoSymlinkComponents(agentDir);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupRoot = join(agentDir, ".pi-sync", "backups", timestamp);
  const dataDir = join(backupRoot, "data");

  try {
    const prepared: PreparedBackupFile[] = [];
    if (plan) {
      // 先完成全部 source 快照，避免只生成半份备份后开始写 agent。
      for (const item of plan.toWrite) {
        prepared.push(await prepareBackupFile(agentDir, item.relativePath, "backed_up"));
      }
      for (const relativePath of plan.toDelete) {
        prepared.push(await prepareBackupFile(agentDir, relativePath, "will_delete"));
      }
    }

    await mkdir(dataDir, { recursive: true });
    const fileRecords: Backup["files"] = {};

    if (plan) {
      for (const entry of prepared) {
        fileRecords[entry.relativePath] = {
          action: entry.action,
          ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
          ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
        };
        if (entry.content) {
          const backupPath = join(dataDir, entry.relativePath);
          await mkdir(dirname(backupPath), { recursive: true });
          await writeFile(backupPath, entry.content);
        }
      }
    } else {
      // 无计划：备份整个 settings.json 和所有 agent 文件（兜底）。
      await backupAgentDir(agentDir, dataDir, fileRecords);
    }

    await verifyBackupData(dataDir, fileRecords);

    const meta = {
      timestamp,
      commit,
      reason,
      operation: reason,
      files: fileRecords,
    };
    await writeFile(join(backupRoot, "backup.json"), JSON.stringify(meta, null, 2), "utf-8");

    return { ...meta, path: backupRoot };
  } catch (error) {
    // 不留下可被误认为完整备份的残留目录。
    await rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * 兜底：完整备份 agent 目录中可能在白名单内的文件
 */
async function backupAgentDir(
  agentDir: string,
  dataDir: string,
  records: Backup["files"],
): Promise<void> {
  const settingsPath = join(agentDir, "settings.json");
  if (existsSync(settingsPath)) {
    const content = await readFile(settingsPath);
    await mkdir(dirname(join(dataDir, "settings.json")), { recursive: true });
    await writeFile(join(dataDir, "settings.json"), content);
    records["settings.json"] = {
      action: "backed_up",
      sha256: await sha256File(settingsPath),
      mode: (await stat(settingsPath)).mode & 0o777,
    };
  }

  // 递归备份 agent 目录全部内容（仅排除备份自身工作目录，防止备份套备份无限膨胀）
  await recursiveBackup(agentDir, agentDir, dataDir, records);
}

async function recursiveBackup(
  baseDir: string,
  currentDir: string,
  dataDir: string,
  records: Backup["files"],
): Promise<void> {
  const { readdir: rd } = await import("node:fs/promises");
  const { relative } = await import("node:path");

  const entries = await rd(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    const relPath = relative(baseDir, fullPath).replace(/\\/g, "/");

    // 跳过备份自身的工作目录：备份套备份会无限膨胀，与用户文件无关
    if (entry.name === ".pi-sync") continue;

    if (entry.isSymbolicLink()) {
      throw new Error(`拒绝备份符号链接：${fullPath}`);
    } else if (entry.isDirectory()) {
      await recursiveBackup(baseDir, fullPath, dataDir, records);
    } else if (entry.isFile()) {
      const content = await readFile(fullPath);
      const backupPath = join(dataDir, relPath);
      await mkdir(dirname(backupPath), { recursive: true });
      await writeFile(backupPath, content);
      records[relPath] = {
        action: "backed_up",
        sha256: await sha256File(fullPath),
        mode: (await stat(fullPath)).mode & 0o777,
      };
    }
  }
}

// ========== 恢复备份 ==========

export async function restoreBackup(
  agentDir: string,
  backup: Backup,
): Promise<void> {
  const dataDir = join(backup.path, "data");

  if (!existsSync(dataDir)) {
    throw new Error(`未找到备份数据目录：${dataDir}`);
  }

  // 恢复所有备份的文件
  for (const [relPath, record] of Object.entries(backup.files)) {
    const normalizedPath = normalizeBackupRelativePath(relPath);
    const backupFilePath = join(dataDir, normalizedPath);
    const targetPath = await resolveWithinRoot(agentDir, normalizedPath, "restore");

    if (record.action === "backed_up" || record.action === "will_delete") {
      // 文件需要恢复；元数据或数据不完整时必须显式失败，而不是伪装恢复成功。
      if (!existsSync(backupFilePath)) {
        throw new Error(`未找到备份数据文件：${normalizedPath}`);
      }
      if (record.sha256 && (await sha256File(backupFilePath)) !== record.sha256) {
        throw new Error(`备份数据 hash 不匹配：${normalizedPath}`);
      }
      const content = await readFile(backupFilePath);
      await mkdir(dirname(targetPath), { recursive: true });
      await atomicOverwrite(targetPath, content);
      if (record.mode) await chmod(targetPath, record.mode);
    } else if (record.action === "will_create") {
      // 文件在备份时还不存在，恢复时应删除
      if (existsSync(targetPath)) {
        await unlink(targetPath);
      }
    }
  }
}

async function atomicOverwrite(targetPath: string, content: Buffer): Promise<void> {
  const tmpPath = `${targetPath}.restore-${Date.now()}.tmp`;
  await writeFile(tmpPath, content);
  await rename(tmpPath, targetPath);
}

// ========== 列出备份 ==========

export async function listBackups(agentDir: string): Promise<Backup[]> {
  const backupsDir = join(agentDir, ".pi-sync", "backups");

  if (!existsSync(backupsDir)) return [];

  const entries = await readdir(backupsDir, { withFileTypes: true });
  const backups: Backup[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = join(backupsDir, entry.name, "backup.json");
    if (!existsSync(metaPath)) continue;

    try {
      const content = await readFile(metaPath, "utf-8");
      const meta = JSON.parse(content);
      backups.push({ ...meta, path: join(backupsDir, entry.name) });
    } catch {
      // 跳过损坏的备份
    }
  }

  backups.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return backups;
}

export async function getLatestBackup(agentDir: string): Promise<Backup | undefined> {
  const backups = await listBackups(agentDir);
  return backups[0];
}

/**
 * 固定保留的备份份数。
 *
 * 取 5 的理由：备份是 apply 失败回滚与"远端优先覆盖本机"之后唯一的本地退路
 * （设备恢复分支只覆盖已 commit 的改动，且需要网络），因此不能只留 1 份；
 * 但每份都是被写文件的全量快照，无上限增长会持续吃磁盘。
 */
export const MAX_BACKUPS = 5;

export async function cleanupOldBackups(
  agentDir: string,
  maxBackups: number = MAX_BACKUPS,
): Promise<number> {
  const backups = await listBackups(agentDir);
  if (backups.length <= maxBackups) return 0;

  const toRemove = backups.slice(maxBackups);
  for (const backup of toRemove) {
    try {
      const { rm } = await import("node:fs/promises");
      await rm(backup.path, { recursive: true, force: true });
    } catch {
      // 继续
    }
  }
  return toRemove.length;
}
