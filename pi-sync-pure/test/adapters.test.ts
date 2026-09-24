import { describe, expect, it } from "vitest";
import { settingsAdapter, SETTINGS_WHITELIST } from "../src/settings-adapter.ts";
import { adapterContext } from "../src/adapters.ts";

const context = adapterContext("/temporary/agent", "/temporary/repo", "settings.json");

describe("settings adapter", () => {
  it("projects only whitelisted fields and removes machine-specific package sources", async () => {
    const input = Buffer.from(JSON.stringify({
      theme: "dark",
      trackingId: "local-id",
      packages: ["npm:shared", "file:../local-plugin"],
    }));
    const result = JSON.parse((await settingsAdapter.transformToRepository!(input, context)).toString("utf8"));
    expect(Object.keys(result).every((key) => SETTINGS_WHITELIST.includes(key))).toBe(true);
    expect(result.packages).toContain("npm:shared");
    expect(result.packages).not.toContain("file:../local-plugin");
    expect(result.packages).toContain("npm:@xyzensun/pi-sync-pure");
  });

  it("preserves local-only keys and non-portable packages when materializing", async () => {
    const repository = Buffer.from(JSON.stringify({ theme: "light", packages: ["npm:shared"] }));
    const local = Buffer.from(JSON.stringify({ trackingId: "device-a", sessionDir: "/sessions", packages: ["file:../dev", "npm:shared"] }));
    const result = JSON.parse((await settingsAdapter.transformToLocal!(repository, local, context)).toString("utf8"));
    expect(result.theme).toBe("light");
    expect(result.trackingId).toBe("device-a");
    expect(result.sessionDir).toBe("/sessions");
    expect(result.packages).toContain("file:../dev");
    expect(result.packages).toContain("npm:@xyzensun/pi-sync-pure");
  });
});
