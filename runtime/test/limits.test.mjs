/**
 * 平台适配回归测试：单次请求体上限。
 *
 * 上游把「Cloudflare Pages Functions 单次请求体约 100MB」这个平台限制
 * 写死在两处单次直传路径：
 *   · POST /api/upload      （原始请求体 X-File-Name 与 multipart）
 *   · WebDAV PUT            （PROTOCOL.ts handlePut）
 * 自托管运行时（飞牛 fnOS）没有这个限制，但也必须保留「显式收紧」的能力。
 *
 * 这里用一个很小的上限值来验证控制面，而不是真的传 100MB：
 *   · 未设置 DAVFLARE_MAX_REQUEST_BYTES   → 不限制，大正文成功
 *   · DAVFLARE_MAX_REQUEST_BYTES=1048576  → 超限返回 413，限内成功
 * 另外验证超限的 WebDAV 响应确实带 Connection: close（连接不被复用）。
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
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

const MiB = 1024 * 1024;

let base;
let dataDir;
let metaDir;
let unlimited;
let limited;
let limitedKey;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startServer(extraEnv) {
  const port = 21000 + Math.floor(Math.random() * 3000);
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
      DAVFLARE_LOG: "0",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
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

async function createKey(origin) {
  const response = await fetch(`${origin}/api/keys`, {
    method: "POST",
    headers: { Authorization: basicHeader, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "limits" }),
  });
  assert.equal(response.status, 200, "创建 API 密钥应成功");
  return (await response.json()).key;
}

before(async () => {
  base = await mkdtemp(path.join(tmpdir(), "davflare-limits-"));
  dataDir = path.join(base, "data");
  metaDir = path.join(base, "meta");
  await mkdir(dataDir, { recursive: true });
  await mkdir(metaDir, { recursive: true });

  unlimited = await startServer({});
  limited = await startServer({ DAVFLARE_MAX_REQUEST_BYTES: String(MiB) });
  unlimited.key = await createKey(unlimited.origin);
  limitedKey = await createKey(limited.origin);
});

after(async () => {
  unlimited?.child.kill();
  limited?.child.kill();
  await rm(base, { recursive: true, force: true });
});

/** 原始请求体上传（X-File-Name） */
function rawUpload(server, key, name, bytes) {
  return fetch(`${server.origin}/api/upload?path=/`, {
    method: "POST",
    headers: {
      "X-Api-Key": key,
      "X-File-Name": name,
      "Content-Type": "application/octet-stream",
    },
    body: Buffer.alloc(bytes, 65),
  });
}

/** multipart 上传（浏览器小文件的路径，正文必须整体进内存） */
function multipartUpload(server, key, name, bytes) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes).fill(66)], name, { type: "text/plain" }));
  return fetch(`${server.origin}/api/upload?path=/`, {
    method: "POST",
    headers: { "X-Api-Key": key },
    body: form,
  });
}

