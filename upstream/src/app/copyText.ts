/**
 * 把文本写入系统剪贴板。
 *
 * `navigator.clipboard` 只在安全上下文（HTTPS 或 localhost）中由浏览器提供；
 * 飞牛 NAS 上通常通过 http://IP:端口 明文地址访问应用，此时该 API 不存在，
 * 直接调用会抛错并提示「复制失败」。因此这里先尝试标准 API，失败后降级为
 * 隐藏 textarea + document.execCommand("copy") 的传统方案（用户手势触发时
 * 在明文 HTTP 页面上同样有效）。
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // 权限被拒或写入失败，继续尝试降级方案
    }
  }
  legacyCopy(text);
}

function legacyCopy(text: string): void {
  if (typeof document === "undefined") {
    throw new Error("Clipboard is unavailable in this environment");
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  const selection = document.getSelection();
  const previousRange =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  textarea.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("execCommand(\"copy\") returned false");
    }
  } finally {
    document.body.removeChild(textarea);
    if (previousRange && selection) {
      selection.removeAllRanges();
      selection.addRange(previousRange);
    }
  }
}
