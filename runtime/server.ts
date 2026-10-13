/**
 * 飞牛 fnOS 本地运行时入口
 *
 * 职责：
 *  1. 读配置（环境变量 / 配置文件）
 *  2. 起一个 node:http 服务，把 Node 的请求转成 Web 标准的 Request
 *  3. 交给 Pages 运行时（upstream/functions/** 原样执行）
 *  4. 把 Web Response 写回 Node 响应，**流式**转发，不缓冲大文件
 *
 * 与 Cloudflare 平台的差异都在这里补齐：
 *  - R2 桶绑定        → 文件系统实现（lib/r2-fs.ts）
 *  - Pages 静态资源   → lib/static-assets.ts
 *  - HTTP Range       → lib/r2-fs.ts 的 resolveRange + 上游自带的 206 逻辑
 *  - 请求体大小上限   → 无（流式落盘，单文件可任意大；分块上传按块流式拼接）
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";

import { FsBucket } from "./lib/r2-fs";
import { PagesRuntime, type PagesEnv } from "./lib/pages";
import { StaticAssets } from "./lib/static-assets";
import {
  BRANDING_CONFIG_KEY,
  BRANDING_LOGO_MAX_BYTES,
  BRANDING_LOGO_PREFIX,
  BRANDING_NAME_MAX,
} from "../upstream/functions/_branding";
import { middlewareModules, routes } from "./routes";

interface RuntimeConfig {
  port: number;
  host: string;
  dataDir: string;
  metaDir: string;
  tmpDir: string;
  buildDir: string;
  username: string;
  password: string;
  publicRead: boolean;
  /** 匿名只读 WebDAV 目录（网盘根目录下的文件夹名）；空 = 关闭 */
  webdavPublicDir: string;
  /**
   * 匿名只读 WebDAV 目录的生效开关（飞牛适配）。
   * 两级判断：目录名非空 **且** 开关开启，才会把 WEBDAV_PUBLIC_DIR 交给处理器。
   * 关掉开关即可在不丢失目录名配置的前提下立即停用该目录的匿名访问。
   */
  webdavPublicDirOn: boolean;
  sitesHost: string;
  /** 品牌名称（安装向导透传）；仅在数据目录还没有品牌配置时生效，之后以界面「设置 → 品牌」为准 */
  brandName: string;
  /** 品牌 Logo 图片绝对路径（安装向导透传）；生效时机同上 */
  brandLogoPath: string;
  trashRetentionDays: string;
  allowIframe: boolean;
  frameAncestors: string;
  logRequests: boolean;
  /** 单次请求体上限（字节）；<= 0 表示不限制。见 upstream/functions/_platform.ts */
  maxRequestBytes: number;
}

function envOf(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

async function loadConfigFile(): Promise<Record<string, string>> {
  const configPath = process.env.DAVFLARE_CONFIG;
  if (!configPath) return {};
  try {
    const parsed = JSON.parse(await fsp.readFile(configPath, "utf8")) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value === null || value === undefined) continue;
      out[key.toUpperCase()] = String(value);
    }
    return out;
  } catch (error) {
    console.warn(`[davflare] 无法读取配置文件 ${configPath}: ${(error as Error).message}`);
    return {};
  }
}

async function resolveConfig(): Promise<RuntimeConfig> {
  const fileConfig = await loadConfigFile();
  const pick = (name: string, fallback: string): string =>
    process.env[name] ?? fileConfig[name] ?? fallback;

  const bundleDir = __dirname;
  return {
    port: Number(pick("DAVFLARE_PORT", pick("PORT", "8087"))),
    host: pick("DAVFLARE_HOST", "0.0.0.0"),
    dataDir: pick("DAVFLARE_DATA_DIR", "/data"),
    metaDir: pick("DAVFLARE_META_DIR", path.join(bundleDir, "..", "var", "meta")),
    tmpDir: pick("DAVFLARE_TMP_DIR", path.join(bundleDir, "..", "var", "tmp")),
    buildDir: pick("DAVFLARE_BUILD_DIR", path.join(bundleDir, "..", "build")),
    username: pick("WEBDAV_USERNAME", pick("DAVFLARE_USERNAME", "")),
    password: pick("WEBDAV_PASSWORD", pick("DAVFLARE_PASSWORD", "")),
    publicRead: pick("WEBDAV_PUBLIC_READ", "0") === "1",
    webdavPublicDir: pick("WEBDAV_PUBLIC_DIR", "").trim().replace(/^\/+|\/+$/g, ""),
    // 缺省视为「开启」：老配置里只有目录名、没有这个开关，升级后行为保持不变；
    // 只有显式写成 0 / false / off / no 才算关闭。
    webdavPublicDirOn: !["0", "false", "off", "no"].includes(
      pick("WEBDAV_PUBLIC_DIR_ON", "1").trim().toLowerCase()
    ),
    sitesHost: pick("SITES_HOST", pick("DAVFLARE_SITES_HOST", "")),
    brandName: pick("BRAND_NAME", "").trim().slice(0, BRANDING_NAME_MAX),
    brandLogoPath: pick("BRAND_LOGO_PATH", "").trim(),
    trashRetentionDays: pick("TRASH_RETENTION_DAYS", ""),
    // 飞牛桌面用 iframe 打开应用；Cloudflare 时代没有这个约束，所以默认保持上游的 DENY，
    // 由 fpk 在安装时按用户选择写入 DAVFLARE_ALLOW_IFRAME=1。
    allowIframe: pick("DAVFLARE_ALLOW_IFRAME", "0") === "1",
    frameAncestors: pick("DAVFLARE_FRAME_ANCESTORS", "*"),
    logRequests: pick("DAVFLARE_LOG", "0") === "1",
    // 飞牛适配：Cloudflare 上单次请求体约 100MB，自托管没有这个平台限制。
    // 默认 0 = 不限制（只受磁盘容量约束）；需要限流时填字节数。
    maxRequestBytes: Number(pick("DAVFLARE_MAX_REQUEST_BYTES", "0")),
  };
}

