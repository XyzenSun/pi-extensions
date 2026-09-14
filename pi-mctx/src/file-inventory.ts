/**
 * /mctx new 的文件清单机械提取。
 *
 * 与 pi 内部 FileOperations 三集合结构对齐: read -> 读集, write/edit -> 改集。
 * (grep/find/ls 不提取: 其 path 常为目录或可选, 对"需要读哪些文件"清单价值低。)
 * 机械提取保证不遗漏、不编造; 喂给总结 LLM 后由其筛选标注。
 */
import { relative, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { dbg } from "./debug.ts";

export interface FileInventory {
  /** 仅读过未修改 */
  readFiles: string[];
  /** 写入或编辑过 */
  modifiedFiles: string[];
}

/** 历史 compaction details 中可累积合并的文件追踪结构。 */
export interface CompactionFileDetails {
  readFiles?: string[];
  modifiedFiles?: string[];
}

const READ_TOOL_NAMES = new Set(["read"]);
const MODIFY_TOOL_NAMES = new Set(["write", "edit"]);

function normalizePath(rawPath: string, cwd: string): string {
  const absolute = resolve(cwd, rawPath);
  const relativePath = relative(cwd, absolute);
  // cwd 之外的文件保留绝对路径, 避免 ../../ 形式的相对路径误导模型。
  if (relativePath.startsWith("..")) return absolute;
  return relativePath;
}

export function extractFileInventory(
  messages: AgentMessage[],
  compactionDetails: CompactionFileDetails[],
  cwd: string,
): FileInventory {
  const read = new Set<string>();
  const modified = new Set<string>();

  // 累积合并历史 compaction 的 details: 文件追踪跨压缩累积 (与 pi 内置行为一致)。
  for (const details of compactionDetails) {
    for (const file of details.readFiles ?? []) read.add(normalizePath(file, cwd));
    for (const file of details.modifiedFiles ?? []) modified.add(normalizePath(file, cwd));
  }

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      const toolPath = block.arguments?.path;
      if (typeof toolPath !== "string" || toolPath.length === 0) continue;
      const normalized = normalizePath(toolPath, cwd);
      if (READ_TOOL_NAMES.has(block.name)) read.add(normalized);
      else if (MODIFY_TOOL_NAMES.has(block.name)) modified.add(normalized);
    }
  }

  // 读集扣除改集: 只读未改的才算"仅读过"。
  const readFiles = [...read].filter((file) => !modified.has(file));
  const modifiedFiles = [...modified];
  dbg("file-inventory", "提取完成", { readFiles, modifiedFiles });
  return { readFiles, modifiedFiles };
}

/** 把清单格式化为喂给总结 LLM 的事实区块。清单为空时返回 null。 */
export function formatTouchedFiles(inventory: FileInventory): string | null {
  if (inventory.readFiles.length === 0 && inventory.modifiedFiles.length === 0) return null;
  const lines = ["<touched-files>"];
  if (inventory.modifiedFiles.length > 0) {
    lines.push("modified (written or edited during the session):");
    for (const file of inventory.modifiedFiles) lines.push(`- ${file}`);
  }
  if (inventory.readFiles.length > 0) {
    lines.push("read-only (read but not modified):");
    for (const file of inventory.readFiles) lines.push(`- ${file}`);
  }
  lines.push("</touched-files>");
  return lines.join("\n");
}
