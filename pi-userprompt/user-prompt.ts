import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function loadUserPrompt(
  cwd: string,
  agentDir: string,
  projectTrusted: boolean,
): Promise<string | undefined> {
  const candidates = projectTrusted
    ? [join(cwd, ".pi", "USER.md"), join(agentDir, "USER.md")]
    : [join(agentDir, "USER.md")];

  for (const filePath of candidates) {
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`无法读取 ${filePath}: ${reason}`);
    }

    // 空项目文件用于停用全局偏好, 因此只有文件不存在时才回退.
    const text = content.replace(/^\uFEFF/, "");
    return text.trim() ? text : undefined;
  }

  return undefined;
}
