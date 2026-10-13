/**
 * 静态资源服务（替代 Cloudflare Pages 的静态资源层）
 *
 * 复刻的行为：
 *  - 从构建产物目录（vite 的 build/）按路径取文件
 *  - 读取并应用 public/_headers（Pages 的 `_headers` 约定）
 *  - 未命中时返回 null，由调用方决定 SPA 回退
 *  - 带内容哈希的 /assets/* 直接给 immutable 长缓存
 *
 * 飞牛适配点（fnOS 桌面用 iframe 打开应用，而不同端口算跨源）：
 *  - 上游默认发 `X-Frame-Options: DENY`，会直接导致 fnOS 桌面里白屏。
 *  - 开启 DAVFLARE_ALLOW_IFRAME 后改为用 CSP `frame-ancestors` 控制，
 *    默认放开（可配成具体的 NAS 源），这样 iframe 入口能用。
 */

import { createReadStream } from "node:fs";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".webmanifest": "application/manifest+json",
};

export function contentTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

interface HeaderRule {
  matcher: RegExp;
  headers: Array<[string, string]>;
}

/** 解析 Pages 的 `_headers` 文件 */
export function parseHeadersFile(source: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let current: HeaderRule | null = null;
  for (const rawLine of source.split(/\r?\n/)) {
    if (rawLine.trim() === "" || rawLine.trimStart().startsWith("#")) continue;
    const indented = /^[\t ]/.test(rawLine);
    if (!indented) {
      const pattern = rawLine.trim();
      if (pattern === "") continue;
      current = { matcher: globToRegExp(pattern), headers: [] };
      rules.push(current);
      continue;
    }
    if (current === null) continue;
    const separator = rawLine.indexOf(":");
    if (separator < 0) continue;
    const name = rawLine.slice(0, separator).trim();
    const value = rawLine.slice(separator + 1).trim();
    if (name) current.headers.push([name, value]);
  }
  return rules;
}

