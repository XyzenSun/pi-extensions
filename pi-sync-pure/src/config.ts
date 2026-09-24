import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";

export type SpecialEntry = string | { adapter: string };

export interface PiSyncConfig {
  schemaVersion: 2;
  include: string[];
  exclude: string[];
  special: Record<string, SpecialEntry>;
  autoSync: {
    enabled: boolean;
  };
}

export interface LocalState {
  remoteUrl: string;
  deviceBranch: string;
}

export interface SyncPaths {
  piDir: string;
  agentDir: string;
  repoPath: string;
  statePath: string;
}

export const DEFAULT_CONFIG: PiSyncConfig = {
  schemaVersion: 2,
  include: [
    "settings.json",
    "AGENTS.md",
    "SYSTEM.md",
    "APPEND_SYSTEM.md",
    "keybindings.json",
    "extensions/**",
    "skills/**",
    "prompts/**",
    "themes/**",
  ],
  exclude: [
    "**/.DS_Store",
    "**/*.tmp",
    "**/*.log",
    "extensions/pi-sync/**",
    "extensions/pi-sync-pure/**",
    "extensions/**/.cache/**",
    "extensions/**/cache/**",
    "extensions/**/coverage/**",
    "extensions/**/logs/**",
    "extensions/**/temp/**",
    "extensions/**/tmp/**",
  ],
  special: { "settings.json": "settings" },
  autoSync: { enabled: false },
};

export function getSyncPaths(home = homedir()): SyncPaths {
  const piDir = join(home, ".pi");
  const agentDir = join(piDir, "agent");
  return {
    piDir,
    agentDir,
    repoPath: join(piDir, "config-repo"),
    statePath: join(agentDir, "pi-sync-pure.json"),
  };
}

export function validateConfig(raw: unknown): PiSyncConfig {
  if (!isRecord(raw)) throw new Error("pi-sync.json 必须是 JSON 对象。");
  if (raw.schemaVersion !== 2) {
    throw new Error(`不支持的 schemaVersion: ${String(raw.schemaVersion)}。当前支持版本为 2。`);
  }

  const validatePatterns = (value: unknown, field: string, required: boolean): string[] => {
    if (!Array.isArray(value) || (required && value.length === 0)) {
      throw new Error(`pi-sync.json: ${field} 必须是${required ? "非空的" : ""}字符串数组。`);
    }
    return value.map((pattern) => {
      if (typeof pattern !== "string" || pattern.length === 0 || isUnsafeRelativePath(pattern)) {
        throw new Error(`pi-sync.json: ${field} 中的模式无效: ${String(pattern)}。`);
      }
      return pattern;
    });
  };

  const include = validatePatterns(raw.include, "include", true);
  const exclude = raw.exclude === undefined ? [] : validatePatterns(raw.exclude, "exclude", false);
  const specialRaw = raw.special === undefined ? {} : raw.special;
  if (!isRecord(specialRaw)) throw new Error("pi-sync.json: special 必须是路径到 adapter 的映射对象。");

  const special: Record<string, SpecialEntry> = {};
  for (const [path, entry] of Object.entries(specialRaw)) {
    if (path.length === 0 || isUnsafeRelativePath(path)) {
      throw new Error(`pi-sync.json: special 路径无效: ${path}。`);
    }
    const adapter = typeof entry === "string"
      ? entry
      : isRecord(entry) && typeof entry.adapter === "string"
        ? entry.adapter
        : undefined;
    if (typeof adapter !== "string" || adapter.trim() === "") {
      throw new Error(`pi-sync.json: special["${path}"] 必须是非空 adapter 名称或 { adapter } 对象。`);
    }
    if (adapter.startsWith("./") && isUnsafeRelativePath(adapter)) {
      throw new Error(`pi-sync.json: adapter 路径必须留在仓库内: ${adapter}。`);
    }
    special[path] = typeof entry === "string" ? adapter : { adapter };
  }

  const autoSyncRaw = raw.autoSync === undefined ? {} : raw.autoSync;
  if (!isRecord(autoSyncRaw)) throw new Error("pi-sync.json: autoSync 必须是对象。");
  const enabled = autoSyncRaw.enabled ?? false;
  if (typeof enabled !== "boolean") throw new Error("pi-sync.json: autoSync.enabled 必须是布尔值。");

  return { schemaVersion: 2, include, exclude, special, autoSync: { enabled } };
}

export async function loadConfig(repoPath: string): Promise<PiSyncConfig> {
  const configPath = join(repoPath, "pi-sync.json");
  try {
    return validateConfig(JSON.parse(await readFile(configPath, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`无法解析 pi-sync.json: ${configPath}`);
    throw error;
  }
}

export async function writeDefaultConfig(repoPath: string): Promise<void> {
  const config = structuredClone(DEFAULT_CONFIG);
  const packageSource = "npm:@xyzensun/pi-sync-pure";
  await writeFile(join(repoPath, "pi-sync.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await writeFile(
    join(repoPath, "sync", "settings.json"),
    `${JSON.stringify({ packages: [packageSource] }, null, 2)}\n`,
    "utf8",
  );
}

export async function loadLocalState(statePath: string): Promise<LocalState | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(statePath, "utf8"));
    if (!isRecord(raw) || typeof raw.remoteUrl !== "string" || typeof raw.deviceBranch !== "string") {
      throw new Error(`本地状态文件格式无效: ${statePath}`);
    }
    return { remoteUrl: raw.remoteUrl, deviceBranch: raw.deviceBranch };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    if (error instanceof SyntaxError) throw new Error(`无法解析本地状态文件: ${statePath}`);
    throw error;
  }
}

export async function saveLocalState(statePath: string, state: LocalState): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  try {
    await rename(temporaryPath, statePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export function isUnsafeRelativePath(value: string): boolean {
  return value.includes("\0") || value.startsWith("/") || value.startsWith("\\") ||
    /^[A-Za-z]:/.test(value) || value.split(/[\\/]/).includes("..");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