function hasRequestBody(method: string): boolean {
  const upper = method.toUpperCase();
  return upper !== "GET" && upper !== "HEAD" && upper !== "OPTIONS";
}

/** 品牌 Logo 支持的图片扩展名 → MIME（与 functions/_branding.ts 的白名单对齐） */
const LOGO_EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
};

/**
 * 品牌种子化（飞牛适配）：安装向导填了「品牌名称 / Logo 图片路径」时，
 * 在数据目录**首次初始化**（还没有 branding.json）时写入。
 * 之后用户在「设置 → 品牌」里的任何修改都不受影响 —— 重启不会拿向导旧值
 * 覆盖界面里的新配置；想改品牌请直接用设置页（支持即时预览与上传）。
 */
async function seedBranding(bucket: FsBucket, config: RuntimeConfig): Promise<void> {
  if (!config.brandName && !config.brandLogoPath) return;
  try {
    if (await bucket.head(BRANDING_CONFIG_KEY)) return; // 已有品牌配置：尊重现状
    const brand: { name: string | null; logoKey: string | null } = {
      name: config.brandName || null,
      logoKey: null,
    };
    if (config.brandLogoPath) {
      try {
        const rawExt = path.extname(config.brandLogoPath).slice(1).toLowerCase();
        const ext = rawExt === "jpeg" ? "jpg" : rawExt;
        const mime = LOGO_EXT_MIME[ext];
        if (!mime) throw new Error(`不支持的图片格式 .${rawExt}（支持 png/jpg/gif/webp/svg/ico）`);
        const data = await fsp.readFile(config.brandLogoPath);
        if (data.byteLength > BRANDING_LOGO_MAX_BYTES) {
          throw new Error(`图片 ${data.byteLength} 字节，超过 2MB 上限`);
        }
        const key = `${BRANDING_LOGO_PREFIX}${ext}`;
        await bucket.put(key, data, { httpMetadata: { contentType: mime } });
        brand.logoKey = key;
        console.log(`[davflare] 品牌 Logo 已从 ${config.brandLogoPath} 导入`);
      } catch (error) {
        console.warn(`[davflare] 品牌 Logo 导入失败（跳过）: ${(error as Error).message}`);
      }
    }
    if (brand.name || brand.logoKey) {
      await bucket.put(BRANDING_CONFIG_KEY, JSON.stringify(brand), {
        httpMetadata: { contentType: "application/json" },
      });
      console.log(
        `[davflare] 品牌已初始化：${brand.name ?? "(默认名称)"}${brand.logoKey ? " + 自定义 Logo" : ""}`
      );
    }
  } catch (error) {
    console.warn(`[davflare] 品牌初始化失败（不影响启动）: ${(error as Error).message}`);
  }
}

/**
 * 品牌自定义 logo 的读取回调（供静态层覆盖 /favicon.png、/logo144.png）。
 * logo 存放在数据目录 `_$flaredrive$/branding/logo.<ext>`（与 functions/_branding.ts 的
 * 上传端点同源）。带 3 秒 TTL 缓存：favicon 是每个页面都会请求的资源，
 * 不能每次都 readdir + readFile；TTL 保证设置页改完 logo 后几秒内全站生效。
 */
