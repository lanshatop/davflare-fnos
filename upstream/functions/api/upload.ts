import {
  authorizeApiKey,
  INTERNAL_PREFIX,
  isCollectionObject,
  isInternalKey,
  isTruthyParam,
  jsonResponse,
  textResponse,
  touchLastUsed,
} from "./_apikey";
import { maxRequestBytes } from "../_platform";

interface UploadEnv {
  BUCKET: R2Bucket;
}

const MULTIPART_PART_MAX = 10000;

function tooLarge() {
  const limit = maxRequestBytes();
  const head = Number.isFinite(limit)
    ? `单次上传超过本服务器 ${Math.floor(limit / (1024 * 1024))}MB 的请求体上限。`
    : "单次上传超过本服务器的请求体上限。";
  return textResponse(
    `${head}更大的文件请改用分块上传（网页端、CLI 与 MCP 都支持，可断点续传）。`,
    413
  );
}

function normalizeFolder(raw: string | null): string | Response {
  // 查询参数已由 URLSearchParams 解码一次，这里不再解码（文件名里的字面量 %XX 保持原样）
  let path = (raw || "").trim();
  path = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!path) return "";
  const parts = path.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) {
    return textResponse("路径不合法", 400);
  }
  const joined = parts.join("/");
  if (isInternalKey(joined)) {
    return textResponse("禁止写入内部目录", 400);
  }
  return `${joined}/`;
}

function sanitizeFileName(name: string) {
  const cleaned = name.replace(/\\/g, "/").split("/").pop() || "";
  return cleaned.replace(/[\u0000-\u001f]/g, "").trim();
}

function uniqueName(name: string, taken: Set<string>) {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let index = 2;
  while (taken.has(`${stem} (${index})${ext}`)) index++;
  return `${stem} (${index})${ext}`;
}

async function listTakenNames(bucket: R2Bucket, folder: string) {
  const taken = new Set<string>();
  let cursor: string | undefined;
  do {
    const listing = await bucket.list({
      prefix: folder,
      delimiter: "/",
      cursor,
    });
    for (const object of listing.objects) {
      const name = object.key.slice(folder.length);
      if (name && !name.includes("/")) taken.add(name);
    }
    const prefixes = (listing as { delimitedPrefixes?: string[] })
      .delimitedPrefixes;
    if (prefixes) {
      for (const prefix of prefixes) {
        const name = prefix.slice(folder.length).replace(/\/$/, "");
        if (name) taken.add(name);
      }
    }
    if (!listing.truncated) break;
    cursor = listing.cursor;
  } while (true);
  return taken;
}

async function ensureFolders(bucket: R2Bucket, folder: string) {
  if (!folder) return;
  const parts = folder.replace(/\/$/, "").split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const head = await bucket.head(current);
    if (head === null) {
      await bucket.put(current, new Uint8Array(), {
        httpMetadata: { contentType: "application/x-directory" },
        customMetadata: { resourcetype: "<collection />" },
      });
    }
  }
}

/**
 * 解析单次上传的正文。
 *
 * - multipart/form-data（浏览器小文件的规范路径）：必须整体解析，正文要在内存里过一遍，
 *   因此仍按平台上限校验；大文件请走分块上传。
 * - 原始请求体（X-File-Name）：正文以流的形式直接交给存储层，
 *   自托管运行时下大小只受磁盘限制，不占内存。
 */
async function readUpload(request: Request): Promise<
  | { name: string; body: ArrayBuffer | ReadableStream; contentType: string; size: number | null }
  | Response
