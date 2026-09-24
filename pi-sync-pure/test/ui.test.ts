import { describe, expect, it, vi } from "vitest";
import { confirmForceOperation, confirmRecovery, selectClaimedBranch, selectOperation } from "../src/ui.ts";

function createUi(select: (title: string, options: string[]) => Promise<string | undefined>, hasUI = true) {
  return {
    hasUI,
    ui: {
      select,
      confirm: vi.fn(async () => false),
      input: vi.fn(async () => undefined),
      notify: vi.fn(),
    },
  };
}

describe("sync user interface policy", () => {
  it("offers a cancel-first confirmation for force operations", async () => {
    const select = vi.fn(async (_title: string, options: string[]) => options[0]);
    const context = createUi(select);
    expect(await confirmForceOperation(context, "align", ["settings.json"])).toBe(false);
    expect(select).toHaveBeenCalledWith(expect.stringContaining("settings.json"), ["取消", "继续执行"]);
  });

  it("offers device branch claims and explicit creation", async () => {
    const select = vi.fn(async (_title: string, options: string[]) => options.at(-1));
    expect(await selectClaimedBranch(createUi(select), ["device/old"])).toBeNull();
  });

  it("does not prompt without UI", async () => {
    const select = vi.fn(async () => undefined);
    expect(await selectOperation(createUi(select, false), true)).toBeUndefined();
    expect(await confirmRecovery(createUi(select, false))).toBe(true);
    expect(select).not.toHaveBeenCalled();
  });

  it("asks for a plain confirmation before recover, defaulting to cancel", async () => {
    const select = vi.fn(async (_title: string, options: string[]) => options[0]);
    expect(await confirmRecovery(createUi(select))).toBe(false);
    expect(select).toHaveBeenCalledWith(expect.stringContaining("覆盖"), ["取消", "继续执行"]);
  });
});