describe("平台适配：单次请求体上限", () => {
  test("默认不限制：原始请求体上传 3MiB 成功并流式落盘", async () => {
    const response = await rawUpload(unlimited, unlimited.key, "unlimited-raw.bin", 3 * MiB);
    assert.equal(response.status, 201, await response.clone().text());
    const payload = await response.json();
    assert.equal(payload.size, 3 * MiB, "响应里的 size 应来自实际落盘的对象");

    const stat = await fetch(`${unlimited.origin}/api/stat?path=%2Funlimited-raw.bin`, {
      headers: { "X-Api-Key": unlimited.key },
    });
    assert.equal(stat.status, 200);
    assert.equal((await stat.json()).size, 3 * MiB);
  });

  test("默认不限制：WebDAV PUT 3MiB 成功", async () => {
    const response = await fetch(`${unlimited.origin}/webdav/unlimited-webdav.bin`, {
      method: "PUT",
      headers: { Authorization: basicHeader },
      body: Buffer.alloc(3 * MiB, 67),
    });
    assert.equal(response.status, 201, "新建资源应返回 201");

    const head = await fetch(`${unlimited.origin}/webdav/unlimited-webdav.bin`, {
      method: "HEAD",
      headers: { Authorization: basicHeader },
    });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(3 * MiB));
  });

  test("默认不限制：分块上传 3MiB（1MiB × 3）成功", async () => {
    const key = "/unlimited-multi.bin";
    const create = await fetch(
      `${unlimited.origin}/api/upload?uploads&path=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "X-Api-Key": unlimited.key, "Content-Type": "application/octet-stream" },
      }
    );
    assert.equal(create.status, 201);
    const { uploadId } = await create.json();

    const parts = [];
    for (let i = 1; i <= 3; i += 1) {
      const part = await fetch(
        `${unlimited.origin}/api/upload?path=${encodeURIComponent(key)}&uploadId=${uploadId}&partNumber=${i}`,
        {
          method: "PUT",
          headers: { "X-Api-Key": unlimited.key, "Content-Type": "application/octet-stream" },
          body: Buffer.alloc(MiB, 68),
        }
      );
      assert.equal(part.status, 200);
      parts.push({ partNumber: i, etag: (await part.json()).etag });
    }
    const complete = await fetch(
      `${unlimited.origin}/api/upload?path=${encodeURIComponent(key)}&uploadId=${uploadId}`,
      {
        method: "POST",
        headers: { "X-Api-Key": unlimited.key, "Content-Type": "application/json" },
        body: JSON.stringify({ parts }),
      }
    );
    assert.equal(complete.status, 200);
    assert.equal((await complete.json()).size, 3 * MiB);
  });

  test("显式收紧到 1MiB：原始请求体上传 2MiB 返回 413", async () => {
    const response = await rawUpload(limited, limitedKey, "limited-raw.bin", 2 * MiB);
    assert.equal(response.status, 413);
    assert.match(await response.text(), /上限/);
  });

  test("显式收紧到 1MiB：WebDAV PUT 2MiB 返回 413 且声明 Connection: close", async () => {
    const response = await fetch(`${limited.origin}/webdav/limited-webdav.bin`, {
      method: "PUT",
      headers: { Authorization: basicHeader },
      body: Buffer.alloc(2 * MiB, 69),
    });
    assert.equal(response.status, 413);
    // 请求体没被读完就返回，连接必须显式关闭，否则客户端复用会撞上 ECONNRESET
    assert.equal(
      (response.headers.get("connection") || "").toLowerCase(),
      "close",
      "超限响应应声明 Connection: close"
    );
  });

  test("显式收紧到 1MiB：multipart 超限同样 413", async () => {
    const response = await multipartUpload(limited, limitedKey, "limited-multi.txt", 2 * MiB);
    assert.equal(response.status, 413);
  });

  test("显式收紧到 1MiB：限内（512KiB）仍然成功", async () => {
    const raw = await rawUpload(limited, limitedKey, "small-raw.bin", 512 * 1024);
    assert.equal(raw.status, 201, await raw.clone().text());

    const webdav = await fetch(`${limited.origin}/webdav/small-webdav.bin`, {
      method: "PUT",
      headers: { Authorization: basicHeader },
      body: Buffer.alloc(512 * 1024, 70),
    });
    assert.equal(webdav.status, 201);
  });

  test("超限之后的连接可继续正常服务（keep-alive 未被污染）", async () => {
    // 先制造一次超限（服务端提前响应、请求体未读完）
    const rejected = await rawUpload(limited, limitedKey, "again-raw.bin", 2 * MiB);
    assert.equal(rejected.status, 413);
    // 紧接着用同一条连接池发一个正常请求：必须拿到正常响应而不是 ECONNRESET
    for (let i = 0; i < 3; i += 1) {
      const ok = await fetch(`${limited.origin}/healthz`);
      assert.equal(ok.status, 200, "超限后健康检查应正常");
    }
  });
});