> {
  const limit = maxRequestBytes();
  // 注意：缺失的 Content-Length 不能当成 0 —— MCP 的内部请求克隆会剥掉该头，
  // 分块传输（chunked）也天然没有；只有显式的 Content-Length: 0 才是空文件。
  const contentLengthHeader = request.headers.get("Content-Length");
  const contentLength = contentLengthHeader === null ? Number.NaN : Number(contentLengthHeader);
  if (Number.isFinite(limit) && Number.isFinite(contentLength) && contentLength >= limit) {
    return tooLarge();
  }

  const contentType = request.headers.get("Content-Type") || "";
  if (contentType.toLowerCase().includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return textResponse("无法解析上传内容", 400);
    }
    const file = form.get("file");
    if (!(file instanceof File)) {
      return textResponse("请使用 multipart 字段 file 上传文件", 400);
    }
    if (Number.isFinite(limit) && file.size >= limit) return tooLarge();
    const name = sanitizeFileName(file.name);
    if (!name) return textResponse("文件名无效", 400);
    return {
      name,
      body: await file.arrayBuffer(),
      contentType: file.type || "application/octet-stream",
      size: file.size,
    };
  }

  const name = sanitizeFileName(request.headers.get("X-File-Name") || "");
  if (!name) {
    return textResponse("原始请求体上传需要提供 X-File-Name 头", 400);
  }
  if (Number.isFinite(contentLength) && contentLength === 0) {
    return textResponse("文件内容为空", 400);
  }
  if (!request.body) return textResponse("文件内容为空", 400);
  if (Number.isNaN(contentLength)) {
    // Content-Length 缺失（MCP 的内部请求克隆会剥掉该头，chunked 上传也天然没有）
    // 不能当成空文件；但「构造 Request 时 body 为空串」同样没有该头。
    // 读首个数据块区分：立即 done = 真空文件；否则把首块与其余流拼回去继续走流式落盘。
    const reader = (request.body as ReadableStream).getReader();
    const first = await reader.read();
    if (first.done || !first.value) return textResponse("文件内容为空", 400);
    const head = first.value as Uint8Array;
    const rest = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(head);
        const pump = async () => {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              return;
            }
            if (value) controller.enqueue(value);
          }
        };
        void pump().catch((error) => controller.error(error));
      },
      cancel() {
        void reader.cancel().catch(() => undefined);
      },
    });
    return {
      name,
      body: rest,
      contentType: contentType || "application/octet-stream",
      // 块传输（chunked）没有 Content-Length：写完后再由存储层返回真实大小。
      size: null,
    };
  }
  return {
    name,
    body: request.body as unknown as ReadableStream,
    contentType: contentType || "application/octet-stream",
    size: contentLength > 0 ? contentLength : null,
  };
}

// 分块上传：path 为完整文件键（目录/文件名）
function multipartFileKey(raw: string | null): string | Response {
  // 同 normalizeFolder：只依赖 URLSearchParams 的一次解码
  const path = (raw || "").trim();
  if (!path) return textResponse("分块上传需要 path 指向完整文件键", 400);
  const parts = path
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) {
    return textResponse("路径不合法", 400);
  }
  const key = parts.join("/");
  if (!key) return textResponse("分块上传需要 path 指向完整文件键", 400);
  if (isInternalKey(key)) {
    return textResponse("禁止写入内部目录", 400);
  }
  return key;
}

function parsePartNumber(raw: string | null): number | Response {
  if (!raw || !/^\d+$/.test(raw)) {
    return textResponse("partNumber 不合法", 400);
  }
  const partNumber = parseInt(raw, 10);
  if (partNumber < 1 || partNumber > MULTIPART_PART_MAX) {
    return textResponse(`partNumber 需在 1-${MULTIPART_PART_MAX}`, 400);
  }
  return partNumber;
}

