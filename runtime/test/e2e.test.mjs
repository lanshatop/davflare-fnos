/**
 * 端到端测试：起真实的 HTTP 服务，用真实的请求打真实的上游端点。
 *
 * 覆盖的每一条都对应 Davflare 的一项功能，用来证明「移植到飞牛后功能没有删减」：
 *   静态资源层 / 文件与目录管理 / 搜索与计数 / 上传（含分块）/ 下载（含 Range）/
 *   分享（含提取码、目录 zip、Range 直链）/ 回收站（软删、还原、彻底删除）/
 *   WebDAV（OPTIONS/PROPFIND/MKCOL/PUT/GET/MOVE/DELETE）/ MCP（initialize、tools/list）/
 *   配置与功能开关 / API 密钥 / 静态站（sites 主机）/ 图床（/i/{id}）/ 认证边界。
 *
 * 关于认证：上游契约里三类端点的鉴权方式不同，测试按真实契约发凭据——
 *   · authorizeApiKey            只认 X-Api-Key / Authorization: Bearer
 *   · verifyBasicAuth            只认 Authorization: Basic
 *   · isSessionOrKeyAuthorized   两者任一
 * 因此 requests 同时带上 Basic 与 X-Api-Key（与真实客户端一致：网页端走 Basic，
 * CLI / 扩展 / MCP 走密钥），并对「只认密钥」的端点单独做反向断言。
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = path.resolve(here, "..");
const serverEntry = path.join(runtimeDir, "dist", "server.cjs");
const buildDir = path.join(runtimeDir, "test", "fixtures", "build");

const USER = "tester";
const PASS = "s3cret-pass";
const basicHeader = `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`;

let base;          // 临时根目录
let dataDir;       // 「R2 桶」根目录
let metaDir;
let drive;         // 网盘主服务（无 SITES_HOST）
let sites;         // 站点服务（SITES_HOST=127.0.0.1，只用来读静态站/图床）
let apiKey;        // before() 里通过 /api/keys 创建

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startServer(extraEnv) {
  const port = 18000 + Math.floor(Math.random() * 3000);
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      DAVFLARE_PORT: String(port),
      DAVFLARE_HOST: "127.0.0.1",
      DAVFLARE_DATA_DIR: dataDir,
      DAVFLARE_META_DIR: metaDir,
      DAVFLARE_TMP_DIR: path.join(base, `tmp-${port}`),
      DAVFLARE_BUILD_DIR: buildDir,
      WEBDAV_USERNAME: USER,
      WEBDAV_PASSWORD: PASS,
      DAVFLARE_ALLOW_IFRAME: "1",
      DAVFLARE_LOG: "0",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) console.error("[e2e] 服务退出", code, stderr);
  });

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) return { origin, child };
    } catch {
      /* 还没起来 */
    }
    await sleep(120);
  }
  throw new Error(`服务未能在预期时间内启动（${origin}）\n${stderr}`);
}

/** 带齐两类凭据的请求：能同时满足 authorizeApiKey 与 verifyBasicAuth */
function api(pathname, init = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", basicHeader);
  if (apiKey) headers.set("X-Api-Key", apiKey);
  return fetch(`${drive.origin}${pathname}`, { ...init, headers });
}

/** 只带 Basic（浏览器会话） */
function session(pathname, init = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", basicHeader);
  return fetch(`${drive.origin}${pathname}`, { ...init, headers });
}

/** 只带密钥（CLI / 扩展 / MCP） */
function keyed(pathname, init = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set("X-Api-Key", apiKey);
  return fetch(`${drive.origin}${pathname}`, { ...init, headers });
}

const jsonBody = (value) => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});

before(async () => {
  base = await mkdtemp(path.join(tmpdir(), "davflare-e2e-"));
  dataDir = path.join(base, "data");
  metaDir = path.join(base, "meta");
  await mkdir(dataDir, { recursive: true });
  await mkdir(metaDir, { recursive: true });

  drive = await startServer({});

  const created = await session("/api/keys", {
    method: "POST",
    ...jsonBody({ name: "e2e-bootstrap" }),
  });
  assert.equal(created.status, 200, "引导密钥创建失败");
  apiKey = (await created.json()).key;
  assert.ok(apiKey, "没有拿到明文密钥");

  sites = await startServer({ SITES_HOST: "127.0.0.1" });
});

after(async () => {
  drive?.child.kill("SIGKILL");
  sites?.child.kill("SIGKILL");
  if (base) await rm(base, { recursive: true, force: true });
});

// ────────────────────────────── 静态资源层 ──────────────────────────────

describe("静态资源（Pages 静态层）", () => {
  test("GET / 返回 SPA 的 index.html，并带上 _headers 里的安全头", async () => {
    const response = await fetch(`${drive.origin}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.match(await response.text(), /Davflare/);
  });

  test("未命中的路径回退到 index.html（SPA 行为）", async () => {
    const response = await fetch(`${drive.origin}/totally/unknown/route`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(await response.text(), /Davflare/);
  });

  test("带内容哈希的 /assets/* 拿到 immutable 长缓存", async () => {
    const response = await fetch(`${drive.origin}/assets/app-abc123.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /immutable/);
  });

  test("路径穿越被拦截", async () => {
    const response = await fetch(`${drive.origin}/..%2f..%2fpackage.json`);
    assert.ok(response.status === 403 || response.status === 200, `意外状态：${response.status}`);
    // 200 只可能是 SPA 回退（html），绝不能是 package.json 的内容
    if (response.status === 200) {
      const text = await response.text();
      assert.doesNotMatch(text, /"devDependencies"|"scripts"/);
    }
  });

  test("飞牛适配：允许 iframe 嵌入时不发 X-Frame-Options，改用 CSP frame-ancestors", async () => {
    const response = await fetch(`${drive.origin}/`);
    // 上游 _headers 里写的是 X-Frame-Options: DENY，在 fnOS 桌面 iframe 里会白屏
    assert.equal(response.headers.get("x-frame-options"), null);
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors/);
  });
});

// ────────────────────────── 文件与目录管理 ──────────────────────────

