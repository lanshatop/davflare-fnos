/**
 * 品牌自定义（/api/branding）端到端测试。
 *
 * 覆盖：公开读取 / 管理员上传（multipart）/ 名称与 logo 的部分更新 /
 * 恢复默认 / 鉴权边界（未登录、API 密钥可以改）/ favicon 静态覆盖 /
 * 分享落地页与 WebDAV 目录页的品牌名注入。
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
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

let base;
let drive;
let apiKey;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startServer(extraEnv) {
  const port = 18000 + Math.floor(Math.random() * 3000);
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      DAVFLARE_PORT: String(port),
      DAVFLARE_HOST: "127.0.0.1",
      DAVFLARE_DATA_DIR: path.join(base, "data"),
      DAVFLARE_META_DIR: path.join(base, "meta"),
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
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) return { origin, child };
    } catch { /* 还没起来 */ }
    await sleep(120);
  }
  throw new Error(`服务未启动（${origin}）\n${stderr}`);
}

function session(pathname, init = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", basicHeader);
  return fetch(`${drive.origin}${pathname}`, { ...init, headers });
}

/** 带齐两类凭据（与真实客户端一致） */
function api(pathname, init = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", basicHeader);
  if (apiKey) headers.set("X-Api-Key", apiKey);
  return fetch(`${drive.origin}${pathname}`, { ...init, headers });
}

function keyed(pathname, init = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set("X-Api-Key", apiKey);
  return fetch(`${drive.origin}${pathname}`, { ...init, headers });
}

/** 1×1 红色 PNG */
const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function brandingForm(fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value instanceof Buffer) {
      form.append(key, new Blob([value], { type: "image/png" }), "logo.png");
    } else if (value && value.__raw) {
      // 自定义 MIME 的原始内容（测非图片拒绝）
      form.append(key, new Blob([value.data], { type: value.type }), value.name ?? "raw");
    } else {
      form.append(key, value);
    }
  }
  return form;
}

before(async () => {
  base = await mkdtemp(path.join(tmpdir(), "davflare-branding-"));
  await writeFile(path.join(base, "keep"), "");
  drive = await startServer({});
  const response = await session("/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "branding-test" }),
  });
  apiKey = (await response.json()).key;
});

after(async () => {
  drive?.child.kill();
  await rm(base, { recursive: true, force: true }).catch(() => undefined);
});