export const onRequestPost: PagesFunction<UploadEnv> = async (context) => {
  const { request, env } = context;
  const auth = await authorizeApiKey(request, env.BUCKET);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);

  // —— 分块上传 ①：创建（POST /api/upload?uploads&path=<文件键>）——
  if (url.searchParams.has("uploads")) {
    const key = multipartFileKey(url.searchParams.get("path"));
    if (key instanceof Response) return key;
    const slash = key.lastIndexOf("/");
    if (slash > 0) await ensureFolders(env.BUCKET, key.slice(0, slash + 1));
    const contentType = request.headers.get("Content-Type") || "";
    const multipart = await env.BUCKET.createMultipartUpload(key, {
      httpMetadata: {
        contentType: contentType || "application/octet-stream",
      },
    });
    await touchLastUsed(env.BUCKET, auth);
    return jsonResponse(
      { key: multipart.key, uploadId: multipart.uploadId },
      201
    );
  }

  // —— 分块上传 ③：完成（POST /api/upload?path=&uploadId=，body { parts }）——
  const completeUploadId = url.searchParams.get("uploadId");
  if (completeUploadId) {
    const key = multipartFileKey(url.searchParams.get("path"));
    if (key instanceof Response) return key;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return textResponse("无法解析 JSON", 400);
    }
    if (!body || typeof body !== "object" || !Array.isArray((body as { parts?: unknown }).parts)) {
      return textResponse("parts 参数不合法", 400);
    }
    const parts = (
      (body as { parts: Array<{ partNumber?: unknown; etag?: unknown }> }).parts
    ).map((part) => ({
      partNumber: Number(part.partNumber),
      etag: String(part.etag ?? ""),
    }));
    // R2 要求分块按 partNumber 升序且不重复，提前校验给出明确错误
    const ascending = parts.every(
      (part, index) =>
        index === 0 || part.partNumber > parts[index - 1].partNumber
    );
    const invalid =
      parts.length === 0 ||
      !ascending ||
      parts.length > MULTIPART_PART_MAX ||
      parts.some(
        (part) =>
          !Number.isInteger(part.partNumber) ||
          part.partNumber < 1 ||
          part.partNumber > MULTIPART_PART_MAX ||
          !part.etag
      );
    if (invalid) {
      return textResponse("parts 参数不合法", 400);
    }
    try {
      const multipart = env.BUCKET.resumeMultipartUpload(key, completeUploadId);
      const object = await multipart.complete(parts);
      await touchLastUsed(env.BUCKET, auth);
      return jsonResponse({
        key: object.key,
        size: object.size,
        etag: (object as { httpEtag?: string }).httpEtag ?? "",
      });
    } catch (error) {
      return textResponse((error as Error)?.message || "完成分块上传失败", 400);
    }
  }

  const folder = normalizeFolder(url.searchParams.get("path"));
  if (folder instanceof Response) return folder;

  const upload = await readUpload(request);
  if (upload instanceof Response) return upload;

  const overwrite = isTruthyParam(url.searchParams.get("overwrite"));

  await ensureFolders(env.BUCKET, folder);
  let fileName = upload.name;
  let overwritten = false;
  if (overwrite) {
    const existing = await env.BUCKET.head(`${folder}${fileName}`);
    if (existing && isCollectionObject(existing)) {
      return textResponse("目标已存在且为目录，无法覆盖", 409);
    }
    if (existing) overwritten = true;
    else {
      const listing = await env.BUCKET.list({
        prefix: `${folder}${fileName}/`,
        limit: 1,
      });
      if (listing.objects.length > 0) {
        return textResponse("目标已存在且为目录，无法覆盖", 409);
      }
    }
  } else {
    const taken = await listTakenNames(env.BUCKET, folder);
    fileName = uniqueName(upload.name, taken);
  }
  const key = `${folder}${fileName}`;
  if (key.startsWith(INTERNAL_PREFIX)) {
    return textResponse("禁止写入内部目录", 400);
  }

  const written = await env.BUCKET.put(key, upload.body, {
    httpMetadata: { contentType: upload.contentType },
  });
  await touchLastUsed(env.BUCKET, auth);

  return jsonResponse(
    {
      key,
      name: fileName,
      size: written?.size ?? upload.size ?? 0,
      path: folder || "/",
      overwritten,
    },
    201
  );
};

// —— 分块上传 ②：上传分块（PUT /api/upload?path=&uploadId=&partNumber=，原始请求体）——
export const onRequestPut: PagesFunction<UploadEnv> = async (context) => {
  const { request, env } = context;
  const auth = await authorizeApiKey(request, env.BUCKET);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const key = multipartFileKey(url.searchParams.get("path"));
  if (key instanceof Response) return key;
  const uploadId = url.searchParams.get("uploadId");
  if (!uploadId) return textResponse("缺少 uploadId", 400);
  const partNumber = parsePartNumber(url.searchParams.get("partNumber"));
  if (partNumber instanceof Response) return partNumber;
  if (!request.body) return textResponse("缺少分块内容", 400);

  try {
    const multipart = env.BUCKET.resumeMultipartUpload(key, uploadId);
    const part = await multipart.uploadPart(partNumber, request.body);
    await touchLastUsed(env.BUCKET, auth);
    return jsonResponse({ partNumber: part.partNumber, etag: part.etag });
  } catch (error) {
    return textResponse((error as Error)?.message || "上传分块失败", 400);
  }
};

// —— 分块上传 ④：放弃（DELETE /api/upload?path=&uploadId=）——
export const onRequestDelete: PagesFunction<UploadEnv> = async (context) => {
  const { request, env } = context;
  const auth = await authorizeApiKey(request, env.BUCKET);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const key = multipartFileKey(url.searchParams.get("path"));
  if (key instanceof Response) return key;
  const uploadId = url.searchParams.get("uploadId");
  if (!uploadId) return textResponse("缺少 uploadId", 400);

  try {
    const multipart = env.BUCKET.resumeMultipartUpload(key, uploadId);
    await multipart.abort();
  } catch {
    // 未知的 uploadId 视为已失效，幂等返回
  }
  await touchLastUsed(env.BUCKET, auth);
  return new Response(null, { status: 204 });
};