describe("文件与目录管理（/api/mkdir /api/list /api/stat /api/rename /api/copy）", () => {
  test("mkdir 建目录后 list 能看到它（目录标记语义）", async () => {
    const created = await api("/api/mkdir", {
      method: "POST",
      ...jsonBody({ path: "媒体" }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.key, "媒体");
    assert.equal(createdBody.created, true);

    const listing = await api("/api/list?path=");
    assert.equal(listing.status, 200);
    const body = await listing.json();
    const entry = body.items.find((item) => item.name === "媒体");
    assert.ok(entry, `列表里没有新建目录：${JSON.stringify(body.items)}`);
    assert.equal(entry.isDir, true);
  });

  test("重复 mkdir 幂等返回 200", async () => {
    const again = await api("/api/mkdir", {
      method: "POST",
      ...jsonBody({ path: "媒体" }),
    });
    assert.equal(again.status, 200);
    const body = await again.json();
    assert.equal(body.created, false);
    assert.equal(body.existed, "directory");
  });

  test("stat 返回文件元信息（kind/size/contentType）", async () => {
    await writeFile(path.join(dataDir, "媒体", "note.txt"), "hello e2e");
    const response = await api("/api/stat?path=" + encodeURIComponent("媒体/note.txt"));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.kind, "file");
    assert.equal(body.key, "媒体/note.txt");
    assert.equal(body.size, 9);
    assert.ok(body.etag);
  });

  test("stat 目录返回 kind=directory", async () => {
    const body = await (await api("/api/stat?path=" + encodeURIComponent("媒体"))).json();
    assert.equal(body.kind, "directory");
    assert.equal(body.marker, true);
  });

  test("内部目录 _\\$flaredrive\\$ 被拒绝访问", async () => {
    const list = await api("/api/list?path=" + encodeURIComponent("_$flaredrive$"));
    assert.equal(list.status, 400);
    const stat = await api("/api/stat?path=" + encodeURIComponent("_$flaredrive$/config.json"));
    assert.equal(stat.status, 400);
  });

  test("rename 改名后磁盘上的文件真的换了名字", async () => {
    const response = await api("/api/rename", {
      method: "POST",
      ...jsonBody({ from: "媒体/note.txt", to: "媒体/renamed.txt" }),
    });
    assert.ok(response.status < 300, await response.text());
    assert.equal(await readFile(path.join(dataDir, "媒体", "renamed.txt"), "utf8"), "hello e2e");
    await assert.rejects(() => readFile(path.join(dataDir, "媒体", "note.txt")));
  });

  test("copy 复制文件后两份都在", async () => {
    const response = await api("/api/copy", {
      method: "POST",
      ...jsonBody({ from: "媒体/renamed.txt", to: "媒体/copied.txt" }),
    });
    assert.ok(response.status < 300, await response.text());
    assert.equal(await readFile(path.join(dataDir, "媒体", "copied.txt"), "utf8"), "hello e2e");
    assert.equal(await readFile(path.join(dataDir, "媒体", "renamed.txt"), "utf8"), "hello e2e");
  });

  test("目录整体 rename（moveDirectory 路径）", async () => {
    await api("/api/mkdir", { method: "POST", ...jsonBody({ path: "待搬/里面" }) });
    await writeFile(path.join(dataDir, "待搬", "里面", "x.txt"), "moved");

    const response = await api("/api/rename", {
      method: "POST",
      ...jsonBody({ from: "待搬", to: "已搬" }),
    });
    assert.ok(response.status < 300, await response.text());
    assert.equal(await readFile(path.join(dataDir, "已搬", "里面", "x.txt"), "utf8"), "moved");
    await assert.rejects(() => access(path.join(dataDir, "待搬")));
  });
});

describe("搜索与目录计数", () => {
  test("search 能找到刚上传的文件", async () => {
    const response = await api("/api/search?q=renamed");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.items));
    assert.match(JSON.stringify(body.items), /renamed\.txt/);
  });

  test("counts 批量统计目录直接子项数", async () => {
    const response = await api("/api/counts", {
      method: "POST",
      ...jsonBody({ paths: ["媒体"] }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(JSON.stringify(body).includes("媒体"), `没有统计结果：${JSON.stringify(body)}`);
  });
});

// ────────────────────────── 上传与下载 ──────────────────────────

describe("上传与下载", () => {
  test("小文件上传（POST + X-File-Name）能原样下载，带 attachment 与 Accept-Ranges", async () => {
    const payload = new Uint8Array(1024).map((_, index) => index % 251);
    const uploaded = await api("/api/upload?path=" + encodeURIComponent("媒体"), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-File-Name": "sample.bin" },
      body: payload,
    });
    // 注意：断言消息参数是「先求值」的，不能在这里 await 正文，否则把响应体读掉了
    assert.equal(uploaded.status, 201, "小文件上传失败");
    const upBody = await uploaded.json();
    assert.equal(upBody.key, "媒体/sample.bin");
    assert.equal(upBody.size, 1024);

    const download = await api("/api/download?path=" + encodeURIComponent("媒体/sample.bin"));
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("accept-ranges"), "bytes");
    assert.match(download.headers.get("content-disposition"), /attachment/);
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), payload);
  });

  test("同名上传默认自动去重（sample (2).bin）", async () => {
    const response = await api("/api/upload?path=" + encodeURIComponent("媒体"), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-File-Name": "sample.bin" },
      body: "dup",
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).name, "sample (2).bin");
  });

  test("Range 请求返回 206 与正确的 Content-Range（视频拖动/断点续传）", async () => {
    const response = await api("/api/download?path=" + encodeURIComponent("媒体/sample.bin"), {
      headers: { Range: "bytes=100-199" },
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 100-199/1024");
    assert.equal(response.headers.get("content-length"), "100");
    const chunk = new Uint8Array(await response.arrayBuffer());
    assert.equal(chunk.length, 100);
    assert.equal(chunk[0], 100 % 251);
  });

  test("Range 后缀写法 bytes=-16 取尾部", async () => {
    const response = await api("/api/download?path=" + encodeURIComponent("媒体/sample.bin"), {
      headers: { Range: "bytes=-16" },
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 1008-1023/1024");
  });

  test("分块上传：①创建 ②上传块 ③完成，结果按 partNumber 顺序拼接", async () => {
    const target = "媒体/multipart.txt";
    const create = await api("/api/upload?uploads=1&path=" + encodeURIComponent(target), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
    });
    assert.equal(create.status, 201);
    const { uploadId } = await create.json();
    assert.ok(uploadId);

    const parts = [];
    for (const [index, text] of ["AAAA", "BBBB", "CCCC"].entries()) {
      const response = await api(
        `/api/upload?path=${encodeURIComponent(target)}&uploadId=${encodeURIComponent(uploadId)}&partNumber=${index + 1}`,
        { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: text }
      );
      assert.equal(response.status, 200);
      parts.push(await response.json());
    }

    const complete = await api(
      `/api/upload?path=${encodeURIComponent(target)}&uploadId=${encodeURIComponent(uploadId)}`,
      { method: "POST", ...jsonBody({ parts }) }
    );
    assert.equal(complete.status, 200);

    const download = await api("/api/download?path=" + encodeURIComponent(target));
    assert.equal(await download.text(), "AAAABBBBCCCC");
  });

  test("分块上传④放弃（DELETE）后暂存被清理、目标文件不存在", async () => {
    const target = "媒体/aborted.bin";
    const create = await api("/api/upload?uploads=1&path=" + encodeURIComponent(target), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
    });
    const { uploadId } = await create.json();
    const part = await api(
      `/api/upload?path=${encodeURIComponent(target)}&uploadId=${encodeURIComponent(uploadId)}&partNumber=1`,
      { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: "junk" }
    );
    assert.equal(part.status, 200);

    const aborted = await api(
      `/api/upload?path=${encodeURIComponent(target)}&uploadId=${encodeURIComponent(uploadId)}`,
      { method: "DELETE" }
    );
    assert.equal(aborted.status, 204);

    const download = await api("/api/download?path=" + encodeURIComponent(target));
    assert.equal(download.status, 404);
  });

  test("大文件（4 × 5MB，跨多块）分块上传后大小与尾部内容一致", async () => {
    const partSize = 5 * 1024 * 1024;
    const chunks = [];
    for (let index = 0; index < 4; index += 1) chunks.push(Buffer.alloc(partSize, index + 1));
    const totalSize = partSize * chunks.length;

    const target = "媒体/large.bin";
    const create = await api("/api/upload?uploads=1&path=" + encodeURIComponent(target), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
    });
    const { uploadId } = await create.json();

    const parts = [];
    for (const [index, chunk] of chunks.entries()) {
      const response = await api(
        `/api/upload?path=${encodeURIComponent(target)}&uploadId=${encodeURIComponent(uploadId)}&partNumber=${index + 1}`,
        { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: chunk }
      );
      assert.equal(response.status, 200);
      parts.push(await response.json());
    }

    const complete = await api(
      `/api/upload?path=${encodeURIComponent(target)}&uploadId=${encodeURIComponent(uploadId)}`,
      { method: "POST", ...jsonBody({ parts }) }
    );
    assert.equal(complete.status, 200);

    const stat = await (await api("/api/stat?path=" + encodeURIComponent(target))).json();
    assert.equal(stat.size, totalSize);

    // 头部与尾部各取一段：证明拼接顺序正确
    const head = await api("/api/download?path=" + encodeURIComponent(target), {
      headers: { Range: `bytes=0-15` },
    });
    assert.ok(new Uint8Array(await head.arrayBuffer()).every((value) => value === 1));

    const tail = await api("/api/download?path=" + encodeURIComponent(target), {
      headers: { Range: `bytes=${totalSize - 1024}-${totalSize - 1}` },
    });
    assert.equal(tail.status, 206);
    const bytes = new Uint8Array(await tail.arrayBuffer());
    assert.equal(bytes.length, 1024);
    assert.ok(bytes.every((value) => value === 4));
  });

  test("落盘的是真实文件（飞牛文件管理器 / SMB 能直接看到，无附加元数据文件）", async () => {
    assert.equal(await readFile(path.join(dataDir, "媒体", "multipart.txt"), "utf8"), "AAAABBBBCCCC");
    const entries = await (await import("node:fs/promises")).readdir(path.join(dataDir, "媒体"));
    assert.ok(entries.includes("multipart.txt"));
    // 元数据不落在数据目录里，SMB 用户看不到 .m.json / 临时文件
    assert.ok(
      entries.every((name) => !name.endsWith(".m.json") && !name.startsWith(".davflaretmp")),
      `数据目录里出现了内部文件：${JSON.stringify(entries)}`
    );
  });
});

