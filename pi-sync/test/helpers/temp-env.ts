import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IS_WINDOWS = process.platform === "win32";
const ISOLATED_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "PI_CODING_AGENT_DIR",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_TERMINAL_PROMPT",
  "GIT_EDITOR",
  "GIT_ASKPASS",
  "PATH",
] as const;

type IsolatedEnvKey = (typeof ISOLATED_ENV_KEYS)[number];

export interface TestEnvironment {
  rootDir: string;
  homeDir: string;
  agentDir: string;
  repoDir: string;
  binDir: string;
  writeAgentFile(relativePath: string, content: string | Uint8Array): Promise<void>;
  writeRepoFile(relativePath: string, content: string | Uint8Array): Promise<void>;
  writeExecutable(name: string, content: string): Promise<string>;
  cleanup(): Promise<void>;
}

/**
 * Creates an isolated HOME, Pi agent directory, Git config and executable directory.
 * Tests that call this helper mutate process.env and must run serially.
 */
export async function createTestEnvironment(prefix = "pi-git-sync-"): Promise<TestEnvironment> {
  const rootDir = await mkdtemp(join(tmpdir(), prefix));
  const homeDir = join(rootDir, "home");
  const agentDir = join(homeDir, ".pi", "agent");
  const repoDir = join(rootDir, "config-repo");
  const binDir = join(rootDir, "bin");
  const gitConfigPath = join(homeDir, ".gitconfig");
  const previousEnv = new Map<IsolatedEnvKey, string | undefined>(
    ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]),
  );

  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(repoDir, { recursive: true }),
    mkdir(binDir, { recursive: true }),
  ]);
  await writeFile(gitConfigPath, "", "utf-8");

  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.GIT_CONFIG_GLOBAL = gitConfigPath;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_TERMINAL_PROMPT = "0";
  process.env.GIT_EDITOR = IS_WINDOWS ? "cmd /c exit 0" : "true";
  delete process.env.GIT_ASKPASS;
  process.env.PATH = `${binDir}${IS_WINDOWS ? ";" : ":"}${previousEnv.get("PATH") ?? ""}`;

  let cleanedUp = false;

  async function writeWithin(
    baseDir: string,
    relativePath: string,
    content: string | Uint8Array,
  ): Promise<void> {
    const targetPath = join(baseDir, relativePath);
    await mkdir(join(targetPath, ".."), { recursive: true });
    await writeFile(targetPath, content);
  }

  return {
    rootDir,
    homeDir,
    agentDir,
    repoDir,
    binDir,
    writeAgentFile: (relativePath, content) => writeWithin(agentDir, relativePath, content),
    writeRepoFile: (relativePath, content) => writeWithin(repoDir, relativePath, content),
    async writeExecutable(name, content) {
      const executablePath = join(binDir, name);
      await writeFile(executablePath, content, "utf-8");
      if (!IS_WINDOWS) await chmod(executablePath, 0o755);
      return executablePath;
    },
    async cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;

      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

export async function withTestEnvironment<T>(
  callback: (environment: TestEnvironment) => Promise<T>,
  prefix?: string,
): Promise<T> {
  const environment = await createTestEnvironment(prefix);
  try {
    return await callback(environment);
  } finally {
    await environment.cleanup();
  }
}
