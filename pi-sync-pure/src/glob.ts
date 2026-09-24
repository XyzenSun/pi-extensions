import { lstat } from "node:fs/promises";

export function normalizePath(input: string): string {
  if (input.includes("\0")) throw new Error(`路径包含 NUL 字符: ${input}`);
  let normalized = input.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`不允许绝对路径: ${input}`);
  }
  if (normalized.split("/").includes("..")) throw new Error(`不允许路径逃逸: ${input}`);
  normalized = normalized.replace(/^\.\//, "").replace(/\/{2,}/g, "/").replace(/\/$/, "");
  return normalized;
}

export function minimatch(path: string, pattern: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/").replace(/^\.\//, "");
  let normalizedPattern = pattern.replace(/\\/g, "/");
  if (normalizedPattern.startsWith("/")) normalizedPattern = normalizedPattern.slice(1);
  const memo = new Map<string, boolean>();

  const match = (pathIndex: number, patternIndex: number): boolean => {
    const key = `${pathIndex}:${patternIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    if (pathIndex === normalizedPath.length && patternIndex === normalizedPattern.length) return true;
    if (patternIndex === normalizedPattern.length) return false;
    const token = normalizedPattern[patternIndex]!;
    let result = false;

    if (token === "*" && normalizedPattern[patternIndex + 1] === "*") {
      let nextPatternIndex = patternIndex + 2;
      if (normalizedPattern[nextPatternIndex] === "/") nextPatternIndex++;
      result = match(pathIndex, nextPatternIndex);
      for (let nextPathIndex = pathIndex; !result && nextPathIndex < normalizedPath.length; nextPathIndex++) {
        result = match(nextPathIndex + 1, nextPatternIndex);
      }
    } else if (token === "*") {
      result = match(pathIndex, patternIndex + 1);
      for (let nextPathIndex = pathIndex; !result && nextPathIndex < normalizedPath.length && normalizedPath[nextPathIndex] !== "/"; nextPathIndex++) {
        result = match(nextPathIndex + 1, patternIndex + 1);
      }
    } else if (token === "?") {
      result = pathIndex < normalizedPath.length && normalizedPath[pathIndex] !== "/" && match(pathIndex + 1, patternIndex + 1);
    } else {
      result = normalizedPath[pathIndex] === token && match(pathIndex + 1, patternIndex + 1);
    }

    memo.set(key, result);
    return result;
  };

  return match(0, 0);
}

export function isPathAllowed(
  relativePath: string,
  include: string[],
  exclude: string[],
): { allowed: boolean; reason?: string } {
  const normalized = normalizePath(relativePath);
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.startsWith(".") && segment !== ".gitignore")) {
    return { allowed: false, reason: "隐藏文件默认不参与同步" };
  }
  if (!include.some((pattern) => minimatch(normalized, pattern))) {
    return { allowed: false, reason: "不匹配任何 include 模式" };
  }
  const excludedPattern = exclude.find((pattern) => minimatch(normalized, pattern));
  if (excludedPattern) return { allowed: false, reason: `匹配 exclude 模式: ${excludedPattern}` };
  return { allowed: true };
}

export async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}