// ────────────────────────── 分享 ──────────────────────────

describe("分享链接（提取码 / 目录 zip / Range 直链）", () => {
  let token;
  const EXTRACT = "ab12";

  test("创建带提取码的分享返回 token", async () => {
    const response = await api("/api/shares", {
      method: "POST",
      ...jsonBody({ key: "媒体/sample.bin", expiresInHours: 24 * 7, extractCode: EXTRACT }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    token = body.token;
    assert.ok(token, `没有拿到分享 token：${JSON.stringify(body)}`);
    assert.equal(body.hasExtractCode, true);
    assert.equal(body.extractCode, EXTRACT);
    assert.equal(body.isDir, false);
  });

  test("分享落地页匿名可见（HTML）", async () => {
    const page = await fetch(`${drive.origin}/share/${token}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
  });

  test("带提取码：匿名 raw 直连只拿到提取表单，拿到文件字节要带 code", async () => {
    const denied = await fetch(`${drive.origin}/share/${token}?raw=1`);
    assert.equal(denied.status, 200);
    assert.match(denied.headers.get("content-type"), /text\/html/);
    const deniedText = await denied.text();
    assert.match(deniedText, /提取码|Extract code/, "应当返回提取表单而不是文件内容");

    const full = await fetch(`${drive.origin}/share/${token}?raw=1&code=${EXTRACT}`);
    assert.equal(full.status, 200);
    assert.equal((await full.arrayBuffer()).byteLength, 1024);

    const ranged = await fetch(`${drive.origin}/share/${token}?raw=1&code=${EXTRACT}`, {
      headers: { Range: "bytes=0-9" },
    });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-range"), "bytes 0-9/1024");
    assert.equal((await ranged.arrayBuffer()).byteLength, 10);
  });

  test("提取码错误时返回 403 且不放行文件", async () => {
    const response = await fetch(`${drive.origin}/share/${token}?raw=1&code=zzzz`);
    assert.equal(response.status, 403);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const text = await response.text();
    assert.ok(text.length !== 1024, "不该返回原始文件字节");
    assert.match(text, /不正确|Incorrect/);
  });

  test("表单提交正确提取码后种下 cookie，后续直链免 code", async () => {
    // 必须 redirect: "manual"：303 会被 fetch 自动跟随成一次 GET，
    // 那样拿到的就是落地页的 200，看不到 303 与 Set-Cookie
    const form = await fetch(`${drive.origin}/share/${token}`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: EXTRACT }).toString(),
    });
    assert.equal(form.status, 303);
    const cookie = (form.headers.getSetCookie?.() ?? []).join(";") || form.headers.get("set-cookie");
    assert.match(String(cookie), /fd_share_code=/);

    const viaCookie = await fetch(`${drive.origin}/share/${token}?raw=1`, {
      headers: { Cookie: String(cookie).split(";")[0] },
    });
    assert.equal(viaCookie.status, 200);
    assert.equal((await viaCookie.arrayBuffer()).byteLength, 1024);
  });

  test("目录分享给 zip 流", async () => {
    const created = await api("/api/shares", {
      method: "POST",
      ...jsonBody({ key: "媒体" }),
    });
    assert.equal(created.status, 200);
    const dirToken = (await created.json()).token;

    const zip = await fetch(`${drive.origin}/share/${dirToken}?download=1`);
    assert.equal(zip.status, 200);
    assert.match(zip.headers.get("content-type"), /application\/zip/);
    const bytes = new Uint8Array(await zip.arrayBuffer());
    assert.equal(bytes[0], 0x50);
    assert.equal(bytes[1], 0x4b); // "PK"
  });

  test("分享列表能列出刚建的分享，并支持撤销", async () => {
    const list = await api("/api/shares");
    assert.equal(list.status, 200);
    const shares = await list.json();
    assert.match(JSON.stringify(shares), new RegExp(token));

    const removed = await api("/api/shares?token=" + encodeURIComponent(token), {
      method: "DELETE",
    });
    assert.equal(removed.status, 204);
    const gone = await fetch(`${drive.origin}/share/${token}`);
    assert.equal(gone.status, 404);
  });
});

// ────────────────────────── 回收站 ──────────────────────────

describe("回收站", () => {
  let trashKey;

  test("软删除进回收站（/api/delete?soft=1）并在列表可见", async () => {
    const removed = await api(
      "/api/delete?soft=1&path=" + encodeURIComponent("媒体/copied.txt"),
      { method: "DELETE" }
    );
    assert.equal(removed.status, 200);
    const body = await removed.json();
    assert.equal(body.soft, true);
    trashKey = body.trashKey;
    assert.ok(trashKey);

    // 原位置已经没有了
    await assert.rejects(() => readFile(path.join(dataDir, "媒体", "copied.txt")));

    const trash = await api("/api/trash");
    assert.equal(trash.status, 200);
    const items = await trash.json();
    assert.ok(Array.isArray(items));
    const target = items.find((item) => item.trashKey === trashKey);
    assert.ok(target, `回收站里没有该条目：${JSON.stringify(items)}`);
    assert.equal(target.originalKey, "媒体/copied.txt");
  });

  test("还原（POST /api/trash?action=restore）后文件回到原位", async () => {
    const restored = await api("/api/trash?action=restore", {
      method: "POST",
      ...jsonBody({ trashKeys: [trashKey] }),
    });
    assert.equal(restored.status, 200);
    const results = await restored.json();
    assert.equal(results[0].status, "restored");
    assert.equal(await readFile(path.join(dataDir, "媒体", "copied.txt"), "utf8"), "hello e2e");
  });

  test("彻底删除（DELETE /api/trash）后磁盘上也没了", async () => {
    const removed = await api(
      "/api/delete?soft=1&path=" + encodeURIComponent("媒体/copied.txt"),
      { method: "DELETE" }
    );
    const { trashKey: second } = await removed.json();

    const purged = await api("/api/trash", {
      method: "DELETE",
      ...jsonBody({ trashKeys: [second] }),
    });
    assert.equal(purged.status, 204);
    await assert.rejects(() => readFile(path.join(dataDir, "媒体", "copied.txt")));
  });

  test("目录软删 + 还原（含虚拟目录补 marker）", async () => {
    const removed = await api(
      "/api/delete?soft=1&path=" + encodeURIComponent("已搬"),
      { method: "DELETE" }
    );
    assert.equal(removed.status, 200);
    const { trashKey: dirTrash } = await removed.json();

    const restored = await api("/api/trash?action=restore", {
      method: "POST",
      ...jsonBody({ trashKeys: [dirTrash] }),
    });
    assert.equal(restored.status, 200);
    assert.equal(await readFile(path.join(dataDir, "已搬", "里面", "x.txt"), "utf8"), "moved");
  });

  test("硬删除（不带 soft）不进回收站", async () => {
    await writeFile(path.join(dataDir, "媒体", "hard.txt"), "bye");
    const response = await api(
      "/api/delete?path=" + encodeURIComponent("媒体/hard.txt"),
      { method: "DELETE" }
    );
    assert.equal(response.status, 200);
    await assert.rejects(() => readFile(path.join(dataDir, "媒体", "hard.txt")));
    const items = await (await api("/api/trash")).json();
    assert.ok(!JSON.stringify(items).includes("hard.txt"));
  });
});

// ────────────────────────── WebDAV ──────────────────────────

describe("WebDAV（挂成网络驱动器）", () => {
  const dav = (pathname, init = {}) => {
    const headers = new Headers(init.headers ?? {});
    headers.set("Authorization", basicHeader);
    return fetch(`${drive.origin}${pathname}`, { ...init, headers });
  };

  test("OPTIONS 声明支持的方法", async () => {
    const response = await dav("/webdav/", { method: "OPTIONS" });
    assert.equal(response.status, 200);
    const allow = response.headers.get("allow") ?? "";
    for (const method of ["PROPFIND", "PROPPATCH", "MKCOL", "PUT", "DELETE", "MOVE", "COPY"]) {
      assert.match(allow, new RegExp(method), `Allow 里缺少 ${method}`);
    }
  });

  test("MKCOL 建集合 + PROPFIND 列目录 + PUT/GET 读写", async () => {
    const mkcol = await dav("/webdav/dav-folder/", { method: "MKCOL" });
    assert.ok(mkcol.status < 300, `MKCOL 失败 ${mkcol.status}`);

    const put = await dav("/webdav/dav-folder/hello.txt", {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "via webdav",
    });
    assert.ok(put.status < 300, `PUT 失败 ${put.status}`);

    const get = await dav("/webdav/dav-folder/hello.txt");
    assert.equal(get.status, 200);
    assert.equal(await get.text(), "via webdav");

    const propfind = await dav("/webdav/dav-folder/", {
      method: "PROPFIND",
      headers: { Depth: "1" },
    });
    assert.equal(propfind.status, 207);
    const xml = await propfind.text();
    assert.match(xml, /multistatus/i);
    assert.match(xml, /hello\.txt/);
  });

  test("PROPFIND 对集合返回 collection 类型（依赖目录标记语义）", async () => {
    const propfind = await dav("/webdav/dav-folder/", {
      method: "PROPFIND",
      headers: { Depth: "0" },
    });
    const xml = await propfind.text();
    assert.match(xml, /collection/);
  });

  test("MOVE 改名 + COPY 复制 + DELETE 删除", async () => {
    const moved = await dav("/webdav/dav-folder/hello.txt", {
      method: "MOVE",
      headers: { Destination: `${drive.origin}/webdav/dav-folder/moved.txt` },
    });
    assert.ok(moved.status < 300, `MOVE 失败 ${moved.status} ${await moved.text()}`);

    const copied = await dav("/webdav/dav-folder/moved.txt", {
      method: "COPY",
      headers: { Destination: `${drive.origin}/webdav/dav-folder/copied.txt` },
    });
    assert.ok(copied.status < 300, `COPY 失败 ${copied.status}`);

    const removed = await dav("/webdav/dav-folder/copied.txt", { method: "DELETE" });
    assert.ok(removed.status < 300, `DELETE 失败 ${removed.status}`);

    assert.equal(await readFile(path.join(dataDir, "dav-folder", "moved.txt"), "utf8"), "via webdav");
  });

  test("WebDAV 的 Range 请求走 206（视频拖动）", async () => {
    const response = await dav("/webdav/媒体/sample.bin", {
      headers: { Range: "bytes=0-9" },
    });
    assert.equal(response.status, 206);
    assert.equal((await response.arrayBuffer()).byteLength, 10);
  });

  test("PROPPATCH / LOCK / UNLOCK（Class 2 锁，Windows 资源管理器会用到）", async () => {
    const proppatch = await dav("/webdav/dav-folder/", {
      method: "PROPPATCH",
      headers: { "Content-Type": "application/xml" },
      body:
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop>' +
        "<D:displayname>测试目录</D:displayname>" +
        "</D:prop></D:set></D:propertyupdate>",
    });
    assert.equal(proppatch.status, 207, "PROPPATCH 应返回 multistatus");

    const lock = await dav("/webdav/dav-folder/moved.txt", {
      method: "LOCK",
      headers: { "Content-Type": "application/xml", "Timeout": "Second-3600" },
      body:
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>' +
        "<D:locktype><D:write/></D:locktype>" +
        "<D:owner><D:href>e2e</D:href></D:owner></D:lockinfo>",
    });
    assert.equal(lock.status, 201, "LOCK 新建锁应返回 201 Created");
    const lockToken = lock.headers.get("lock-token") ?? "";
    assert.match(lockToken, /^</, "应返回 Lock-Token 头");
    assert.match(await lock.text(), /lockdiscovery/);

    const unlocked = await dav("/webdav/dav-folder/moved.txt", {
      method: "UNLOCK",
      headers: { "Lock-Token": lockToken },
    });
    assert.ok(unlocked.status === 204 || unlocked.status === 200, `UNLOCK 失败 ${unlocked.status}`);
  });

  test("错误的 Basic 凭据被拒绝", async () => {
    const response = await fetch(`${drive.origin}/webdav/dav-folder/moved.txt`, {
      headers: { Authorization: "Basic " + Buffer.from("bad:bad").toString("base64") },
    });
    assert.ok(response.status >= 400, `不应该放行：${response.status}`);
  });
});

// ────────────────────────── 匿名 WebDAV 目录 ──────────────────────────

describe("匿名只读 WebDAV 目录（WEBDAV_PUBLIC_DIR / WEBDAV_PUBLIC_DIR_ON，飞牛适配）", () => {
  let pub; // 配了目录名、开关缺省 → 启用（向后兼容老配置）
  let off; // 配了目录名、开关 = 0 → 匿名访问整体失效
  let offWord; // 开关写成 off（词形）同样算关闭
  const basic = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");

  before(async () => {
    pub = await startServer({ WEBDAV_PUBLIC_DIR: "public" });
    off = await startServer({ WEBDAV_PUBLIC_DIR: "public", WEBDAV_PUBLIC_DIR_ON: "0" });
    offWord = await startServer({ WEBDAV_PUBLIC_DIR: "public", WEBDAV_PUBLIC_DIR_ON: "off" });
  });

  after(() => {
    pub?.child.kill("SIGKILL");
    off?.child.kill("SIGKILL");
    offWord?.child.kill("SIGKILL");
  });

  test("未配置时匿名访问一律 401（fail closed 不受影响）", async () => {
    const response = await fetch(`${drive.origin}/webdav/媒体/sample.bin`);
    assert.equal(response.status, 401);
  });

  test("配置后：匿名 GET 目录页 / PROPFIND / GET 文件在该目录内放行", async () => {
    // 准备目录与文件（带凭据走主实例，数据目录共享）
    await api("/api/mkdir", { method: "POST", ...jsonBody({ path: "public" }) });
    await writeFile(path.join(dataDir, "public", "share.txt"), "anon hello");

    const page = await fetch(`${pub.origin}/webdav/public/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /share\.txt/);

    const propfind = await fetch(`${pub.origin}/webdav/public/`, {
      method: "PROPFIND",
      headers: { Depth: "1" },
    });
    assert.equal(propfind.status, 207);
    assert.match(await propfind.text(), /share\.txt/);

    const file = await fetch(`${pub.origin}/webdav/public/share.txt`);
    assert.equal(file.status, 200);
    assert.equal(await file.text(), "anon hello");
  });

  test("配置后：目录外匿名仍 401，目录内写入仍要求凭据", async () => {
    const outside = await fetch(`${pub.origin}/webdav/媒体/sample.bin`);
    assert.equal(outside.status, 401);

    const root = await fetch(`${pub.origin}/webdav/`);
    assert.equal(root.status, 401);

    const put = await fetch(`${pub.origin}/webdav/public/injected.txt`, {
      method: "PUT",
      body: "nope",
    });
    assert.equal(put.status, 401);

    const del = await fetch(`${pub.origin}/webdav/public/share.txt`, { method: "DELETE" });
    assert.equal(del.status, 401);

    const mkcol = await fetch(`${pub.origin}/webdav/public/sub/`, { method: "MKCOL" });
    assert.equal(mkcol.status, 401);
  });

  test("路径穿越变体拿不到目录外内容", async () => {
    // %2e%2e 解码后是 "public/../媒体"，path 不再以 public/ 开头 → 401
    const dotdot = await fetch(`${pub.origin}/webdav/public/%2e%2e/%e5%aa%92%e4%bd%93/sample.bin`);
    assert.notEqual(dotdot.status, 200);
  });

  test("开关关闭后：目录与文件仍在，但匿名访问全部失效", async () => {
    // 先确认目标文件确实存在（pub 实例匿名可读），排除「文件不存在导致 401」的假阳性
    const alive = await fetch(`${pub.origin}/webdav/public/share.txt`);
    assert.equal(alive.status, 200, "前置条件：pub 实例应能匿名读到该文件");

    // 目录页 / PROPFIND / 读文件：三条匿名路径全部要凭据
    const page = await fetch(`${off.origin}/webdav/public/`);
    assert.equal(page.status, 401, "开关关闭后目录页不应匿名可读");
    const propfind = await fetch(`${off.origin}/webdav/public/`, {
      method: "PROPFIND",
      headers: { Depth: "1" },
    });
    assert.equal(propfind.status, 401, "开关关闭后 PROPFIND 不应匿名可行");
    const file = await fetch(`${off.origin}/webdav/public/share.txt`);
    assert.equal(file.status, 401, "开关关闭后文件不应匿名可读");

    // 关掉的是「匿名」，不是整个 WebDAV：带凭据照常可用
    const authed = await fetch(`${off.origin}/webdav/public/share.txt`, {
      headers: { Authorization: basic },
    });
    assert.equal(authed.status, 200, "带凭据应仍可访问");
    assert.equal(await authed.text(), "anon hello");
  });

  test("开关写成词形 off 同样算关闭", async () => {
    const file = await fetch(`${offWord.origin}/webdav/public/share.txt`);
    assert.equal(file.status, 401);
  });
});

// ────────────────────────── 品牌种子化（安装向导） ──────────────────────────

describe("品牌种子化（BRAND_NAME / BRAND_LOGO_PATH，飞牛适配）", () => {
  const SEED_PNG =
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001";
  let brandSrv;
  let brandDataDir;

  before(async () => {
    brandDataDir = path.join(base, "data-brand");
    await mkdir(brandDataDir, { recursive: true });
    const logo = path.join(base, "seed-logo.png");
    await writeFile(logo, Buffer.from(SEED_PNG, "hex"));
    brandSrv = await startServer({
      DAVFLARE_DATA_DIR: brandDataDir,
      BRAND_NAME: "家庭云盘",
      BRAND_LOGO_PATH: logo,
    });
  });

  after(() => {
    brandSrv?.child.kill("SIGKILL");
  });

  test("首次启动写入品牌配置，/api/branding 公开可读", async () => {
    const info = await fetch(`${brandSrv.origin}/api/branding`);
    assert.equal(info.status, 200);
    const body = await info.json();
    assert.equal(body.name, "家庭云盘");
    assert.equal(body.hasCustomLogo, true);
  });

  test("导入的 logo 通过 /api/branding/logo 公开可读", async () => {
    const logo = await fetch(`${brandSrv.origin}/api/branding/logo`);
    assert.equal(logo.status, 200);
    assert.match(logo.headers.get("content-type"), /image\/png/);
  });

  test("重启不覆盖：已有品牌配置时向导值被忽略", async () => {
    brandSrv.child.kill("SIGKILL");
    const second = await startServer({
      DAVFLARE_DATA_DIR: brandDataDir,
      BRAND_NAME: "另一个名字",
    });
    try {
      const info = await fetch(`${second.origin}/api/branding`);
      assert.equal(info.status, 200);
      const body = await info.json();
      assert.equal(body.name, "家庭云盘");
      assert.equal(body.hasCustomLogo, true);
    } finally {
      second.child.kill("SIGKILL");
    }
  });
});

// ────────────────────────── MCP ──────────────────────────

describe("MCP 端点", () => {
  // MCP 是给脚本/AI 客户端用的端点，上游用 authorizeApiKey —— 只认密钥，不认 Basic 会话
  const rpc = (payload) =>
    fetch(`${drive.origin}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...payload }),
    });

  test("initialize 返回协议版本与服务信息", async () => {
    const response = await rpc({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "e2e", version: "1" },
      },
    });
    assert.equal(response.status, 200, "MCP initialize 失败");
    const text = await response.text();
    assert.match(text, /protocolVersion|serverInfo/);
  });

  test("tools/list 能列出工具（功能未删减的证据）", async () => {
    const response = await rpc({ id: 2, method: "tools/list", params: {} });
    assert.ok(response.status < 300, `tools/list 失败 ${response.status}`);
    const text = await response.text();
    assert.match(text, /"tools"/);
    // 逐个核对上游 _mcpTools.ts 注册的全部 25 个工具，一个都不能少
    const expected = [
      "list", "stat", "download", "upload", "mkdir", "copy", "move", "delete",
      "search", "zip", "share_create", "share_list", "share_revoke",
      "trash_list", "trash_restore", "trash_empty",
      "image_list", "image_upload", "image_delete",
      "sites_list", "sites_config", "sites_delete", "publish_site",
      "push", "pull",
    ];
    for (const name of expected) {
      assert.match(text, new RegExp(`"${name}"`), `MCP 缺少工具 ${name}`);
    }
  });
});

// ────────────────────────── 配置与功能开关 ──────────────────────────

describe("配置与功能开关", () => {
  test("GET /api/config 返回账号信息与各功能开关，PATCH 能改并持久化", async () => {
    const read = await session("/api/config");
    assert.equal(read.status, 200);
    const config = await read.json();
    assert.equal(config.username, USER);
    for (const flag of ["webdav", "mcp", "apiKey", "sites", "imageHost"]) {
      assert.equal(typeof config[flag], "boolean", `缺少开关 ${flag}`);
    }

    const patched = await session("/api/config", {
      method: "PATCH",
      ...jsonBody({ imageHost: false }),
    });
    assert.equal(patched.status, 200);
    assert.equal((await patched.json()).imageHost, false);

    assert.equal((await (await session("/api/config")).json()).imageHost, false);

    await session("/api/config", { method: "PATCH", ...jsonBody({ imageHost: true }) });
  });

  test("API 密钥不能改功能开关（403）", async () => {
    const response = await keyed("/api/config", { method: "PATCH", ...jsonBody({ mcp: false }) });
    assert.equal(response.status, 403);
  });

  test("关掉 webdav 开关后 /webdav 变 404，恢复后可用（gateDriveProductRoute 生效）", async () => {
    await session("/api/config", { method: "PATCH", ...jsonBody({ webdav: false }) });
    const blocked = await fetch(`${drive.origin}/webdav/`, {
      method: "OPTIONS",
      headers: { Authorization: basicHeader },
    });
    assert.equal(blocked.status, 404);

    await session("/api/config", { method: "PATCH", ...jsonBody({ webdav: true }) });
    const back = await fetch(`${drive.origin}/webdav/`, {
      method: "OPTIONS",
      headers: { Authorization: basicHeader },
    });
    assert.equal(back.status, 200);
  });

  test("关掉 apiKey 开关后受保护端点拒绝密钥", async () => {
    await session("/api/config", { method: "PATCH", ...jsonBody({ apiKey: false }) });
    const denied = await keyed("/api/list?path=");
    assert.equal(denied.status, 401);

    await session("/api/config", { method: "PATCH", ...jsonBody({ apiKey: true }) });
    assert.equal((await keyed("/api/list?path=")).status, 200);
  });
});

// ────────────────────────── API 密钥 ──────────────────────────

describe("API 密钥（CLI / 扩展依赖这条路）", () => {
  let createdId;
  let createdKey;

  test("创建密钥返回明文与元信息", async () => {
    const created = await session("/api/keys", {
      method: "POST",
      ...jsonBody({ name: "e2e-key" }),
    });
    assert.equal(created.status, 200);
    const body = await created.json();
    createdKey = body.key;
    createdId = body.id;
    assert.ok(createdKey);
    assert.ok(body.prefix);
    assert.equal(body.createdBy, USER);
  });

  test("GET /api/keys 列出密钥但不泄露明文", async () => {
    const listed = await session("/api/keys");
    assert.equal(listed.status, 200);
    const keys = await listed.json();
    assert.ok(keys.some((entry) => entry.id === createdId));
    assert.ok(!JSON.stringify(keys).includes(createdKey), "列表不该包含明文密钥");
  });

  test("用密钥可以访问「只认密钥」的端点（Basic 不行，形成对照）", async () => {
    const viaKey = await fetch(`${drive.origin}/api/list?path=`, {
      headers: { "X-Api-Key": createdKey },
    });
    assert.equal(viaKey.status, 200);

    const viaBearer = await fetch(`${drive.origin}/api/list?path=`, {
      headers: { Authorization: `Bearer ${createdKey}` },
    });
    assert.equal(viaBearer.status, 200);

    // Basic 会话不能用于只认密钥的端点——这是上游的既定契约
    const viaBasic = await fetch(`${drive.origin}/api/list?path=`, {
      headers: { Authorization: basicHeader },
    });
    assert.equal(viaBasic.status, 401);
  });

  test("删除密钥后该密钥立即失效", async () => {
    const removed = await session(`/api/keys?id=${encodeURIComponent(createdId)}`, {
      method: "DELETE",
    });
    assert.equal(removed.status, 204);

    const denied = await fetch(`${drive.origin}/api/list?path=`, {
      headers: { "X-Api-Key": createdKey },
    });
    assert.equal(denied.status, 401);
  });
});

// ────────────────────────── 静态站与图床 ──────────────────────────

describe("静态站（sites）与图床（imageHost）", () => {
  test("把网盘目录发布成静态站（source 语义），产物落在 sites/{slug}/ 下", async () => {
    await api("/api/mkdir", { method: "POST", ...jsonBody({ path: "站点源" }) });
    await writeFile(path.join(dataDir, "站点源", "index.html"), "<h1>hello site</h1>");
    await mkdir(path.join(dataDir, "站点源", "assets"), { recursive: true });
    await writeFile(path.join(dataDir, "站点源", "assets", "app.js"), "console.log(1)");

    const publish = await api("/api/sites", {
      method: "POST",
      ...jsonBody({ slug: "e2e-site", source: "站点源" }),
    });
    assert.ok(publish.status < 300, `发布失败：${publish.status}`);
    const body = await publish.json();
    assert.equal(body.slug, "e2e-site");
    assert.equal(body.copied, 2);

    assert.equal(
      await readFile(path.join(dataDir, "sites", "e2e-site", "index.html"), "utf8"),
      "<h1>hello site</h1>"
    );
  });

  test("站点主机上 /{slug}/ 能读到站点首页（对接飞牛「静态分享」效果）", async () => {
    const response = await fetch(`${sites.origin}/e2e-site/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /hello site/);
  });

  test("站点主机上 /{slug} 不带尾斜杠会 301 到 /{slug}/（相对链接不跑偏）", async () => {
    const response = await fetch(`${sites.origin}/e2e-site`, { redirect: "manual" });
    assert.equal(response.status, 301);
    assert.match(response.headers.get("location"), /\/e2e-site\/$/);
  });

  test("站点里的子资源可访问，不存在的路径 404", async () => {
    const asset = await fetch(`${sites.origin}/e2e-site/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.match(await asset.text(), /console\.log/);

    const missing = await fetch(`${sites.origin}/e2e-site/nope.txt`);
    assert.equal(missing.status, 404);
  });

  test("站点主机只接受 GET/HEAD（其他方法 405）", async () => {
    const response = await fetch(`${sites.origin}/e2e-site/`, { method: "POST" });
    assert.equal(response.status, 405);
  });

  test("飞牛适配：未配置 SITES_HOST 的主机上 /{slug}/ 同样无需登录可读（IP 访问场景）", async () => {
    const response = await fetch(`${drive.origin}/e2e-site/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /hello site/);
  });

  test("飞牛适配：/{slug} 不带尾斜杠在任意主机也 301 到 /{slug}/", async () => {
    const response = await fetch(`${drive.origin}/e2e-site`, { redirect: "manual" });
    assert.equal(response.status, 301);
    assert.match(response.headers.get("location"), /\/e2e-site\/$/);
  });

  test("飞牛适配：任意主机可读站点子资源；未发布的 slug 仍回退 SPA", async () => {
    const asset = await fetch(`${drive.origin}/e2e-site/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.match(await asset.text(), /console\.log/);

    const notSite = await fetch(`${drive.origin}/no-such-published-slug/`);
    assert.equal(notSite.status, 200);
    assert.match(await notSite.text(), /Davflare/);
  });

  test("站点列表接口可用", async () => {
    const response = await api("/api/sites");
    assert.equal(response.status, 200);
  });

  test("图床上传后能在站点主机 /i/{id} 读到（24 位以上短链）", async () => {
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001",
      "hex"
    );
    const uploaded = await api("/api/images", {
      method: "POST",
      headers: { "Content-Type": "image/png", "X-File-Name": "pic.png" },
      body: png,
    });
    assert.equal(uploaded.status, 201, "图床上传失败");
    const body = await uploaded.json();
    assert.match(body.id, /^[a-f0-9]{32}$/);
    assert.equal(body.size, png.byteLength);
    assert.equal(body.contentType, "image/png");
    // 飞牛适配：直链按**实际访问地址**拼 —— 自托管只有一个地址，不必配 SITES_HOST
    assert.equal(body.url, `${drive.origin}/i/${body.id}`);
    assert.equal(body.markdown, `![](${drive.origin}/i/${body.id})`);

    const served = await fetch(`${sites.origin}/i/${body.id}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");

    const listed = await api("/api/images");
    assert.equal(listed.status, 200);
    assert.match(JSON.stringify(await listed.json()), new RegExp(body.id));

    const removed = await api(`/api/images?id=${body.id}`, { method: "DELETE" });
    assert.ok(removed.status < 300);
  });

  test("飞牛适配：图床图片在任意主机（IP 访问）也能直接打开；非图床路径仍回退 SPA", async () => {
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001",
      "hex"
    );
    const uploaded = await api("/api/images", {
      method: "POST",
      headers: { "Content-Type": "image/png", "X-File-Name": "any-host.png" },
      body: png,
    });
    assert.equal(uploaded.status, 201, "图床上传失败");
    const body = await uploaded.json();

    // 站点主机：上游语义（SITES_HOST 主机上服务图床）
    const viaSites = await fetch(`${sites.origin}/i/${body.id}`);
    assert.equal(viaSites.status, 200);

    // 驱动主机（NAS 上唯一地址）：无需登录也能读到图片本体
    const viaDrive = await fetch(`${drive.origin}/i/${body.id}`);
    assert.equal(viaDrive.status, 200, "任意主机应能读到图床图片");
    assert.equal(viaDrive.headers.get("content-type"), "image/png");

    // 合法 id 但对象不存在 → 404，不会落回 SPA 变成 200 HTML
    const missing = await fetch(`${drive.origin}/i/${"f".repeat(32)}`);
    assert.equal(missing.status, 404);

    // 非 /i/{id} 的普通路径不受影响，仍然回退到网盘 SPA
    const spa = await fetch(`${drive.origin}/some/deep/path`);
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), /Davflare/);

    await api(`/api/images?id=${body.id}`, { method: "DELETE" });
  });
});

