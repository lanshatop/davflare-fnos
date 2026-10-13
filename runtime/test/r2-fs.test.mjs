/**
 * R2 兼容层语义测试
 *
 * 这些断言不是「随便测测」，而是逐条对应 upstream/functions/** 真实依赖的 R2 行为：
 * 一旦某条不成立，对应功能就会在飞牛上出问题（注释里标了受影响的端点）。
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { FsBucket } from "../dist/r2-fs.mjs";

let base;
let bucket;

async function freshBucket() {
  const root = await mkdtemp(path.join(base, "data-"));
  const metaRoot = await mkdtemp(path.join(base, "meta-"));
  const tmpRoot = await mkdtemp(path.join(base, "tmp-"));
  return new FsBucket({ root, metaRoot, tmpRoot });
}

before(async () => {
  base = await mkdtemp(path.join(tmpdir(), "davflare-r2-"));
});

after(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("基础读写", () => {
  test("put/get/head 往返，字符串与字节都支持", async () => {
    bucket = await freshBucket();
    await bucket.put("a.txt", "hello");
    const object = await bucket.get("a.txt");
    assert.equal(await object.text(), "hello");
    assert.equal(object.size, 5);

    const head = await bucket.head("a.txt");
    assert.equal(head.size, 5);
    assert.equal(head.key, "a.txt");

    await bucket.put("b.bin", new Uint8Array([1, 2, 3]));
    const bin = await bucket.get("b.bin");
    assert.deepEqual(new Uint8Array(await bin.arrayBuffer()), new Uint8Array([1, 2, 3]));
  });

  test("缺失对象：get/head 都返回 null（list.ts / download.ts 依赖）", async () => {
    assert.equal(await bucket.get("nope.txt"), null);
    assert.equal(await bucket.head("nope.txt"), null);
  });

  test("etag 形状与 httpEtag 引号（list.ts 的 fileEtag、WebDAV 的 If-Match）", async () => {
    const object = await bucket.head("a.txt");
    assert.match(object.etag, /^[0-9a-f]{32}$/);
    assert.equal(object.httpEtag, `"${object.etag}"`);
    assert.equal(object.storageClass, "Standard");
    assert.ok(object.uploaded instanceof Date);
  });

  test("内容变化后 etag 变化（前端缓存再验证）", async () => {
    const before = await bucket.head("a.txt");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await bucket.put("a.txt", "hello world");
    const after = await bucket.head("a.txt");
    assert.notEqual(before.etag, after.etag);
  });

  test("自动创建中间目录（upload.ts 的 key 带多级路径）", async () => {
    await bucket.put("x/y/z/deep.txt", "deep");
    assert.equal(await (await bucket.get("x/y/z/deep.txt")).text(), "deep");
  });
});

describe("元数据", () => {
  test("httpMetadata / customMetadata 持久化并可写回响应头", async () => {
    await bucket.put("doc.md", "# hi", {
      httpMetadata: { contentType: "text/markdown", cacheControl: "no-cache" },
      customMetadata: { thumbnail: "abc", keep: "1" },
    });
    const object = await bucket.get("doc.md");
    assert.equal(object.httpMetadata.contentType, "text/markdown");
    assert.equal(object.httpMetadata.cacheControl, "no-cache");
    assert.equal(object.customMetadata.thumbnail, "abc");

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    assert.equal(headers.get("Content-Type"), "text/markdown");
    assert.equal(headers.get("Cache-Control"), "no-cache");
    // share/[[token]].ts 依赖 writeHttpMetadata 写出全量 Content-Length 后再被 Range 覆盖
    assert.equal(headers.get("Content-Length"), String(object.size));
  });

  test("httpMetadata 可以直接传 Headers（webdav/davUtil.ts 的 uploadHttpMetadata）", async () => {
    const headers = new Headers({ "Content-Type": "application/pdf" });
    await bucket.put("p.pdf", new Uint8Array([37, 80, 68, 70]), { httpMetadata: headers });
    const object = await bucket.head("p.pdf");
    assert.equal(object.httpMetadata.contentType, "application/pdf");
  });

  test("元数据存放在数据目录之外，不污染用户可见的文件树", async () => {
    const root = bucket.root;
    const entries = await readdir(root);
    assert.ok(entries.includes("a.txt"));
    assert.ok(!entries.some((name) => name.includes("meta") || name.includes("davflare")));
  });
});

describe("目录标记语义（mkdir.ts / ensureFolderMarkers / list.ts）", () => {
  test("空值 put 会建目录，head 判定为集合对象", async () => {
    await bucket.put("folder", new Uint8Array(), {
      httpMetadata: { contentType: "application/x-directory" },
      customMetadata: { resourcetype: "<collection />" },
    });
    const head = await bucket.head("folder");
    assert.equal(head.httpMetadata.contentType, "application/x-directory");
    assert.equal(head.customMetadata.resourcetype, "<collection />");
    const body = await bucket.get("folder");
    assert.equal(body.size, 0);
    assert.equal(await body.text(), "");
    assert.notEqual(body.body, null);
  });

  test("带分隔符列举：目录同时以「标记对象 + 分隔前缀」出现（list.ts 的 collectPage 靠这个合并）", async () => {
    bucket = await freshBucket();
    await bucket.put("dir", new Uint8Array(), {
      httpMetadata: { contentType: "application/x-directory" },
      customMetadata: { resourcetype: "<collection />" },
    });
    await bucket.put("dir/child.txt", "c");
    await bucket.put("plain.txt", "p");

    const listing = await bucket.list({
      prefix: "",
      delimiter: "/",
      include: ["httpMetadata", "customMetadata"],
    });
    const keys = listing.objects.map((object) => object.key);
    assert.deepEqual(keys, ["dir", "plain.txt"]);
    assert.equal(listing.truncated, false);
    assert.deepEqual(listing.delimitedPrefixes, ["dir/"]);
    const dirObject = listing.objects.find((object) => object.key === "dir");
    assert.equal(dirObject.customMetadata.resourcetype, "<collection />");
  });

  test("删除非空目录的标记：键消失、子对象保留、仍以分隔前缀出现（R2 标记语义）", async () => {
    await bucket.delete("dir");
    // R2 里这三件事是独立的：key `dir` 没了，`dir/child.txt` 还在
    assert.equal(await bucket.head("dir"), null, "标记键应当已不存在");
    assert.deepEqual((await bucket.list({ prefix: "dir/" })).objects.length, 1);

    const listingAfter = await bucket.list({ prefix: "", delimiter: "/" });
    assert.ok(listingAfter.delimitedPrefixes.includes("dir/"), "仍有子对象：前缀保留");
    assert.ok(
      !listingAfter.objects.some((object) => object.key === "dir"),
      "标记对象不该再作为对象出现"
    );

    // 子对象也删掉后，目录彻底消失（不再有前缀、也不再有对象）
    await bucket.delete("dir/child.txt");
    assert.equal(await bucket.get("dir"), null, "标记键仍不存在");
    const nowEmpty = await bucket.list({ prefix: "", delimiter: "/" });
    assert.ok(!nowEmpty.delimitedPrefixes.includes("dir/"), "空目录不再产生前缀");
    assert.ok(!nowEmpty.objects.some((object) => object.key === "dir"));
  });

  test("删除标记 → 删子项（上游 deleteDirectory 的顺序）能彻底清干净", async () => {
    // 上游 deleteDirectory / moveDirectory / softDeleteKeys 都是
    // 「先删标记、再删后代」，靠内部待清理标记最终把目录移除
    bucket = await freshBucket();
    await bucket.put("tree", new Uint8Array(), {
      httpMetadata: { contentType: "application/x-directory" },
    });
    await bucket.put("tree/sub", new Uint8Array(), {
      httpMetadata: { contentType: "application/x-directory" },
    });
    await bucket.put("tree/sub/f.txt", "x");

    await bucket.delete("tree");
    await bucket.delete("tree/sub");
    await bucket.delete("tree/sub/f.txt");

    assert.equal(await bucket.head("tree"), null);
    assert.equal(await bucket.head("tree/sub"), null);
    const listing = await bucket.list({ prefix: "" });
    assert.equal(listing.objects.length, 0, `应当清空，实际 ${JSON.stringify(listing.objects.map((o) => o.key))}`);
  });

  test("删除空目录的标记会移除目录", async () => {
    await bucket.delete("dir");
    assert.equal(await bucket.get("dir"), null);
  });
});

describe("列举与分页", () => {
  test("递归列举返回所有键，且顺序与 R2 的字节序一致", async () => {
    bucket = await freshBucket();
    const keys = ["a/b.txt", "a/b/c.txt", "a.txt", "ab.txt", "中文/文件.txt", "za.txt"];
    for (const key of keys) await bucket.put(key, "x");

    const all = await bucket.list();
    const listed = all.objects.map((object) => object.key);
    const expected = [...listed].sort((x, y) =>
      Buffer.compare(Buffer.from(x, "utf8"), Buffer.from(y, "utf8"))
    );
    assert.deepEqual(listed, expected);
    for (const key of keys) assert.ok(listed.includes(key), `缺少 ${key}`);
  });

  test("limit 触发 truncated 与 cursor，翻页不重不漏", async () => {
    bucket = await freshBucket();
    const total = 25;
    for (let index = 0; index < total; index += 1) {
      await bucket.put(`items/file-${String(index).padStart(3, "0")}.txt`, String(index));
    }

    const seen = [];
    let cursor;
    let guard = 0;
    do {
      const page = await bucket.list({ prefix: "items/", limit: 7, cursor });
      seen.push(...page.objects.map((object) => object.key));
      cursor = page.truncated ? page.cursor : undefined;
      guard += 1;
      if (guard > 50) throw new Error("分页未收敛");
    } while (cursor);

    assert.equal(seen.length, total);
    assert.equal(new Set(seen).size, total, "翻页出现重复键");
  });

  test("带分隔符 + 分页时，目录前缀不会被重复返回", async () => {
    bucket = await freshBucket();
    for (let index = 0; index < 40; index += 1) {
      await bucket.put(`root/f${String(index).padStart(2, "0")}.txt`, "x");
    }
    for (let index = 0; index < 10; index += 1) {
      await bucket.put(`root/sub${index}/inner.txt`, "y");
    }

    const prefixes = [];
    const objectKeys = [];
    let cursor;
    let guard = 0;
    do {
      const page = await bucket.list({ prefix: "root/", delimiter: "/", limit: 6, cursor });
      prefixes.push(...page.delimitedPrefixes);
      objectKeys.push(...page.objects.map((object) => object.key));
      cursor = page.truncated ? page.cursor : undefined;
      guard += 1;
      if (guard > 200) throw new Error("分页未收敛");
    } while (cursor);

    assert.equal(new Set(prefixes).size, prefixes.length, "分隔前缀重复");
    assert.equal(new Set(objectKeys).size, objectKeys.length, "对象键重复");
    assert.equal(prefixes.length, 10, `前缀数不对：${JSON.stringify(prefixes)}`);

    // 对象里同时包含 40 个文件和 10 个目录标记对象
    const files = objectKeys.filter((key) => /\/f\d\d\.txt$/.test(key));
    const dirMarkers = objectKeys.filter((key) => /\/sub\d$/.test(key));
    assert.equal(files.length, 40, `文件数不对：${JSON.stringify(objectKeys)}`);
    assert.equal(dirMarkers.length, 10);
    assert.equal(objectKeys.length, 50);
  });

  test("include 未请求时对象上不带元数据字段（语义与 R2 一致）", async () => {
    bucket = await freshBucket();
    await bucket.put("m.txt", "x", { customMetadata: { k: "v" } });
    const without = await bucket.list({ prefix: "m" });
    assert.equal(without.objects[0].customMetadata, undefined);
    const withMeta = await bucket.list({ prefix: "m", include: ["customMetadata"] });
    assert.equal(withMeta.objects[0].customMetadata.k, "v");
  });
});

describe("条件请求（webdav/protocol.ts 的 412 与 share 的提取码门禁）", () => {
  test("get 的条件不满足时返回**没有 body** 的对象（上游据此回 412）", async () => {
    bucket = await freshBucket();
    await bucket.put("cond.txt", "v1");
    const object = await bucket.get("cond.txt", { onlyIf: { etagMatches: "deadbeef" } });
    assert.notEqual(object, null);
    assert.equal("body" in object, false);
  });

  test("etagMatches 命中时正常返回 body", async () => {
    const head = await bucket.head("cond.txt");
    const object = await bucket.get("cond.txt", { onlyIf: { etagMatches: head.etag } });
    assert.ok("body" in object);
    assert.equal(await object.text(), "v1");
  });

  test("put 的 onlyIf 不满足时返回 null（_collectUpload.ts 的 etagDoesNotMatch:'*' 预占）", async () => {
    const first = await bucket.put("once.txt", "first", {
      onlyIf: { etagDoesNotMatch: "*" },
    });
    assert.notEqual(first, null);
    const second = await bucket.put("once.txt", "second", {
      onlyIf: { etagDoesNotMatch: "*" },
    });
    assert.equal(second, null);
    assert.equal(await (await bucket.get("once.txt")).text(), "first");
  });

  test("put 接受 Headers 形式的条件（webdav 直接传 getConditionalHeaders 的结果）", async () => {
    const headers = new Headers({ "If-Match": '"0000000000000000000000000000dead"' });
    const result = await bucket.put("cond.txt", "v2", { onlyIf: headers });
    assert.equal(result, null);
  });
});

describe("Range 读取（download.ts / share 的视频拖动与断点续传）", () => {
  test("bytes=0-3 返回前 4 字节并给出 range.offset/length", async () => {
    bucket = await freshBucket();
    await bucket.put("range.txt", "0123456789");
    const headers = new Headers({ Range: "bytes=0-3" });
    const object = await bucket.get("range.txt", { range: headers });
    assert.equal(await object.text(), "0123");
    assert.equal(object.range.offset, 0);
    assert.equal(object.range.length, 4);
  });

  test("bytes=4- 返回其余部分", async () => {
    const headers = new Headers({ Range: "bytes=4-" });
    const object = await bucket.get("range.txt", { range: headers });
    assert.equal(await object.text(), "456789");
    assert.deepEqual(object.range, { offset: 4, length: 6 });
  });

  test("suffix 形式（bytes=-3）与对象形式 {suffix} 都支持", async () => {
    const object = await bucket.get("range.txt", {
      range: new Headers({ Range: "bytes=-3" }),
    });
    assert.equal(await object.text(), "789");

    const viaObject = await bucket.get("range.txt", { range: { suffix: 2 } });
    assert.equal(await viaObject.text(), "89");
  });

  test("不可满足的 Range 抛错（上游 catch 后回退全量，避免 500）", async () => {
    await assert.rejects(() =>
      bucket.get("range.txt", { range: new Headers({ Range: "bytes=100-200" }) })
    );
    await assert.rejects(() =>
      bucket.get("range.txt", { range: { offset: 50, length: 1 } })
    );
  });

  test("大文件 Range 不读全量（只读请求区间）", async () => {
    const big = Buffer.alloc(4 * 1024 * 1024, 7);
    await bucket.put("big.bin", new Uint8Array(big));
    const object = await bucket.get("big.bin", {
      range: new Headers({ Range: "bytes=1048576-1048579" }),
    });
    const chunk = new Uint8Array(await object.arrayBuffer());
    assert.equal(chunk.length, 4);
    assert.deepEqual(Array.from(chunk), [7, 7, 7, 7]);
    assert.equal(object.size, big.length);
  });
});

describe("分块上传（upload.ts 的 ①创建 ②上传块 ③完成 ④放弃）", () => {
  test("两块拼接成完整对象，并保留元数据", async () => {
    bucket = await freshBucket();
    const multipart = await bucket.createMultipartUpload("big/multi.bin", {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { source: "mpu" },
    });
    assert.equal(multipart.key, "big/multi.bin");
    assert.ok(multipart.uploadId);

    const resumed = await bucket.resumeMultipartUpload("big/multi.bin", multipart.uploadId);
    const part1 = await resumed.uploadPart(1, new TextEncoder().encode("AAAA"));
    const part2 = await resumed.uploadPart(2, new TextEncoder().encode("BBBB"));
    assert.equal(part1.partNumber, 1);
    assert.match(part1.etag, /^[0-9a-f]{32}$/);

    const completed = await resumed.complete([part1, part2]);
    assert.equal(completed.key, "big/multi.bin");
    assert.equal(completed.size, 8);

    const object = await bucket.get("big/multi.bin");
    assert.equal(await object.text(), "AAAABBBB");
    assert.equal(object.httpMetadata.contentType, "application/octet-stream");
    assert.equal(object.customMetadata.source, "mpu");
  });

  test("abort 清理暂存，之后 complete 会失败", async () => {
    const multipart = await bucket.createMultipartUpload("big/gone.bin");
    const resumed = await bucket.resumeMultipartUpload("big/gone.bin", multipart.uploadId);
    await resumed.uploadPart(1, new TextEncoder().encode("X"));
    await resumed.abort();
    await assert.rejects(() => resumed.complete([{ partNumber: 1, etag: "x" }]));
    assert.equal(await bucket.head("big/gone.bin"), null);
  });

  test("缺少分块时 complete 报错", async () => {
    const multipart = await bucket.createMultipartUpload("big/missing.bin");
    const resumed = await bucket.resumeMultipartUpload("big/missing.bin", multipart.uploadId);
    await resumed.uploadPart(1, new TextEncoder().encode("A"));
    await assert.rejects(() => resumed.complete([{ partNumber: 1, etag: "a" }, { partNumber: 2, etag: "b" }]));
  });
});

describe("安全边界", () => {
  test("拒绝会逃出数据根目录的键", async () => {
    await assert.rejects(() => bucket.put("../escape.txt", "x"));
    await assert.rejects(() => bucket.put("a/../../escape.txt", "x"));
    await assert.rejects(() => bucket.put("/abs.txt", "x"));
  });

  test("外部程序（SMB / 文件管理器）写入的文件能被直接读到", async () => {
    bucket = await freshBucket();
    await mkdir(path.join(bucket.root, "shared"), { recursive: true });
    await writeFile(path.join(bucket.root, "shared", "from-smb.txt"), "written by SMB");
    const object = await bucket.get("shared/from-smb.txt");
    assert.equal(await object.text(), "written by SMB");
    const listing = await bucket.list({ prefix: "", delimiter: "/" });
    assert.deepEqual(listing.delimitedPrefixes, ["shared/"]);
  });

  test("外部删除文件后网盘同步消失（不需要索引重建）", async () => {
    await rm(path.join(bucket.root, "shared", "from-smb.txt"));
    assert.equal(await bucket.head("shared/from-smb.txt"), null);
  });

  test("上传过程中的临时文件不会出现在列举里", async () => {
    bucket = await freshBucket();
    await writeFile(path.join(bucket.root, ".davflaretmpabc123"), "partial");
    await bucket.put("real.txt", "ok");
    const listing = await bucket.list();
    assert.deepEqual(listing.objects.map((object) => object.key), ["real.txt"]);
  });
});

describe("中文与特殊字符文件名", () => {
  test("中文键可读写、可列举、分页不重不漏", async () => {
    bucket = await freshBucket();
    const names = [
      "中文目录/文件 一.txt",
      "中文目录/文件二.txt",
      "子目录/更深/文件.txt",
      "emoji-🎉.txt",
      "带#井号.txt",
    ];
    for (const key of names) await bucket.put(key, "内容");
    for (const key of names) {
      assert.equal(await (await bucket.get(key)).text(), "内容", `读不到 ${key}`);
    }

    const listing = await bucket.list({ prefix: "", delimiter: "/" });
    assert.deepEqual(new Set(listing.delimitedPrefixes), new Set(["中文目录/", "子目录/"]));
    assert.ok(listing.objects.some((object) => object.key === "emoji-🎉.txt"));
    assert.ok(listing.objects.some((object) => object.key === "带#井号.txt"));

    // 每层目录：标记对象 + 分隔前缀 = 2 条；两个顶层目录 4 条，加 2 个文件 = 6 条
    const seen = [];
    let cursor;
    let guard = 0;
    do {
      const page = await bucket.list({ prefix: "", delimiter: "/", limit: 2, cursor });
      seen.push(...page.delimitedPrefixes);
      seen.push(...page.objects.map((object) => object.key));
      cursor = page.truncated ? page.cursor : undefined;
      guard += 1;
      if (guard > 50) throw new Error("分页未收敛");
    } while (cursor);

    assert.equal(seen.length, 6, `分页总条目数不对：${JSON.stringify(seen)}`);
    assert.equal(new Set(seen).size, seen.length, "分页出现重复");
  });
});

describe("文档化的固有限制", () => {
  test("同名文件与目录不能共存：报错可读，不会变成 500", async () => {
    bucket = await freshBucket();
    await bucket.put("same-name", "i am a file");
    await assert.rejects(() => bucket.put("same-name/inner.txt", "x"), /同名文件占用/);

    await bucket.put("only-dir", new Uint8Array());
    await assert.rejects(() => bucket.put("only-dir", "i am a file"), /同名目录已存在/);
  });
});
