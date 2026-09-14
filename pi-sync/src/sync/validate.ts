/**
 * 文件内容校验
 *
 * 在 apply 前校验：
 * - JSON 格式正确
 * - 不含 Git 冲突标记 (<<<<<<<, =======, >>>>>>>)
 * - special 声明了 adapter 的文件：由该 adapter 的校验方向决定（如 settings 的包源便携性）
 * - Skill/Theme/Prompt 基本格式
 */
import { readFile } from "node:fs/promises";
import type { PiSyncConfig } from "./config.ts";
import { applyValidation } from "./file-adapters.ts";
import { normalizePath } from "./glob.ts";
import { resolveRepoSyncRoot, resolveWithinRoot } from "../system/path-safety.ts";

// ========== 校验结果 ==========

export interface ValidationError {
  file: string;
  message: string;
  severity: "error" | "warning";
}

export interface ValidationResult {
  errors: ValidationError[];
  /** 是否有阻断性错误 */
  blocked: boolean;
}

// ========== 冲突标记检测 ==========

const CONFLICT_PATTERNS = [/^<<<<<<</m, /^>>>>>>>/m, /^=======/m];

/**
 * 检查文件内容是否包含 Git 冲突标记
 */
export function hasConflictMarkers(content: string): boolean {
  return CONFLICT_PATTERNS.some((p) => p.test(content));
}

// ========== JSON 校验 ==========

/**
 * 校验 JSON 文件格式
 */
export function validateJson(
  filePath: string,
  content: string,
): ValidationError[] {
  const errors: ValidationError[] = [];
  try {
    JSON.parse(content);
  } catch (err) {
    errors.push({
      file: filePath,
      message: `JSON 格式无效：${err instanceof Error ? err.message : "未知错误"}`,
      severity: "error",
    });
  }
  return errors;
}

// ========== 综合校验 ==========

/**
 * 对一组文件运行所有校验
 *
 * @param agentDir Pi agent 目录（构造 AdapterContext 用）
 * @param repoPath 仓库路径
 * @param config 同步配置
 * @param files 需要校验的相对路径列表
 */
export async function validateFiles(
  agentDir: string,
  repoPath: string,
  config: PiSyncConfig,
  files: string[],
): Promise<ValidationResult> {
  const errors: ValidationError[] = [];
  const safeRoot = await resolveRepoSyncRoot(repoPath, config.root, "read");

  for (const relPath of files) {
    let normalizedPath: string;
    try {
      normalizedPath = normalizePath(relPath);
      if (normalizedPath === "") throw new Error("路径为空");
    } catch {
      errors.push({
        file: relPath,
        message: "文件路径必须是同步根目录内的非空相对路径。",
        severity: "error",
      });
      continue;
    }

    const fullPath = await resolveWithinRoot(safeRoot, normalizedPath, "read");

    let content: string;
    try {
      content = await readFile(fullPath, "utf-8");
    } catch {
      // 文件不存在（可能是计划删除的），跳过
      continue;
    }

    // 冲突标记检查（所有文件）
    if (hasConflictMarkers(content)) {
      errors.push({
        file: normalizedPath,
        message: "文件包含 git 冲突标记（<<<<<<<、=======、>>>>>>>）。请先解决冲突再同步。",
        severity: "error",
      });
    }

    // JSON 文件：格式检查
    if (normalizedPath.endsWith(".json")) {
      errors.push(...validateJson(normalizedPath, content));
    }

    // special 声明的 adapter 自行决定要报什么（如 settings 的包源便携性）。
    // 按 special 分派而非按文件名，用户 adapter 接管某路径时其规则说了算。
    const issues = await applyValidation(
      config,
      Buffer.from(content, "utf-8"),
      { agentDir, repoPath, filePath: normalizedPath },
    );
    errors.push(
      ...issues.map((issue) => ({ ...issue, file: normalizedPath })),
    );
  }

  const hasBlockingErrors = errors.some((e) => e.severity === "error");

  return { errors, blocked: hasBlockingErrors };
}