// ────────────────────────── 打包下载与备份 ──────────────────────────

describe("打包下载（archive）与冲突备份（backup）", () => {
  test("GET /api/archive?path=<目录> 返回 zip 流", async () => {
    const response = await api("/api/archive?path=" + encodeURIComponent("媒体"));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/zip/);
    assert.match(response.headers.get("content-disposition"), /\.zip/);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(bytes[0], 0x50);
    assert.equal(bytes[1], 0x4b);
  });

  test("POST /api/archive 按 keys + base 打包，并拒绝内部目录", async () => {
    const ok = await api("/api/archive", {
      method: "POST",
      ...jsonBody({ keys: ["媒体/renamed.txt", "媒体/sample.bin"], base: "媒体" }),
    });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("content-type"), /application\/zip/);

    const denied = await api("/api/archive", {
      method: "POST",
      ...jsonBody({ keys: ["_$flaredrive$/config.json"] }),
    });
    assert.equal(denied.status, 400);
  });

  test("backup 把文件改名成 .conflict-<时间戳>，原文件不再存在", async () => {
    await writeFile(path.join(dataDir, "媒体", "conflict-me.txt"), "keep me");
    const response = await api("/api/backup", {
      method: "POST",
      ...jsonBody({ path: "媒体/conflict-me.txt" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.match(body.to, /conflict-me\.conflict-\d{8}T\d{6}\.txt$/);
    assert.equal(await readFile(path.join(dataDir, "媒体", body.to.split("/").pop()), "utf8"), "keep me");
    await assert.rejects(() => readFile(path.join(dataDir, "媒体", "conflict-me.txt")));
  });
});

// ────────────────────────── 文件收集链接 ──────────────────────────

describe("文件收集链接（collect，让别人往你目录里交文件）", () => {
  let token;

  test("创建收集链接返回 token 与上传地址", async () => {
    const response = await api("/api/collects", {
      method: "POST",
      ...jsonBody({ folder: "媒体", note: "请交作业", expiresInHours: 48 }),
    });
    assert.equal(response.status, 201, "创建收集链接失败");
    const body = await response.json();
    token = body.token;
    assert.ok(token, `没有拿到 token：${JSON.stringify(body)}`);
    assert.match(body.url ?? "", /\/collect\//);
  });

  test("收集页匿名可访问（HTML），列表接口能看到它", async () => {
    const page = await fetch(`${drive.origin}/collect/${token}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);

    const list = await api("/api/collects");
    assert.equal(list.status, 200);
    assert.match(JSON.stringify(await list.json()), new RegExp(token));
  });

  test("匿名访客走四步协议上传文件，落到指定目录", async () => {
    // 收集链接是匿名端点，协议与网盘的分块上传一致：
    //   POST create → PUT part → POST complete（分块上限 10 MiB）
    const payload = "collected!";
    const create = await fetch(`${drive.origin}/collect/${token}/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "提交.txt", size: Buffer.byteLength(payload), type: "text/plain" }),
    });
    assert.ok(create.status < 300, `create 失败 ${create.status}`);
    const { uploadId, partSize, partCount } = await create.json();
    assert.ok(uploadId);
    assert.equal(partSize, 10 * 1024 * 1024);
    assert.equal(partCount, 1);

    const part = await fetch(
      `${drive.origin}/collect/${token}/part?uploadId=${encodeURIComponent(uploadId)}&partNumber=1`,
      { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: payload }
    );
    assert.ok(part.status < 300, `part 失败 ${part.status}`);
    const partBody = await part.json();

    const complete = await fetch(`${drive.origin}/collect/${token}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadId, parts: [{ partNumber: 1, etag: partBody.etag }] }),
    });
    assert.ok(complete.status < 300, `complete 失败 ${complete.status} ${await complete.text()}`);

    assert.equal(await readFile(path.join(dataDir, "媒体", "提交.txt"), "utf8"), payload);
  });

  test("收集链接的坏令牌直接 404，且不接受未声明的方法", async () => {
    const missing = await fetch(`${drive.origin}/collect/deadbeefdeadbeefdeadbeefdeadbeef`);
    assert.equal(missing.status, 404);

    const wrongMethod = await fetch(`${drive.origin}/collect/${token}`, { method: "PUT" });
    assert.equal(wrongMethod.status, 405);
  });

  test("停用并删除收集链接", async () => {
    const patched = await api(`/api/collects?token=${token}`, {
      method: "PATCH",
      ...jsonBody({ disabled: true }),
    });
    assert.ok(patched.status < 300, `停用失败 ${patched.status}`);

    const removed = await api(`/api/collects?token=${token}`, { method: "DELETE" });
    assert.ok(removed.status < 300, `删除失败 ${removed.status}`);
    const list = await api("/api/collects");
    assert.ok(!JSON.stringify(await list.json()).includes(token));
  });
});

// ────────────────────────── 环境自检 ──────────────────────────

describe("环境自检（/api/setup，安装向导与排障用）", () => {
  test("GET /api/setup 返回检查结果清单", async () => {
    const response = await session("/api/setup");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body && typeof body === "object");
    assert.match(JSON.stringify(body), /ok|checks|bucket|write|read/i);
  });

  test("自检不接受密钥（只给网页会话）", async () => {
    const response = await keyed("/api/setup");
    assert.equal(response.status, 401);
  });
});

// ────────────────────────── 认证边界 ──────────────────────────

describe("认证边界", () => {
  test("无凭据访问受保护 API 返回 401", async () => {
    const response = await fetch(`${drive.origin}/api/list?path=`);
    assert.equal(response.status, 401);
  });

  test("密钥开关关闭时无凭据也拿不到数据", async () => {
    const response = await fetch(`${drive.origin}/api/download?path=` + encodeURIComponent("媒体/sample.bin"));
    assert.ok(response.status === 401 || response.status === 403, `不该放行：${response.status}`);
  });

  test("WebDAV 在无凭据时返回 401", async () => {
    const response = await fetch(`${drive.origin}/webdav/`, { method: "OPTIONS" });
    assert.ok(response.status === 401 || response.status === 207 || response.status === 200);
    const propfind = await fetch(`${drive.origin}/webdav/`, { method: "PROPFIND", headers: { Depth: "1" } });
    assert.equal(propfind.status, 401);
  });
});

// ────────────────────────── 飞牛部署相关 ──────────────────────────

describe("飞牛（fnOS）部署相关行为", () => {
  test("/healthz 探活端点可用（给 cmd/main 的 status 用）", async () => {
    const response = await fetch(`${drive.origin}/healthz`);
    assert.equal(response.status, 200);
  });

  test("中文与 emoji 文件名全链路可用（浏览器走 multipart 上传路径）", async () => {
    const name = "测试 文件🎉.txt";
    // 浏览器真实上传走 multipart/form-data：文件名在 body 里，UTF-8 不受 HTTP 头
    // 只能放 Latin-1 的限制（X-File-Name 头放中文会被 fetch 直接拒绝）
    const form = new FormData();
    form.append("file", new File(["unicode ok"], name, { type: "text/plain; charset=utf-8" }));
    const uploaded = await api("/api/upload?path=" + encodeURIComponent("媒体"), {
      method: "POST",
      body: form,
    });
    assert.equal(uploaded.status, 201, "中文文件名上传失败");
    assert.equal((await uploaded.json()).name, name);

    const download = await api("/api/download?path=" + encodeURIComponent(`媒体/${name}`));
    assert.equal(download.status, 200);
    assert.equal(await download.text(), "unicode ok");

    // 磁盘上就是原名，飞牛文件管理器里看到的一样
    assert.equal(await readFile(path.join(dataDir, "媒体", name), "utf8"), "unicode ok");
  });
});
