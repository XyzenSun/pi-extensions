import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform } from "node:os";

const execFileAsync = promisify(execFile);

export async function getMachineId(): Promise<string | undefined> {
  switch (platform()) {
    case "linux": {
      for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        try {
          const value = (await readFile(path, "utf8")).trim();
          if (value) return value;
        } catch {
          // 有些精简系统没有 machine-id，继续尝试其它来源。
        }
      }
      return undefined;
    }
    case "win32": {
      try {
        const { stdout } = await execFileAsync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { timeout: 3000 });
        return stdout.match(/MachineGuid\s+REG_SZ\s+(.+)/i)?.[1]?.trim();
      } catch {
        return undefined;
      }
    }
    case "darwin": {
      try {
        const { stdout } = await execFileAsync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { timeout: 3000 });
        return stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1];
      } catch {
        return undefined;
      }
    }
    default:
      return undefined;
  }
}

export async function defaultDeviceName(): Promise<string> {
  const machineId = await getMachineId();
  const identity = machineId ?? randomBytes(16).toString("hex");
  return `device-${createHash("sha256").update(identity).digest("hex").slice(0, 8)}`;
}