function createLogoOverride(
  dataDir: string
): () => Promise<{ body: Buffer; contentType: string } | null> {
  const TTL_MS = 3000;
  let cache: { at: number; value: { body: Buffer; contentType: string } | null } | null = null;
  return async () => {
    if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
    let value: { body: Buffer; contentType: string } | null = null;
    try {
      const dir = path.join(dataDir, "_$flaredrive$", "branding");
      const logoFile = (await fsp.readdir(dir)).find((f) => f.startsWith("logo."));
      if (logoFile) {
        const ext = logoFile.slice("logo.".length).toLowerCase();
        const mime =
          ext === "jpg"
            ? "image/jpeg"
            : ext === "svg"
            ? "image/svg+xml"
            : `image/${ext}`;
        value = { body: await fsp.readFile(path.join(dir, logoFile)), contentType: mime };
      }
    } catch {
      value = null;
    }
    cache = { at: Date.now(), value };
    return value;
  };
}

/**
 * 排空没有被下游读完的请求体。
 *
 * 很多端点会在读正文之前就返回（鉴权失败 401、参数不合法 400、405……），
 * 此时请求流还挂在 socket 上。如果不排空，这条 keep-alive 连接就永远处于
 * 「半读」状态：客户端把它还回连接池后复用，下一次请求会一直等不到响应，
 * 直到服务端的 headersTimeout（60s）把连接掐掉，表现为一次 66 秒后的 ECONNRESET。
 * 与其让用户等一分钟，不如立刻把数据读掉丢弃；确实很大的（客户端还在传大文件）
 * 就直接断开，避免白读流量。
 */
function drainUnreadRequest(req: IncomingMessage): void {
  if (req.readableEnded || req.destroyed) return;
  let drained = 0;
  const DRAIN_LIMIT = 1 << 20;
  req.on("data", (chunk: Buffer) => {
    drained += chunk.length;
    if (drained > DRAIN_LIMIT) {
      req.destroy();
    }
  });
  req.on("error", () => undefined);
  req.resume();
}

