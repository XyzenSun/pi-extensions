import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { SpecialEntry } from "./config.ts";

export const SYNC_PACKAGE_SOURCE = "npm:@xyzensun/pi-sync-pure";

export interface AdapterContext {
  agentDir: string;
  repoPath: string;
  filePath: string;
}

export interface AdapterValidationIssue {
  message: string;
  severity: "error" | "warning";
}

export interface FileAdapter {
  transformToRepository?(local: Buffer, context: AdapterContext): Buffer | Promise<Buffer>;
  transformToLocal?(repository: Buffer, local: Buffer, context: AdapterContext): Buffer | Promise<Buffer>;
  validate?(content: Buffer, context: AdapterContext): AdapterValidationIssue[] | Promise<AdapterValidationIssue[]>;
}

export type AdapterSpec = "direct" | FileAdapter;

export function normalizeSpecialEntry(entry: SpecialEntry | undefined): string | undefined {
  const name = typeof entry === "string" ? entry : entry?.adapter;
  return name === "direct" ? undefined : name;
}

export async function resolveAdapter(
  repoPath: string,
  entry: SpecialEntry | undefined,
  cache: Map<string, FileAdapter>,
): Promise<AdapterSpec> {
  const declaration = normalizeSpecialEntry(entry);
  if (!declaration) return "direct";
  const cached = cache.get(declaration);
  if (cached) return cached;

  if (declaration.startsWith("./")) {
    const modulePath = resolve(repoPath, declaration);
    const relative = modulePath.slice(resolve(repoPath).length + 1);
    if (relative.startsWith(`..${sep}`) || relative === "..") {
      throw new Error(`自定义 adapter 必须位于配置仓库内: ${declaration}`);
    }
    try {
      const imported = await import(pathToFileURL(modulePath).href) as { default?: unknown } & Record<string, unknown>;
      const candidate = imported.default ?? imported;
      if (!isRecord(candidate)) throw new Error("adapter 默认导出必须是对象");
      for (const functionName of ["transformToRepository", "transformToLocal", "validate"] as const) {
        if (candidate[functionName] !== undefined && typeof candidate[functionName] !== "function") {
          throw new Error(`adapter ${functionName} 必须是函数`);
        }
      }
      const adapter = candidate as FileAdapter;
      cache.set(declaration, adapter);
      return adapter;
    } catch (error) {
      throw new Error(`加载自定义 adapter ${declaration} 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (declaration === "settings") {
    const { settingsAdapter } = await import("./settings-adapter.ts");
    cache.set(declaration, settingsAdapter);
    return settingsAdapter;
  }
  throw new Error(`未知 adapter: ${declaration}。支持 settings 或 ./relative-adapter.js。`);
}

export async function transformToRepository(
  local: Buffer,
  context: AdapterContext,
  adapter: AdapterSpec,
): Promise<Buffer> {
  return adapter === "direct" ? local : (await adapter.transformToRepository?.(local, context)) ?? local;
}

export async function transformToLocal(
  repository: Buffer,
  local: Buffer,
  context: AdapterContext,
  adapter: AdapterSpec,
): Promise<Buffer> {
  return adapter === "direct" ? repository : (await adapter.transformToLocal?.(repository, local, context)) ?? repository;
}

export async function validateWithAdapter(
  content: Buffer,
  context: AdapterContext,
  adapter: AdapterSpec,
): Promise<AdapterValidationIssue[]> {
  return adapter === "direct" ? [] : (await adapter.validate?.(content, context)) ?? [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function adapterContext(agentDir: string, repoPath: string, filePath: string): AdapterContext {
  return { agentDir, repoPath, filePath };
}

export function specialEntryFor(config: { special: Record<string, SpecialEntry> }, relativePath: string): SpecialEntry | undefined {
  return config.special[relativePath] ?? config.special[relativePath.replaceAll("\\", "/")];
}

export function syncDirectory(repoPath: string): string {
  return join(repoPath, "sync");
}