function globToRegExp(pattern: string): RegExp {
  if (pattern === "/*" || pattern === "*") return /^.*$/;
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export interface StaticAssetsOptions {
  /** vite 产物目录 */
  root: string;
  /** 是否允许被 iframe 嵌入（fnOS 桌面入口需要） */
  allowIframe: boolean;
  /** CSP frame-ancestors 值，默认 * */
  frameAncestors: string;
  /** 追加/覆盖静态响应头 */
  extraHeaders?: Record<string, string>;
  /**
   * 用户自定义品牌 logo（品牌自定义功能，见 functions/_branding.ts）。
   * 命中 /favicon.png、/logo144.png 时优先返回它——这样登录页、分享落地页、
   * 收集页、WebDAV 目录页等所有引用 favicon 的页面无需改动就能换标。
   */
  logoOverride?: () => Promise<{ body: Buffer; contentType: string } | null>;
}

export class StaticAssets {
  private readonly options: StaticAssetsOptions;
  /** 规范化后的产物根目录（绝对路径，统一分隔符） */
  private readonly root: string;
  private readonly rootWithSep: string;
  private rules: HeaderRule[] = [];
  private ready = false;

  constructor(options: StaticAssetsOptions) {
    // 必须规范化：调用方可能传 `build/`、`./build` 或正斜杠路径，
    // 而 path.resolve 在 Windows 上产出反斜杠，直接字符串比较会恒不相等 → 误判越界 403
    this.root = path.resolve(options.root);
    this.rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    this.options = { ...options, root: this.root };
  }

  async init(): Promise<void> {
    if (this.ready) return;
    this.ready = true;
    try {
      const source = await fsp.readFile(path.join(this.root, "_headers"), "utf8");
      this.rules = parseHeadersFile(source);
    } catch {
      this.rules = [];
    }
  }

  private applyHeaders(headers: Headers, urlPath: string, filePath: string): void {
    for (const rule of this.rules) {
      if (!rule.matcher.test(urlPath)) continue;
      for (const [name, value] of rule.headers) {
        if (name.toLowerCase() === "x-frame-options" && this.options.allowIframe) continue;
        headers.set(name, value);
      }
    }
    if (this.options.allowIframe) {
      headers.set(
        "Content-Security-Policy",
        `frame-ancestors ${this.options.frameAncestors}`
      );
    }
    for (const [name, value] of Object.entries(this.options.extraHeaders ?? {})) {
      headers.set(name, value);
    }
    // 带内容哈希的构建产物可以长缓存
    if (urlPath.startsWith("/assets/") && !headers.has("Cache-Control")) {
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
    }
    if (!headers.has("Accept-Ranges")) headers.set("Accept-Ranges", "bytes");
    if (!headers.has("Content-Type")) headers.set("Content-Type", contentTypeFor(filePath));
  }

  /** 命中返回 Response，未命中返回 null（交给 SPA 回退） */
  async serve(request: Request): Promise<Response | null> {
    await this.init();
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") return null;

    const url = new URL(request.url);
    let pathname = url.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    if (pathname.includes("\0")) return new Response("Bad Request", { status: 400 });

    // 品牌自定义：默认图标让位给用户上传的 logo
    if (
      this.options.logoOverride &&
      (pathname === "/favicon.png" || pathname === "/logo144.png")
    ) {
      const override = await this.options.logoOverride();
      if (override) {
        const headers = new Headers();
        this.applyHeaders(headers, pathname, pathname);
        headers.set("Content-Type", override.contentType);
        headers.set("Content-Length", String(override.body.byteLength));
        headers.set("Cache-Control", "no-cache");
        if (method === "HEAD") return new Response(null, { status: 200, headers });
        return new Response(new Uint8Array(override.body), { status: 200, headers });
      }
    }

    const relative = pathname.replace(/^\/+/, "");
    const target = path.resolve(this.root, relative);
    // path.resolve(root, "") 在部分平台会带尾分隔符，先归一化再比较
    const normalizedTarget = target.endsWith(path.sep) ? target.slice(0, -1) : target;
    if (normalizedTarget !== this.root && !target.startsWith(this.rootWithSep)) {
      return new Response("Forbidden", { status: 403 });
    }

    let stat = await fsp.stat(target).catch(() => null);
    if (stat?.isDirectory()) {
      const indexTarget = path.join(target, "index.html");
      stat = await fsp.stat(indexTarget).catch(() => null);
      if (stat?.isFile()) return this.respond(request, indexTarget, stat.size, pathname, method);
      return null;
    }
    if (stat?.isFile()) return this.respond(request, target, stat.size, pathname, method);
    return null;
  }

  private respond(
    request: Request,
    filePath: string,
    size: number,
    urlPath: string,
    method: string,
    status = 200
  ): Response {
    const headers = new Headers();
    this.applyHeaders(headers, urlPath, filePath);
    headers.set("Content-Length", String(size));
    const lastModified = new Date();
    headers.set("Last-Modified", lastModified.toUTCString());

    // SPA 回退时 pathname 与真实文件不一致，缓存策略按 index.html 走
    if (filePath.endsWith("index.html")) {
      headers.set("Cache-Control", "no-cache");
    }

    if (method === "HEAD") {
      return new Response(null, { status, headers });
    }
    const stream = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream;
    return new Response(stream, { status, headers });
  }

  /** SPA 回退：返回 index.html（Pages 在没有根级 404.html 时的行为） */
  async fallback(request: Request): Promise<Response> {
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return new Response("Not Found", { status: 404 });
    }
    await this.init();
    const indexFile = path.join(this.root, "index.html");
    const stat = await fsp.stat(indexFile).catch(() => null);
    if (stat?.isFile()) return this.respond(request, indexFile, stat.size, "/index.html", method);
    return new Response("Not Found", { status: 404 });
  }
}