function toWebRequest(req: IncomingMessage, host: string): Request {
  const method = (req.method ?? "GET").toUpperCase();
  const url = `http://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }

  const init: RequestInit & { duplex?: string } = { method, headers };
  if (hasRequestBody(method)) {
    // 关键：直接把 Node 的请求流交给下游 —— 不缓冲，
    // 因此上传总大小只受磁盘限制，不受内存限制。
    init.body = Readable.toWeb(req) as unknown as ReadableStream;
    init.duplex = "half";
  }
  return new Request(url, init as RequestInit);
}

async function sendWebResponse(
  res: ServerResponse,
  response: Response,
  method: string,
  forceClose = false
): Promise<void> {
  const status = response.status === 101 ? 200 : response.status;
  const headers: Array<[string, string]> = [];
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() === "set-cookie") continue;
    if (name.toLowerCase() === "connection") continue;
    headers.push([name, value]);
  }
  const setCookies =
    typeof (response.headers as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (response.headers as { getSetCookie: () => string[] }).getSetCookie()
      : [];

  res.statusCode = status;
  for (const [name, value] of headers) res.setHeader(name, value);
  if (setCookies.length > 0) res.setHeader("Set-Cookie", setCookies);

  // 请求体没被下游读完（典型：413 / 401 / 400 这类提前返回）。
  // Node 会在响应结束后销毁这条连接，但客户端（如 undici / fetch）已经把 socket
  // 还回连接池，复用时会立刻撞上 ECONNRESET。显式声明 Connection: close 让客户端
  // 不要复用这条连接，与上游 Cloudflare 每次请求独立连接的语义也一致。
  if (forceClose) {
    res.setHeader("Connection", "close");
    res.shouldKeepAlive = false;
  }

  const bodyless =
    method.toUpperCase() === "HEAD" ||
    status === 204 ||
    status === 304 ||
    status < 200;

  if (bodyless || response.body === null) {
    if (status === 204 || status === 304) res.removeHeader("Content-Length");
    res.end();
    return;
  }

  const stream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    stream.on("error", (error) => {
      console.error("[davflare] 响应流错误:", error);
      res.destroy();
      done();
    });
    res.on("close", () => {
      stream.destroy();
      done();
    });
    res.on("error", (error) => {
      console.error("[davflare] 响应写错误:", error);
      stream.destroy();
      done();
    });
    stream.pipe(res);
    stream.on("end", done);
  });
}

async function main(): Promise<void> {
  const config = await resolveConfig();

  // 平台适配：上游把「Cloudflare 单次请求体约 100MB」这个平台限制写死在
  // /api/upload 与 WebDAV PUT 的前置校验里。自托管运行时没有这个限制，
  // 这里统一覆盖成「不限制」（<=0），正文由存储层流式落盘，内存与文件大小无关。
  const maxRequest = Number.isFinite(config.maxRequestBytes) ? config.maxRequestBytes : 0;
  (globalThis as typeof globalThis & { __DAVFLARE_MAX_REQUEST_BYTES__?: number })
    .__DAVFLARE_MAX_REQUEST_BYTES__ = maxRequest;

  await fsp.mkdir(config.dataDir, { recursive: true });
  await fsp.mkdir(config.metaDir, { recursive: true });
  await fsp.mkdir(config.tmpDir, { recursive: true });

  if (!config.username || !config.password) {
    console.warn(
      "[davflare] 警告：未配置 WEBDAV_USERNAME / WEBDAV_PASSWORD。" +
        "上游的鉴权是 fail-closed，未配置时 WebDAV 与受保护接口会一律拒绝访问。"
    );
  }

  const bucket = new FsBucket({
    root: config.dataDir,
    metaRoot: config.metaDir,
    tmpRoot: config.tmpDir,
  });

  // 安装向导的品牌配置只在首次初始化时落盘（见 seedBranding 注释）
  await seedBranding(bucket, config);

  const env: PagesEnv = {
    BUCKET: bucket,
    WEBDAV_USERNAME: config.username,
    WEBDAV_PASSWORD: config.password,
    WEBDAV_PUBLIC_READ: config.publicRead ? "1" : "0",
    // 匿名只读 WebDAV 目录（protocol.ts 里校验合法性，非法值按关闭处理）。
    // 开关关闭时**完全不注入**该变量 —— 处理器侧等同于「未配置」，匿名目录彻底不存在，
    // 而不是靠处理器再判断一次，避免任何绕过开关的可能。
    ...(config.webdavPublicDir && config.webdavPublicDirOn
      ? { WEBDAV_PUBLIC_DIR: config.webdavPublicDir }
      : {}),
    ...(config.sitesHost ? { SITES_HOST: config.sitesHost } : {}),
    ...(config.trashRetentionDays ? { TRASH_RETENTION_DAYS: config.trashRetentionDays } : {}),
  };

  const staticAssets = new StaticAssets({
    root: config.buildDir,
    allowIframe: config.allowIframe,
    frameAncestors: config.frameAncestors,
    extraHeaders: {},
    // 品牌自定义：用户上传的 logo 覆盖默认 favicon / PWA 图标
    logoOverride: createLogoOverride(config.dataDir),
  });
  await staticAssets.init();

  const runtime = new PagesRuntime({
    routes,
    middleware: middlewareModules,
    env,
    serveStatic: (request) => staticAssets.serve(request),
    fallback: (request) => staticAssets.fallback(request),
    onError: (error, request) => {
      console.error(`[davflare] ${request.method} ${request.url} 处理失败:`, error);
    },
  });

  const server = createServer((req, res) => {
    void (async () => {
      const host = req.headers.host ?? `${config.host}:${config.port}`;
      const started = Date.now();
      try {
        if ((req.url ?? "").startsWith("/healthz")) {
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("ok");
          return;
        }
        const request = toWebRequest(req, host);
        const response = await runtime.handle(request);
        // 下游读完了请求体才能安全复用这条 keep-alive 连接；
        // 提前返回（413/401/400…）造成的半读连接必须显式关闭。
        const requestFullyRead =
          !hasRequestBody(req.method ?? "GET") || req.readableEnded || req.complete;
        await sendWebResponse(res, response, req.method ?? "GET", !requestFullyRead);
        drainUnreadRequest(req);
        if (config.logRequests) {
          console.log(
            `${req.method} ${req.url} -> ${response.status} ${Date.now() - started}ms`
          );
        }
      } catch (error) {
        console.error(`[davflare] 未捕获异常 ${req.method} ${req.url}:`, error);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        }
        res.end("Internal Server Error");
        drainUnreadRequest(req);
      }
    })();
  });

  // 大文件上传 / 长时间下载：关闭 Node 默认的请求超时
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });

  console.log(
    `[davflare] 已启动 http://${config.host}:${config.port}\n` +
      `  数据目录   = ${config.dataDir}\n` +
      `  元数据目录 = ${config.metaDir}\n` +
      `  静态资源   = ${config.buildDir}\n` +
      `  上传上限   = ${maxRequest <= 0 ? "不限制（受磁盘容量约束）" : `${maxRequest} 字节`}\n` +
      `  WebDAV     = ${config.username ? `已启用（用户 ${config.username}）` : "未启用（缺凭据）"}`
  );

  const shutdown = (signal: string): void => {
    console.log(`[davflare] 收到 ${signal}，正在退出…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  console.error("[davflare] 启动失败:", error);
  process.exit(1);
});
