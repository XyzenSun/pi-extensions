import { describe, expect, it } from "vitest";
import { isPathAllowed, minimatch, normalizePath } from "../src/glob.ts";

describe("glob filtering", () => {
  it.each([
    ["settings.json", "settings.json", true],
    ["extensions/foo/index.ts", "extensions/**", true],
    ["extensions/index.ts", "extensions/**", true],
    ["themes/dark.json", "**/*.json", true],
    ["extensions/a.ts", "extensions/*.ts", true],
    ["extensions/a/b.ts", "extensions/*.ts", false],
  ])("matches %s against %s", (path, pattern, expected) => {
    expect(minimatch(path, pattern)).toBe(expected);
  });

  it("normalizes safe relative paths and rejects traversal", () => {
    expect(normalizePath("./extensions\\foo//index.ts")).toBe("extensions/foo/index.ts");
    expect(() => normalizePath("../secret")).toThrow();
    expect(() => normalizePath("C:\\secret")).toThrow();
    expect(() => normalizePath("x\0y")).toThrow();
  });

  it("applies include, exclude, and hidden-file rules", () => {
    expect(isPathAllowed("settings.json", ["**/*"], []).allowed).toBe(true);
    expect(isPathAllowed("settings.json", ["**/*"], ["settings.json"]).allowed).toBe(false);
    expect(isPathAllowed("extensions/.cache/index.js", ["extensions/**"], []).allowed).toBe(false);
    expect(isPathAllowed(".gitignore", ["**/*"], []).allowed).toBe(true);
    expect(isPathAllowed("extensions/index.ts", ["skills/**"], []).allowed).toBe(false);
  });
});
