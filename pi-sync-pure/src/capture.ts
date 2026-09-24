import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { PiSyncConfig } from "./config.ts";
import {
  adapterContext,
  resolveAdapter,
  specialEntryFor,
  syncDirectory,
  transformToRepository,
  validateWithAdapter,
  type FileAdapter,
} from "./adapters.ts";
import { isPathAllowed } from "./glob.ts";

export interface MirrorResult {
  copied: string[];
  deleted: string[];
}

export async function capture(
  agentDir: string,
  repoPath: string,
  config: PiSyncConfig,
  adapterCache: Map<string, FileAdapter> = new Map(),
): Promise<MirrorResult> {
  const sourceFiles = await listRegularFiles(agentDir);
  const selected = new Map<string, string>();
  for (const absolutePath of sourceFiles) {
    const filePath = relative(agentDir, absolutePath).split("\\").join("/");
    if (isPathAllowed(filePath, config.include, config.exclude).allowed) selected.set(filePath, absolutePath);
  }

  const syncRoot = syncDirectory(repoPath);
  await mkdir(syncRoot, { recursive: true });
  const repositoryFiles = await listRegularFiles(syncRoot);
  const existingPaths = repositoryFiles.map((path) => relative(syncRoot, path).split("\\").join("/"));
  const result: MirrorResult = { copied: [], deleted: [] };

  for (const filePath of existingPaths) {
    if (isPathAllowed(filePath, config.include, config.exclude).allowed && !selected.has(filePath)) {
      await rm(join(syncRoot, filePath), { force: true });
      result.deleted.push(filePath);
    }
  }

  for (const [filePath, localPath] of selected) {
    const localBytes = await readFile(localPath);
    const entry = specialEntryFor(config, filePath);
    const adapter = await resolveAdapter(repoPath, entry, adapterCache);
    const context = adapterContext(agentDir, repoPath, filePath);
    const issues = await validateWithAdapter(localBytes, context, adapter);
    const blockingIssue = issues.find((issue) => issue.severity === "error");
    if (blockingIssue) throw new Error(`${filePath}: ${blockingIssue.message}`);
    const repositoryBytes = await transformToRepository(localBytes, context, adapter);
    const targetPath = join(syncRoot, filePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, repositoryBytes);
    result.copied.push(filePath);
  }

  return result;
}

async function listRegularFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      let info;
      try {
        info = await lstat(absolutePath);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) continue;
        throw error;
      }
      if (info.isDirectory()) await visit(absolutePath);
      else if (info.isFile()) results.push(absolutePath);
    }
  };
  await visit(root);
  return results;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