describe("品牌自定义 /api/branding", () => {
  test("默认状态：GET 返回 null 配置，logo 404", async () => {
    const response = await fetch(`${drive.origin}/api/branding`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.name, null);
    assert.equal(data.hasCustomLogo, false);
    assert.equal(data.defaultName, "Davflare");

    const logo = await fetch(`${drive.origin}/api/branding/logo`);
    assert.equal(logo.status, 404);
  });

  test("未登录不能修改（无凭据 401）", async () => {
    const response = await fetch(`${drive.origin}/api/branding`, {
      method: "PUT",
      body: brandingForm({ name: "黑客网盘" }),
    });
    assert.equal(response.status, 401);
  });

  test("管理员（Basic 会话）可以设置名称与 logo", async () => {
    const response = await session("/api/branding", {
      method: "PUT",
      body: brandingForm({ name: "家庭网盘", logo: RED_PNG }),
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.name, "家庭网盘");
    assert.equal(data.hasCustomLogo, true);

    const info = await (await fetch(`${drive.origin}/api/branding`)).json();
    assert.equal(info.name, "家庭网盘");
    assert.equal(info.hasCustomLogo, true);
  });

  test("API 密钥同样可以修改（isSessionOrKeyAuthorized 契约）", async () => {
    const response = await keyed("/api/branding", {
      method: "PUT",
      body: brandingForm({ name: "密钥改名" }),
    });
    assert.equal(response.status, 200);
    const info = await (await fetch(`${drive.origin}/api/branding`)).json();
    assert.equal(info.name, "密钥改名");
    // logo 未随本次请求提供 → 保留
    assert.equal(info.hasCustomLogo, true);
  });

  test("favicon.png 与 logo144.png 被静态层覆盖为自定义 logo", async () => {
    // 3 秒 TTL 缓存，上传后稍等
    await sleep(3200);
    for (const pathname of ["/favicon.png", "/logo144.png"]) {
      const response = await fetch(`${drive.origin}${pathname}`);
      assert.equal(response.status, 200, pathname);
      assert.match(response.headers.get("content-type") ?? "", /image\/png/, pathname);
      const body = Buffer.from(await response.arrayBuffer());
      assert.deepEqual(body, RED_PNG, `${pathname} 应返回自定义 logo 内容`);
    }
    // 不受影响：其它静态资源照常
    const unrelated = await fetch(`${drive.origin}/manifest.json`);
    assert.equal(unrelated.status, 200);
  });

  test("分享落地页注入自定义品牌名", async () => {
    // 先上传一个真实文件（分享创建要求对象存在）；upload 端点只认 API 密钥
    const upload = await api("/api/upload", {
      method: "POST",
      body: brandingForm({
        path: "/",
        file: new File(["品牌文件内容"], "brand-logo.txt", { type: "text/plain" }),
      }),
    });
    assert.equal(upload.status, 201);
    const mk = await session("/api/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "/brand-logo.txt" }),
    });
    assert.equal(mk.status, 200, "创建分享失败");
    const { token } = await mk.json();
    const page = await fetch(`${drive.origin}/share/${token}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /密钥改名/);
    assert.doesNotMatch(html, />Davflare<\/header>/);
  });

  test("WebDAV 目录页注入自定义品牌名", async () => {
    const mk = await api("/api/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/品牌目录" }),
    });
    assert.equal(mk.status, 201, await mk.text());
    // 目录页需要会话（publicRead 未开）
    const page = await session("/webdav/%E5%93%81%E7%89%8C%E7%9B%AE%E5%BD%95/");
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /密钥改名/);
  });

  test("WebDAV 根列表不暴露内部目录（文件系统目录标记对象）", async () => {
    // 品牌上传会在 _$flaredrive$ 下创建子目录；文件系统版的目录标记对象
    // （key 不带尾斜杠）不能出现在 WebDAV 列表里
    const response = await session("/webdav/", { method: "PROPFIND", headers: { Depth: "1" } });
    assert.equal(response.status, 207);
    const xml = await response.text();
    // 注意：xmlns:fd="flaredrive" 命名空间是正常的，只检查内部目录路径本身
    assert.ok(!xml.includes("_$flaredrive$"), "内部目录不应出现在 WebDAV 列表");
  });

  test("clearLogo 移除 logo 但保留名称", async () => {
    const response = await session("/api/branding", {
      method: "PUT",
      body: brandingForm({ clearLogo: "1" }),
    });
    assert.equal(response.status, 200);
    const info = await (await fetch(`${drive.origin}/api/branding`)).json();
    assert.equal(info.name, "密钥改名");
    assert.equal(info.hasCustomLogo, false);
    const logo = await fetch(`${drive.origin}/api/branding/logo`);
    assert.equal(logo.status, 404);
  });

  test("名称留空 = 恢复默认名", async () => {
    const response = await session("/api/branding", {
      method: "PUT",
      body: brandingForm({ name: "  " }),
    });
    assert.equal(response.status, 200);
    const info = await (await fetch(`${drive.origin}/api/branding`)).json();
    assert.equal(info.name, null);
  });

  test("DELETE 恢复默认", async () => {
    await session("/api/branding", {
      method: "PUT",
      body: brandingForm({ name: "再改一次", logo: RED_PNG }),
    });
    const response = await session("/api/branding", { method: "DELETE" });
    assert.equal(response.status, 200);
    const info = await (await fetch(`${drive.origin}/api/branding`)).json();
    assert.equal(info.name, null);
    assert.equal(info.hasCustomLogo, false);
  });

  test("拒绝非图片与超大图片", async () => {
    const notImage = await session("/api/branding", {
      method: "PUT",
      body: brandingForm({
        logo: { __raw: true, type: "text/plain", data: Buffer.from("hello text, not an image"), name: "x.txt" },
      }),
    });
    assert.equal(notImage.status, 415);

    const tooBig = await session("/api/branding", {
      method: "PUT",
      body: brandingForm({ logo: Buffer.alloc(3 * 1024 * 1024, 1) }),
    });
    assert.equal(tooBig.status, 413);
  });
});
