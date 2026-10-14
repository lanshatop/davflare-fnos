import { afterEach, describe, expect, test, vi } from "vitest";
import { copyTextToClipboard } from "../copyText";

/** jsdom 不实现 execCommand，先补一个属性以便监听 */
function ensureExecCommand() {
  const doc = document as unknown as { execCommand?: unknown };
  if (typeof doc.execCommand !== "function") {
    doc.execCommand = () => false;
  }
  return vi.spyOn(document, "execCommand");
}

describe("copyTextToClipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("安全上下文：优先走 navigator.clipboard.writeText", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await copyTextToClipboard("hello");
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  test("标准 API 拒绝时降级到 execCommand，且成功复制", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const execSpy = ensureExecCommand().mockReturnValue(true);
    const remove = vi.spyOn(document.body, "removeChild");
    await copyTextToClipboard("fallback");
    expect(writeText).toHaveBeenCalled();
    expect(execSpy).toHaveBeenCalledWith("copy");
    expect(remove).toHaveBeenCalled();
    // 临时 textarea 已移除
    expect(document.querySelector("textarea[readonly]")).toBeNull();
  });

  test("无 navigator.clipboard（明文 HTTP）时直接降级 execCommand", async () => {
    vi.stubGlobal("navigator", {});
    const execSpy = ensureExecCommand().mockReturnValue(true);
    await copyTextToClipboard("http-copy");
    expect(execSpy).toHaveBeenCalledWith("copy");
  });

  test("两条路都失败时抛错（组件会提示复制失败）", async () => {
    vi.stubGlobal("navigator", {});
    ensureExecCommand().mockReturnValue(false);
    await expect(copyTextToClipboard("x")).rejects.toThrow();
  });
});
