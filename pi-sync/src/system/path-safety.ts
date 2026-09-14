import { lstat, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { normalizePath } from "../sync/glob.ts";

export type PathIntent = "read" | "write" | "delete" | "backup" | "restore";

export interface SafeRoot {
  path: string;
  realPath: string;
}

function ensureRelativePath(value: string, label: string): string {
  const normalized = normalizePath(value);
  if (normalized === "" || isAbsolute(normalized)) {
    throw new Error(`${label}必须是非空的相对路径`);
  }
  return normalized;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * 拒绝信任根本身以及每一段已存在的相对路径分量上的符号链接。
 * 系统级路径前缀（例如 macOS 的 /var -> /private/var）不属于信任根的一部分，
 * 这里有意不将其视为逃逸。
 */
export async function assertNoSymlinkComponents(
  root: string,
  relativePath = "",
): Promise<void> {
  const absoluteRoot = resolve(root);
  const normalizedRelative = relativePath ? normalizePath(relativePath) : "";
  const target = normalizedRelative ? resolve(absoluteRoot, normalizedRelative) : absoluteRoot;
  if (!isWithin(absoluteRoot, target)) {
    throw new Error(`路径逃逸出信任根：${relativePath}`);
  }

  const components = [
    absoluteRoot,
    ...normalizedRelative.split("/").filter(Boolean),
  ];
  let current = absoluteRoot;
  for (let index = 0; index < components.length; index++) {
    current = index === 0 ? absoluteRoot : resolve(current, components[index]!);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new Error(`拒绝跟随 ${relativePath || root} 的符号链接：${current}`);
      }
      if (index < components.length - 1 && !info.isDirectory()) {
        throw new Error(`路径分量不是目录：${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // 缺失的叶子节点及其未来的子节点，只有位于最近的已存在父目录之下才是安全的，
      // 而该父目录在此之前已经检查过。
      let parent = dirname(current);
      while (parent !== dirname(parent)) {
        try {
          const parentInfo = await lstat(parent);
          if (parentInfo.isSymbolicLink()) {
            throw new Error(`拒绝在符号链接之下创建：${parent}`);
          }
          break;
        } catch (parentError) {
          if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") throw parentError;
          parent = dirname(parent);
        }
      }
      break;
    }
  }
}

/** 解析并校验仓库的同步根目录。 */
export async function resolveRepoSyncRoot(
  repoPath: string,
  root: string,
  intent: PathIntent,
): Promise<SafeRoot> {
  const normalizedRoot = ensureRelativePath(root, "同步根目录");
  const trustedRepo = resolve(repoPath);
  await assertNoSymlinkComponents(trustedRepo);
  const syncRoot = resolve(trustedRepo, normalizedRoot);
  if (!isWithin(trustedRepo, syncRoot)) {
    throw new Error(`同步根目录逃逸出仓库：${root}`);
  }
  await assertNoSymlinkComponents(trustedRepo, normalizedRoot);

  if (existsSync(syncRoot)) {
    const info = await lstat(syncRoot);
    if (!info.isDirectory()) {
      throw new Error(`同步根目录不是目录（${intent}）：${syncRoot}`);
    }
    const resolved = await realpath(syncRoot);
    const repoReal = await realpath(trustedRepo);
    if (!isWithin(repoReal, resolved)) {
      throw new Error(`同步根目录解析到仓库之外：${syncRoot}`);
    }
    return { path: syncRoot, realPath: resolved };
  }

  // 根目录可以稍后再创建，但它已存在的父目录必须是可信的。
  await assertNoSymlinkComponents(dirname(syncRoot));
  return {
    path: syncRoot,
    realPath: resolve(await realpath(trustedRepo), normalizedRoot),
  };
}

/** 在不跟随符号链接的前提下，解析信任根之下的相对路径。 */
export async function resolveWithinRoot(
  root: string | SafeRoot,
  relativePath: string,
  intent: PathIntent,
): Promise<string> {
  const rootPath = typeof root === "string" ? resolve(root) : root.path;
  const normalized = ensureRelativePath(relativePath, "相对路径");
  const candidate = resolve(rootPath, normalized);
  if (!isWithin(rootPath, candidate)) {
    throw new Error(`路径逃逸出信任根（${intent}）：${relativePath}`);
  }

  await assertNoSymlinkComponents(rootPath, normalized);
  if (existsSync(candidate)) {
    const trustedReal = typeof root === "string"
      ? await realpath(rootPath)
      : root.realPath;
    const candidateReal = await realpath(candidate);
    if (!isWithin(trustedReal, candidateReal)) {
      throw new Error(`路径解析到信任根之外（${intent}）：${relativePath}`);
    }
  }
  return candidate;
}
