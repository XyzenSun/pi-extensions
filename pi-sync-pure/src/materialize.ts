import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { PiSyncConfig } from "./config.ts";
import {
  adapterContext,
  resolveAdapter,
  specialEntryFor,
  syncDirectory,
  transformToLocal,
  type FileAdapter,
} from "./adapters.ts";
import { isPathAllowed } from "./glob.ts";
import type { MirrorResult } from "./capture.ts";

export async function materialize(
  repoPath: string,
  agentDir: string,
  config: PiSyncConfig,
  adapterCache: Map<string, FileAdapter> = new Map(),
): Promise<MirrorResult> {
  const syncRoot = syncDirectory(repoPath);
  const repositoryFiles = await listRegularFiles(syncRoot);
  const repositoryPaths = new Map<string, string>();
  for (const absolutePath of repositoryFiles) {
    const filePath = relative(syncRoot, absolutePath).split("\\").join("/");
    if (isPathAllowed(filePath, config.include, config.exclude).allowed) repositoryPaths.set(filePath, absolutePath);
  }

  const localFiles = await listRegularFiles(agentDir);
  const localPaths = new Map<string, string>();
  for (const absolutePath of localFiles) {
    const filePath = relative(agentDir, absolutePath).split("\\").join("/");
    if (isPathAllowed(filePath, config.include, config.exclude).allowed) localPaths.set(filePath, absolutePath);
  }

  const result: MirrorResult = { copied: [], deleted: [] };
  for (const [filePath, localPath] of localPaths) {
    if (!repositoryPaths.has(filePath)) {
      await rm(localPath, { force: true });
      result.deleted.push(filePath);
    }
  }

  for (const [filePath, repositoryPath] of repositoryPaths) {
    const repositoryBytes = await readFile(repositoryPath);
    const localPath = join(agentDir, filePath);
    let localBytes: Buffer;
    try {
      localBytes = await readFile(localPath);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      localBytes = Buffer.alloc(0);
    }
    const adapter = await resolveAdapter(repoPath, specialEntryFor(config, filePath), adapterCache);
    const transformed = await transformToLocal(
      repositoryBytes,
      localBytes,
      adapterContext(agentDir, repoPath, filePath),
      adapter,
    );
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, transformed);
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
