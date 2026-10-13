/**
 * 文件系统版 R2 兼容层（飞牛 fnOS 本地运行时）
 *
 * 目标：让 upstream/functions/** 里所有 `env.BUCKET.xxx()` 调用在本地磁盘上
 * 得到与 Cloudflare R2 一致的语义，从而**不改一行业务代码**。
 *
 * 键 → 路径映射
 *   R2 key "a/b/c.txt"      → <dataRoot>/a/b/c.txt         （普通文件）
 *   R2 key "a/b"（目录标记） → <dataRoot>/a/b               （真实目录）
 *   R2 key ""（根）          → <dataRoot>
 *
 * Davflare 的目录标记键**不带尾斜杠**（见 mkdir.ts / ensureFolderMarkers），
 * 所以「目录」在文件系统上就是真目录，不需要任何伪造。
 *
 * 元数据（httpMetadata / customMetadata）
 *   文件系统无法表达，存到**数据目录之外**的元数据根目录，镜像键的目录结构：
 *   key "a/b/c.txt" → <metaRoot>/a/b/c.txt.m.json
 *   这样做的好处：用户在 SMB / 文件管理器里看不到任何附加文件。
 *
 * 原子写
 *   上传先写同目录临时文件，再 rename —— 同一文件系统内 rename 是原子的，
 *   避免 SMB 端看到半截文件。临时文件名以 .davflaretmp 开头，遍历时跳过。
 */

import { createReadStream, createWriteStream, type Stats } from "node:fs";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface R2HttpMetadata {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  cacheExpiry?: Date;
}

export interface R2Conditional {
  etagMatches?: string;
  etagDoesNotMatch?: string;
  uploadedBefore?: Date;
  uploadedAfter?: Date;
}

export interface R2Range {
  offset?: number;
  length?: number;
  suffix?: number;
}

export type R2PutValue =
  | ReadableStream
  | ArrayBuffer
  | ArrayBufferView
  | string
  | Blob
  | Request
  | null
  | undefined;

export interface FsR2Object {
  key: string;
  version: string;
  size: number;
  etag: string;
  httpEtag: string;
  checksums: Record<string, string>;
  uploaded: Date;
  storageClass: string;
  httpMetadata?: R2HttpMetadata;
  customMetadata?: Record<string, string>;
  range?: R2Range;
}

export interface FsR2ObjectBody extends FsR2Object {
  body: ReadableStream | null;
  bodyUsed: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  blob(): Promise<Blob>;
  writeHttpMetadata(headers: Headers): void;
}

export interface FsR2UploadedPart {
  partNumber: number;
  etag: string;
}

export interface FsR2Objects {
  objects: FsR2Object[];
  truncated: boolean;
  delimitedPrefixes: string[];
  cursor?: string;
}

const TMP_PREFIX = ".davflaretmp";
const DEFAULT_LIST_LIMIT = 1000;
const MAX_KEY_BYTES = 4000;

/** R2 键的合法性检查：拒绝会逃出数据根目录或文件系统无法表示的键 */
export function assertSafeKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("R2 key must be a non-empty string");
  }
  if (Buffer.byteLength(key) > MAX_KEY_BYTES) {
    throw new Error(`R2 key exceeds ${MAX_KEY_BYTES} bytes`);
  }
  if (key.includes("\0")) throw new Error("R2 key must not contain NUL");
  if (key.startsWith("/")) throw new Error("R2 key must not start with '/'");
  for (const segment of key.split("/")) {
    if (segment === "..") throw new Error("R2 key must not contain '..'");
  }
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** 读一层目录，按名字的 UTF-8 字节序排序 */
async function readSortedChildren(dirAbs: string) {
  let dirents;
  try {
    dirents = await fsp.readdir(dirAbs, { withFileTypes: true });
  } catch {
    return [];
  }
  return dirents
    .filter((entry) => !entry.name.startsWith(TMP_PREFIX))
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .sort((a, b) => byteCompare(a.name, b.name));
}

interface WalkSource {
  /** 当前待发出的键 */
  key: string;
  /** 当前键是目录标记还是文件 */
  isDir: boolean;
  /** 这个数据源本身是不是目录（决定发出后是否继续读子树） */
  childIsDir: boolean;
  abs: string;
  iter: Peekable<{ key: string; isDir: boolean; abs: string }> | null;
}

/** 可预读一个元素的异步迭代器（多路归并需要 peek 后比较） */
class Peekable<T> {
  private buffered: T | undefined;
  private hasBuffered = false;

  constructor(private readonly source: AsyncGenerator<T>) {}

  async next(): Promise<T | undefined> {
    if (this.hasBuffered) {
      this.hasBuffered = false;
      const value = this.buffered;
      this.buffered = undefined;
      return value;
    }
    const result = await this.source.next();
    return result.done ? undefined : result.value;
  }
}

/** 极简小顶堆（多路归并取最小键） */
class MinHeap<T> {
  private readonly items: T[] = [];

  constructor(private readonly compare: (a: T, b: T) => number) {}

  get size(): number {
    return this.items.length;
  }

  push(value: T): void {
    this.items.push(value);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.compare(this.items[index]!, this.items[parent]!) >= 0) break;
      [this.items[index], this.items[parent]] = [this.items[parent]!, this.items[index]!];
      index = parent;
    }
  }

  pop(): T | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0]!;
    const last = this.items.pop()!;
    if (this.items.length === 0) return top;
    this.items[0] = last;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.items.length && this.compare(this.items[left]!, this.items[smallest]!) < 0) {
        smallest = left;
      }
      if (right < this.items.length && this.compare(this.items[right]!, this.items[smallest]!) < 0) {
        smallest = right;
      }
      if (smallest === index) break;
      [this.items[index], this.items[smallest]] = [this.items[smallest]!, this.items[index]!];
      index = smallest;
    }
    return top;
  }
}

function etagOf(stat: Stats): string {
  // R2 的 etag 是内容 MD5；本地用 (inode, size, 亚毫秒 mtime) 派生，形状一致、
  // 内容或时间一变就变，且**不需要读文件内容**（大目录列举很快）。
  const seed = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  return crypto.createHash("md5").update(seed).digest("hex");
}

function quote(etag: string): string {
  return `"${etag}"`;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("W/")) return unquote(trimmed.slice(2));
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

class RangeNotSatisfiableError extends Error {
  constructor(message = "range not satisfiable") {
    super(message);
    this.name = "RangeNotSatisfiableError";
  }
}

export interface FsBucketOptions {
  /** 数据根目录：R2 桶的根，用户真实文件所在处 */
  root: string;
  /** 元数据根目录：存 httpMetadata / customMetadata，**必须不在 root 内** */
  metaRoot: string;
  /** 分块上传暂存目录 */
  tmpRoot: string;
}

export class FsBucket {
  private readonly root: string;
  private readonly rootWithSeparator: string;
  private readonly metaRoot: string;
  private readonly tmpRoot: string;
  private readonly metaCache = new Map<string, StoredMeta | null>();
  private static readonly META_CACHE_MAX = 8192;

  constructor(options: FsBucketOptions) {
    this.root = path.resolve(options.root);
    this.rootWithSeparator = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    this.metaRoot = path.resolve(options.metaRoot);
    this.tmpRoot = path.resolve(options.tmpRoot);
  }

  // —— 路径映射 ——

  private absFor(key: string): string {
    assertSafeKey(key);
    return path.join(this.root, ...key.split("/"));
  }

  private metaAbsFor(key: string): string {
    const segments = key
      .split("/")
      .filter((part) => part.length > 0)
      .map((part) =>
        Buffer.byteLength(part) > 200
          ? `h_${crypto.createHash("sha1").update(part).digest("hex")}`
          : part
      );
    return `${path.join(this.metaRoot, ...segments)}.m.json`;
  }

  private async readMeta(key: string): Promise<StoredMeta | null> {
    const metaPath = this.metaAbsFor(key);
    if (this.metaCache.has(metaPath)) return this.metaCache.get(metaPath) ?? null;
    let value: StoredMeta | null = null;
    try {
      value = JSON.parse(await fsp.readFile(metaPath, "utf8")) as StoredMeta;
    } catch {
      value = null;
    }
    if (this.metaCache.size >= FsBucket.META_CACHE_MAX) this.metaCache.clear();
    this.metaCache.set(metaPath, value);
    return value;
  }

  private async writeMeta(key: string, meta: StoredMeta | null): Promise<void> {
    const metaPath = this.metaAbsFor(key);
    if (meta === null) {
      this.metaCache.set(metaPath, null);
      await fsp.rm(metaPath, { force: true });
      return;
    }
    this.metaCache.set(metaPath, meta);
    await fsp.mkdir(path.dirname(metaPath), { recursive: true });
    await fsp.writeFile(metaPath, JSON.stringify(meta), "utf8");
  }

  private async dropMeta(key: string): Promise<void> {
    const metaPath = this.metaAbsFor(key);
    this.metaCache.delete(metaPath);
    await fsp.rm(metaPath, { force: true });
  }

  // —— 对象构造 ——

  private async buildObject(
    key: string,
    stat: Stats,
    options: { withMetadata: boolean; isDir?: boolean }
  ): Promise<FsR2Object> {
    const isDir = options.isDir ?? stat.isDirectory();
    const etag = etagOf(stat);
    const object: FsR2Object = {
      key,
      version: "1",
      size: isDir ? 0 : stat.size,
      etag,
      httpEtag: quote(etag),
      checksums: {},
      uploaded: new Date(stat.mtimeMs),
      storageClass: "Standard",
    };
    if (isDir) {
      // 目录标记：内容类型与 customMetadata 与上游 put 时写入的完全一致，
      // 这样 isCollectionObject() 在本地也返回 true。
      object.size = 0;
      object.httpMetadata = { contentType: "application/x-directory" };
      object.customMetadata = { resourcetype: "<collection />" };
    }
    if (options.withMetadata) {
      const meta = await this.readMeta(key);
      if (meta?.h) {
        object.httpMetadata = isDir
          ? { ...reviveHttpMetadata(meta.h), contentType: "application/x-directory" }
          : reviveHttpMetadata(meta.h);
      }
      if (meta?.c) object.customMetadata = { ...object.customMetadata, ...meta.c };
    }
    return object;
  }

  private async bodyFor(
    key: string,
    object: FsR2Object,
    abs: string,
    range: { start: number; end: number } | null
  ): Promise<FsR2ObjectBody> {
    const stream = createReadStream(
      abs,
      range ? { start: range.start, end: range.end } : undefined
    );
    const web = Readable.toWeb(stream) as unknown as ReadableStream;
    const body: FsR2ObjectBody = {
      ...object,
      body: web,
      bodyUsed: false,
      async arrayBuffer() {
        return new Response(web).arrayBuffer();
      },
      async text() {
        return new Response(web).text();
      },
      async json<T = unknown>() {
        return (await new Response(web).json()) as T;
      },
      async blob() {
        return new Response(web).blob();
      },
      writeHttpMetadata(headers: Headers) {
        writeHttpMetadata(headers, object);
      },
    };
    if (range) {
      body.range = { offset: range.start, length: range.end - range.start + 1 };
    } else if (object.size === 0) {
      body.range = undefined;
    }
    return body;
  }

  private async statOrNull(abs: string): Promise<Stats | null> {
    try {
      return await fsp.stat(abs);
    } catch {
      return null;
    }
  }

  // —— 条件请求 ——

  private async conditionalPasses(
    condition: R2Conditional | Headers | undefined,
    current: Stats | null,
    key: string
  ): Promise<boolean> {
    if (!condition) return true;
    const parsed = condition instanceof Headers ? conditionFromHeaders(condition) : condition;
    const etag = current ? etagOf(current) : null;

    const matches = (candidate: string): boolean => {
      if (candidate === "*") return true;
      return unquote(candidate) === etag;
    };

    if (parsed.etagMatches !== undefined) {
      if (current === null) return false;
      if (!matches(parsed.etagMatches)) return false;
    }
    if (parsed.etagDoesNotMatch !== undefined) {
      if (current !== null && matches(parsed.etagDoesNotMatch)) return false;
    }
    if (parsed.uploadedBefore) {
      if (current === null) return false;
      if (!(current.mtimeMs <= parsed.uploadedBefore.getTime())) return false;
    }
    if (parsed.uploadedAfter) {
      if (current === null) return false;
      if (!(current.mtimeMs > parsed.uploadedAfter.getTime())) return false;
    }
    return true;
  }

  // —— 列举 ——

  /**
   * 按 R2 的键序（UTF-8 字节序）遍历一棵子树。
   *
   * 这里必须做「多路归并」而不是普通 DFS，原因是目录在 Davflare 里是一个
   * **不带尾斜杠的标记键**：同级里 dir `b` 的键是 `b`，而它的子树键是 `b/...`。
   * 于是 `b` < `b.txt` < `b/c.txt` —— 子树键会夹在同级文件之间。
   * 普通 DFS 会把整棵子树插在同级文件之前，顺序就错了（分页游标也会跟着错）。
   *
   * 做法：每个子项一个「游标」，目录先给出自己的标记键，之后从子树迭代器取下一个键；
   * 用小顶堆按当前键取最小，得到的就是精确的全局键序。整个过程是惰性的。
   */
  private async *walkSorted(
    dirAbs: string,
    keyPrefix: string
  ): AsyncGenerator<{ key: string; isDir: boolean; abs: string }> {
    const children = await readSortedChildren(dirAbs);
    if (children.length === 0) return;

    const heap = new MinHeap<WalkSource>((a, b) => byteCompare(a.key, b.key));
    for (const child of children) {
      heap.push({
        key: keyPrefix ? `${keyPrefix}/${child.name}` : child.name,
        // isDir 描述「当前这个键」是什么；childIsDir 描述「这个数据源本身」是什么。
        // 两者必须分开：目录数据源在发出文件条目后仍要继续读它的子树。
        isDir: child.isDirectory(),
        childIsDir: child.isDirectory(),
        abs: path.join(dirAbs, child.name),
        iter: null,
      });
    }

    while (heap.size > 0) {
      const source = heap.pop()!;
      yield { key: source.key, isDir: source.isDir, abs: source.abs };

      if (!source.childIsDir) continue; // 普通文件数据源：一个键，出完即止

      // 目录数据源：首次弹出时标记键刚发出去，这里把子树接上
      source.iter ??= new Peekable(this.walkSorted(source.abs, source.key));
      const next = await source.iter.next();
      if (next === undefined) continue;

      source.key = next.key;
      source.isDir = next.isDir;
      source.abs = next.abs;
      heap.push(source);
    }
  }

  /** 只列一层：用于带分隔符的列举（目录标记 + 分隔前缀） */
  private async listShallow(
    dirAbs: string,
    prefix: string
  ): Promise<Array<{ key: string; isDir: boolean; abs: string; hasEntries: boolean }>> {
    const children = await readSortedChildren(dirAbs);
    const out: Array<{ key: string; isDir: boolean; abs: string; hasEntries: boolean }> = [];
    for (const child of children) {
      const abs = path.join(dirAbs, child.name);
      const isDir = child.isDirectory();
      out.push({
        key: prefix ? `${prefix}/${child.name}` : child.name,
        isDir,
        abs,
        hasEntries: isDir ? (await readSortedChildren(abs)).length > 0 : false,
      });
    }
    return out;
  }

  private startDirFor(prefix: string): { abs: string; keyPrefix: string } {
    // 前缀可能截断在文件名中间（R2 的 prefix 是纯字符串前缀），
    // 因此从 prefix 的父目录开始遍历，再用 startsWith 过滤。
    const slash = prefix.lastIndexOf("/");
    if (slash < 0) return { abs: this.root, keyPrefix: "" };
    const dirKey = prefix.slice(0, slash);
    try {
      assertSafeKey(dirKey || "x");
    } catch {
      return { abs: this.root, keyPrefix: "" };
    }
    return {
      abs: path.join(this.root, ...dirKey.split("/")),
      keyPrefix: dirKey,
    };
  }

  private decodeCursor(cursor: string | undefined): string | null {
    if (!cursor) return null;
    try {
      const decoded = Buffer.from(cursor, "base64").toString("utf8");
      return decoded.length > 0 ? decoded : null;
    } catch {
      return null;
    }
  }

  private after(cursorKey: string | null, startAfter: string | undefined, key: string): boolean {
    // true 表示该键在游标之后，应当返回。
    // 必须用 UTF-8 字节序比较，才能和 walkSorted() 的排序以及 R2 的顺序一致
    // （JS 默认的字符串比较是 UTF-16 码元序，中文文件名下会错位）。
    if (startAfter !== undefined && byteCompare(key, startAfter) <= 0) return false;
    if (cursorKey === null) return true;
    if (cursorKey.endsWith("/")) {
      // 游标是「分隔前缀」，含义是：它自己、它前面的一切、以及它的整棵子树都已翻过。
      // 三个条件缺一不可：
      //   1) 标记键（去掉尾斜杠）已发过——它不以 cursorKey 开头，容易漏
      //   2) 子树键已随前缀一起跳过
      //   3) 排在它前面的键也必须跳过，否则翻页会回到这一页的开头
      if (key === cursorKey.slice(0, -1)) return false;
      if (key.startsWith(cursorKey)) return false;
      return byteCompare(key, cursorKey) > 0;
    }
    return byteCompare(key, cursorKey) > 0;
  }

  async list(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
    delimiter?: string;
    startAfter?: string;
    include?: string[];
  }): Promise<FsR2Objects> {
    const prefix = options?.prefix ?? "";
    const delimiter = options?.delimiter;
    const limit = options?.limit && options.limit > 0 ? options.limit : DEFAULT_LIST_LIMIT;
    const includeMetadata = (options?.include ?? []).some((value) =>
      typeof value === "string" ? value.includes("Metadata") : false
    );
    const cursorKey = this.decodeCursor(options?.cursor);
    const startAfter = options?.startAfter;
    const delimited = delimiter === "/";

    const objects: FsR2Object[] = [];
    const delimitedPrefixes: string[] = [];
    let truncated = false;
    let nextCursor: string | undefined;
    let emitted = 0;
    let lastEmittedKey: string | null = null;

    const emit = async (key: string, abs: string, isDir: boolean): Promise<boolean> => {
      const stat = await this.statOrNull(abs);
      if (stat === null) return false;
      if (isDir && await this.isPendingDirRemoval(key)) {
        // 标记已删除的目录不再作为对象出现，只会以 delimitedPrefix 的形式出现
        return false;
      }
      objects.push(
        await this.buildObject(key, stat, { withMetadata: includeMetadata, isDir })
      );
      return true;
    };

    const { abs: startAbs, keyPrefix } = this.startDirFor(prefix);

    if (delimited) {
      for (const child of await this.listShallow(startAbs, keyPrefix)) {
        if (!child.key.startsWith(prefix)) continue;
        // 标记对象与分隔前缀要**各自**判断游标：翻页可能正好落在两者之间，
        // 此时标记已发过但前缀还没发，不能一起跳过。
        if (this.after(cursorKey, startAfter, child.key)) {
          if (emitted >= limit) {
            truncated = true;
            break;
          }
          // 目录标记对象：与 R2 一致，目录同时以「标记对象」和「分隔前缀」出现，
          // 上层的 list.ts 会把两者合并成同一个目录条目（并保留修改时间）。
          // 游标按「扫过哪」推进，而不是「发出了哪」—— emit 可能因目录标记已被删除
          // 而跳过，如果把游标留在上一条，翻页会重复扫到同一段甚至丢条目。
          lastEmittedKey = child.key;
          if (await emit(child.key, child.abs, child.isDir)) emitted += 1;
        }
        if (child.isDir && child.hasEntries) {
          const groupKey = `${child.key}/`;
          if (!this.after(cursorKey, startAfter, groupKey)) continue;
          if (emitted >= limit) {
            truncated = true;
            break;
          }
          delimitedPrefixes.push(groupKey);
          emitted += 1;
          lastEmittedKey = groupKey;
        }
      }
    } else {
      for await (const entry of this.walkSorted(startAbs, keyPrefix)) {
        if (!entry.key.startsWith(prefix)) continue;
        if (!this.after(cursorKey, startAfter, entry.key)) continue;
        if (emitted >= limit) {
          truncated = true;
          break;
        }
        lastEmittedKey = entry.key;
        if (await emit(entry.key, entry.abs, entry.isDir)) emitted += 1;
      }
    }

    if (truncated && lastEmittedKey !== null) {
      nextCursor = Buffer.from(lastEmittedKey, "utf8").toString("base64");
    } else {
      nextCursor = undefined;
    }

    return {
      objects,
      truncated,
      delimitedPrefixes,
      ...(nextCursor ? { cursor: nextCursor } : {}),
    };
  }

  // —— 基本操作 ——

  async head(
    key: string,
    options?: { onlyIf?: R2Conditional | Headers }
  ): Promise<FsR2Object | null> {
    const abs = this.absFor(key);
    const stat = await this.statOrNull(abs);
    if (stat === null) return null;
    if (stat.isDirectory() && await this.isPendingDirRemoval(key)) {
      // 标记已被删除、只是目录还当着子键的容器：对 R2 而言这个键不存在
      // （目录仍会以 delimitedPrefix 的形式出现，与 R2 的「虚拟目录」一致）
      return null;
    }
    if (!(await this.conditionalPasses(options?.onlyIf, stat, key))) return null;
    return this.buildObject(key, stat, { withMetadata: true });
  }

  async get(
    key: string,
    options?: { onlyIf?: R2Conditional | Headers; range?: R2Range | Headers }
  ): Promise<FsR2ObjectBody | FsR2Object | null> {
    const abs = this.absFor(key);
    const stat = await this.statOrNull(abs);
    if (stat === null) return null;
    if (stat.isDirectory() && await this.isPendingDirRemoval(key)) return null;

    // 条件不满足：返回**无 body** 的元数据对象，上游据此回 412
    if (!(await this.conditionalPasses(options?.onlyIf, stat, key))) {
      return this.buildObject(key, stat, { withMetadata: true });
    }

    const object = await this.buildObject(key, stat, { withMetadata: true });
    if (stat.isDirectory()) {
      // 目录标记是 0 字节对象（与 R2 中的标记对象一致）。
      // 注意 new Response(null).body 是 null，这里要用 0 长度字节体拿到真正的流。
      const empty = new Response(new Uint8Array(0)).body as ReadableStream;
      return {
        ...object,
        body: empty,
        bodyUsed: false,
        async arrayBuffer() {
          return new ArrayBuffer(0);
        },
        async text() {
          return "";
        },
        async json<T = unknown>() {
          return {} as T;
        },
        async blob() {
          return new Blob([]);
        },
        writeHttpMetadata(headers: Headers) {
          writeHttpMetadata(headers, object);
        },
      };
    }

    const range = resolveRange(options?.range, stat.size);
    return this.bodyFor(key, object, abs, range);
  }

  async put(
    key: string,
    value: R2PutValue,
    options?: {
      httpMetadata?: R2HttpMetadata | Headers;
      customMetadata?: Record<string, string>;
      onlyIf?: R2Conditional | Headers;
    }
  ): Promise<FsR2Object | null> {
    const abs = this.absFor(key);
    const existing = await this.statOrNull(abs);

    if (options?.onlyIf && !(await this.conditionalPasses(options.onlyIf, existing, key))) {
      return null;
    }

    const httpMetadata = normalizeHttpMetadata(options?.httpMetadata);
    const customMetadata = options?.customMetadata;
    // 「目录标记」判定：正文为空，或调用方在元数据里显式声明了集合。
    // 后者很关键：目录整体移动（moveDirectory）会把 marker 的 **body**（一个空流）
    // 连同 httpMetadata 一起 put 到新键上——空流无法被判为空值，
    // 只看正文会走到「写文件」分支，撞上已经建好的同名目录而 500。
    const declaredCollection =
      httpMetadata?.contentType === "application/x-directory" ||
      customMetadata?.resourcetype === "<collection />";
    const isMarkerValue = isEmptyValue(value) || declaredCollection;
    if (isMarkerValue) {
      // 目录标记 / 空对象：创建真目录，并记录上游写入的元数据
      if (existing !== null && !existing.isDirectory()) {
        throw new Error(`同名文件已存在，无法创建目录：${key}`);
      }
      await fsp.mkdir(abs, { recursive: true });
      if (httpMetadata || customMetadata) {
        await this.writeMeta(key, {
          ...(httpMetadata ? { h: serializeHttpMetadata(httpMetadata) } : {}),
          ...(customMetadata ? { c: customMetadata } : {}),
        });
      }
      const stat = await this.statOrNull(abs);
      if (stat === null) throw new Error(`failed to create directory for key ${key}`);
      return this.buildObject(key, stat, { withMetadata: true });
    }

    if (existing !== null && existing.isDirectory()) {
      throw new Error(`同名目录已存在，无法写入文件：${key}`);
    }
    try {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
    } catch (error) {
      // 路径中间有同名文件（例如已有文件 `a`，又要写 `a/b.txt`）。
      // R2 里两者互不干扰，但文件系统上无法共存 —— 这是本方案唯一的固有限制，
      // 给一个能直接看懂的报错，而不是把 ENOTDIR 抛给上层变成 500。
      throw new Error(
        `路径中的某一级已被同名文件占用，无法写入 ${key}：${(error as Error).message}`
      );
    }
    const tmpPath = path.join(
      path.dirname(abs),
      `${TMP_PREFIX}${crypto.randomBytes(8).toString("hex")}`
    );
    try {
      await writeValueToFile(value, tmpPath);
      await fsp.rename(tmpPath, abs);
    } catch (error) {
      await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
      throw error;
    }

    if (httpMetadata || customMetadata) {
      await this.writeMeta(key, {
        ...(httpMetadata ? { h: serializeHttpMetadata(httpMetadata) } : {}),
        ...(customMetadata ? { c: customMetadata } : {}),
      });
    } else if (existing === null) {
      // 新文件且无元数据：清掉可能残留的旧记录
      await this.dropMeta(key);
    }

    const stat = await this.statOrNull(abs);
    if (stat === null) throw new Error(`failed to write key ${key}`);
    return this.buildObject(key, stat, { withMetadata: true });
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) {
      const abs = this.absFor(key);
      const stat = await this.statOrNull(abs);
      if (stat === null) {
        await this.dropMeta(key);
        continue;
      }
      if (stat.isDirectory()) {
        // 目录标记：R2 里删标记不影响已存在的子键。文件系统上目录必须留着当容器，
        // 所以「空 → 直接删」；「非空 → 记下待清理意图，等子键删完再删」。
        // 上游多处（deleteDirectory / moveDirectory / softDeleteKeys）都是
        // 先删标记、再删子键，靠这个标记才能最终把目录清干净。
        if (await this.tryRmdir(abs)) {
          await this.dropMeta(key);
        } else {
          await this.writeMeta(key, { p: 1 });
        }
        await this.prunePendingEmptyAncestors(path.dirname(abs));
      } else {
        await fsp.rm(abs, { force: true });
        await this.dropMeta(key);
        await this.prunePendingEmptyAncestors(path.dirname(abs));
      }
    }
  }

  /** 该目录的标记已被删除、只是还当着子键的容器 */
  private async isPendingDirRemoval(key: string): Promise<boolean> {
    const meta = await this.readMeta(key);
    return meta?.p === 1;
  }

  /** 只删空目录；非空（ENOTEMPTY）返回 false，不抛错 */
  private async tryRmdir(abs: string): Promise<boolean> {
    try {
      await fsp.rmdir(abs);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 自底向上清理「待移除」的空目录。
   *
   * 只在目录带着 p 标记（即我们明确删过它的目录标记）且已经变空时才移除，
   * 碰到没有 p 标记的目录立即停止 —— 外部程序建的普通空目录不受影响。
   */
  private async prunePendingEmptyAncestors(startDir: string): Promise<void> {
    let dir = startDir;
    while (dir !== this.root && dir.startsWith(this.rootWithSeparator)) {
      const rel = path.relative(this.root, dir).split(path.sep).join("/");
      if (!rel) break;
      const meta = await this.readMeta(rel);
      if (!meta?.p) break;
      if (!(await this.tryRmdir(dir))) break;
      await this.dropMeta(rel);
      dir = path.dirname(dir);
    }
  }

  // —— 分块上传 ——

  async createMultipartUpload(
    key: string,
    options?: {
      httpMetadata?: R2HttpMetadata | Headers;
      customMetadata?: Record<string, string>;
    }
  ): Promise<FsMultipartUpload> {
    assertSafeKey(key);
    const uploadId = crypto.randomUUID();
    const dir = path.join(this.tmpRoot, uploadId);
    await fsp.mkdir(dir, { recursive: true });
    const httpMetadata = normalizeHttpMetadata(options?.httpMetadata);
    await fsp.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        key,
        httpMetadata: httpMetadata ? serializeHttpMetadata(httpMetadata) : null,
        customMetadata: options?.customMetadata ?? null,
        createdAt: new Date().toISOString(),
      }),
      "utf8"
    );
    return new FsMultipartUpload(this, key, uploadId, dir);
  }

  /**
   * 必须与平台一致：真实 R2 的 `resumeMultipartUpload` 是**同步**返回 R2MultipartUpload 的
   * （只有 `createMultipartUpload` 返回 Promise）。上游多处直接写
   * `bucket.resumeMultipartUpload(...).uploadPart(...)` 而不 await，
   * 这里若声明成 async 会把 Promise 交给调用方，`.uploadPart` 就是 undefined。
   * 参考实现见 upstream/src/app/testInMemoryBucket.ts:479。
   */
  resumeMultipartUpload(key: string, uploadId: string): FsMultipartUpload {
    assertSafeKey(key);
    if (!/^[0-9a-fA-F-]{8,64}$/.test(uploadId)) {
      throw new Error("invalid uploadId");
    }
    const dir = path.join(this.tmpRoot, uploadId);
    return new FsMultipartUpload(this, key, uploadId, dir);
  }

  /** 内部使用：分块上传完成时按 partNumber 顺序流式拼接落盘 */
  async putFromParts(
    key: string,
    partPaths: string[],
    meta: { httpMetadata: SerializedHttpMetadata | null; customMetadata: Record<string, string> | null }
  ): Promise<FsR2Object> {
    const abs = this.absFor(key);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const tmpPath = path.join(
      path.dirname(abs),
      `${TMP_PREFIX}${crypto.randomBytes(8).toString("hex")}`
    );
    // 逐块顺序写入同一个 fd，边读边写、不做全量缓冲，
    // 因此分块上传的总大小不受内存限制（上游单块 ≤10 MiB，块数不限）。
    const handle = await fsp.open(tmpPath, "w");
    try {
      for (const partPath of partPaths) {
        const input = createReadStream(partPath, { highWaterMark: 1 << 20 });
        // eslint-disable-next-line no-await-in-loop
        for await (const chunk of input) {
          // eslint-disable-next-line no-await-in-loop
          await handle.write(chunk as Buffer);
        }
      }
      await handle.close();
      await fsp.rename(tmpPath, abs);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
      throw error;
    }

    if (meta.httpMetadata || meta.customMetadata) {
      await this.writeMeta(key, {
        ...(meta.httpMetadata ? { h: meta.httpMetadata } : {}),
        ...(meta.customMetadata ? { c: meta.customMetadata } : {}),
      });
    }
    const stat = await this.statOrNull(abs);
    if (stat === null) throw new Error(`failed to assemble key ${key}`);
    return this.buildObject(key, stat, { withMetadata: true });
  }
}

export class FsMultipartUpload {
  constructor(
    private readonly bucket: FsBucket,
    public readonly key: string,
    public readonly uploadId: string,
    private readonly dir: string
  ) {}

  async uploadPart(
    partNumber: number,
    value: R2PutValue
  ): Promise<FsR2UploadedPart> {
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
      throw new Error("partNumber must be an integer between 1 and 10000");
    }
    await fsp.mkdir(this.dir, { recursive: true });
    const partPath = path.join(this.dir, `${String(partNumber).padStart(5, "0")}.part`);
    try {
      await writeValueToFile(value, partPath, { atomic: false });
    } catch (error) {
      throw new Error(`failed to store part ${partNumber}: ${(error as Error).message}`);
    }
    // 流式求 MD5，避免把整块读进内存
    const hash = crypto.createHash("md5");
    for await (const chunk of createReadStream(partPath, { highWaterMark: 1 << 20 })) {
      hash.update(chunk as Buffer);
    }
    return { partNumber, etag: hash.digest("hex") };
  }

  async complete(parts: FsR2UploadedPart[]): Promise<FsR2Object> {
    let manifest: {
      key: string;
      httpMetadata: SerializedHttpMetadata | null;
      customMetadata: Record<string, string> | null;
    };
    try {
      manifest = JSON.parse(await fsp.readFile(path.join(this.dir, "manifest.json"), "utf8"));
    } catch {
      throw new Error("uploadId not found or already completed");
    }

    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const partPaths: string[] = [];
    for (const part of ordered) {
      const partPath = path.join(this.dir, `${String(part.partNumber).padStart(5, "0")}.part`);
      const stat = await fsp.stat(partPath).catch(() => null);
      if (stat === null) {
        throw new Error(`part ${part.partNumber} has not been uploaded`);
      }
      partPaths.push(partPath);
    }

    try {
      return await this.bucket.putFromParts(manifest.key || this.key, partPaths, {
        httpMetadata: manifest.httpMetadata,
        customMetadata: manifest.customMetadata,
      });
    } finally {
      await fsp.rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async abort(): Promise<void> {
    await fsp.rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// —— 元数据序列化 ——

interface SerializedHttpMetadata {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  cacheExpiry?: string;
}

interface StoredMeta {
  h?: SerializedHttpMetadata;
  c?: Record<string, string>;
  /**
   * 「目录标记已被删除，但目录里还有子键」的待清理标记。
   * R2 里删目录标记不影响子键；文件系统上目录得留着当容器，
   * 所以要记住这个意图，等目录变空时再移除。
   * 只有我们自己写下的这个标记才会触发自动清理 ——
   * 外部程序（SMB / 飞牛文件管理器）建的普通空目录不会被顺手删掉。
   */
  p?: 1;
}

function serializeHttpMetadata(meta: R2HttpMetadata): SerializedHttpMetadata {
  const out: SerializedHttpMetadata = {};
  if (meta.contentType) out.contentType = meta.contentType;
  if (meta.contentLanguage) out.contentLanguage = meta.contentLanguage;
  if (meta.contentDisposition) out.contentDisposition = meta.contentDisposition;
  if (meta.contentEncoding) out.contentEncoding = meta.contentEncoding;
  if (meta.cacheControl) out.cacheControl = meta.cacheControl;
  if (meta.cacheExpiry) out.cacheExpiry = meta.cacheExpiry.toISOString();
  return out;
}

function reviveHttpMetadata(meta: SerializedHttpMetadata): R2HttpMetadata {
  const out: R2HttpMetadata = {};
  if (meta.contentType) out.contentType = meta.contentType;
  if (meta.contentLanguage) out.contentLanguage = meta.contentLanguage;
  if (meta.contentDisposition) out.contentDisposition = meta.contentDisposition;
  if (meta.contentEncoding) out.contentEncoding = meta.contentEncoding;
  if (meta.cacheControl) out.cacheControl = meta.cacheControl;
  if (meta.cacheExpiry) out.cacheExpiry = new Date(meta.cacheExpiry);
  return out;
}

/**
 * 上游把 `uploadHttpMetadata()` 返回的 **Headers** 直接当 httpMetadata 传进来
 * （见 functions/webdav/davUtil.ts），这里统一归一化成对象。
 */
function normalizeHttpMetadata(
  input: R2HttpMetadata | Headers | undefined
): R2HttpMetadata | undefined {
  if (!input) return undefined;
  if (input instanceof Headers) {
    const out: R2HttpMetadata = {};
    const contentType = input.get("Content-Type");
    if (contentType) out.contentType = contentType;
    const contentLanguage = input.get("Content-Language");
    if (contentLanguage) out.contentLanguage = contentLanguage;
    const contentDisposition = input.get("Content-Disposition");
    if (contentDisposition) out.contentDisposition = contentDisposition;
    const contentEncoding = input.get("Content-Encoding");
    if (contentEncoding) out.contentEncoding = contentEncoding;
    const cacheControl = input.get("Cache-Control");
    if (cacheControl) out.cacheControl = cacheControl;
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return input;
}

function writeHttpMetadata(headers: Headers, object: FsR2Object): void {
  const meta = object.httpMetadata;
  if (meta?.contentType) headers.set("Content-Type", meta.contentType);
  if (meta?.contentLanguage) headers.set("Content-Language", meta.contentLanguage);
  if (meta?.contentDisposition) headers.set("Content-Disposition", meta.contentDisposition);
  if (meta?.contentEncoding) headers.set("Content-Encoding", meta.contentEncoding);
  if (meta?.cacheControl) headers.set("Cache-Control", meta.cacheControl);
  if (meta?.cacheExpiry) headers.set("Expires", meta.cacheExpiry.toUTCString());
  // Cloudflare 的 writeHttpMetadata 会带上全量 Content-Length，
  // 上游 /share 的 Range 分支依赖这一点后再覆盖（见 share/[[token]].ts）。
  headers.set("Content-Length", String(object.size));
}

/**
 * 把 Headers 形式的条件头转成 R2Conditional。
 * 上游 WebDAV 会把 `getConditionalHeaders()` 的 Headers 直接当 onlyIf 传。
 */
export function conditionFromHeaders(headers: Headers): R2Conditional {
  const out: R2Conditional = {};
  const ifMatch = headers.get("If-Match");
  if (ifMatch) out.etagMatches = ifMatch.split(",")[0]!.trim();
  const ifNoneMatch = headers.get("If-None-Match");
  if (ifNoneMatch) out.etagDoesNotMatch = ifNoneMatch.split(",")[0]!.trim();
  const ifUnmodifiedSince = headers.get("If-Unmodified-Since");
  if (ifUnmodifiedSince) {
    const date = new Date(ifUnmodifiedSince);
    if (!Number.isNaN(date.getTime())) out.uploadedBefore = date;
  }
  const ifModifiedSince = headers.get("If-Modified-Since");
  if (ifModifiedSince) {
    const date = new Date(ifModifiedSince);
    if (!Number.isNaN(date.getTime())) out.uploadedAfter = date;
  }
  return out;
}

/** 解析 Range 选项（对象形式或 Headers 形式），返回字节区间；不可满足时抛错 */
export function resolveRange(
  range: R2Range | Headers | undefined,
  size: number
): { start: number; end: number } | null {
  if (!range) return null;
  if (range instanceof Headers) {
    const header = range.get("Range") ?? range.get("range");
    if (!header) return null;
    return parseRangeHeader(header, size);
  }
  if (typeof range.suffix === "number") {
    if (size === 0) throw new RangeNotSatisfiableError();
    const length = Math.min(range.suffix, size);
    if (length <= 0) throw new RangeNotSatisfiableError();
    return { start: size - length, end: size - 1 };
  }
  const offset = range.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) throw new RangeNotSatisfiableError();
  if (offset >= size) throw new RangeNotSatisfiableError();
  const length = range.length ?? size - offset;
  if (!Number.isInteger(length) || length <= 0) throw new RangeNotSatisfiableError();
  if (offset + length > size) throw new RangeNotSatisfiableError();
  return { start: offset, end: offset + length - 1 };
}

function parseRangeHeader(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(.+)$/i.exec(header.trim());
  if (!match) return null; // 非 bytes 单位：按 R2 行为忽略
  const spec = match[1]!.split(",")[0]!.trim();
  if (size === 0) throw new RangeNotSatisfiableError();
  const suffixMatch = /^-(\d+)$/.exec(spec);
  if (suffixMatch) {
    const suffix = Number(suffixMatch[1]);
    if (!Number.isFinite(suffix) || suffix <= 0) throw new RangeNotSatisfiableError();
    const length = Math.min(suffix, size);
    return { start: size - length, end: size - 1 };
  }
  const offsetMatch = /^(\d+)-(\d*)$/.exec(spec);
  if (!offsetMatch) throw new RangeNotSatisfiableError();
  const start = Number(offsetMatch[1]);
  if (!Number.isFinite(start) || start >= size) throw new RangeNotSatisfiableError();
  const end = offsetMatch[2] ? Number(offsetMatch[2]) : size - 1;
  if (!Number.isFinite(end) || end < start) throw new RangeNotSatisfiableError();
  return { start, end: Math.min(end, size - 1) };
}

function isEmptyValue(value: R2PutValue): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.length === 0;
  if (ArrayBuffer.isView(value)) return value.byteLength === 0;
  if (value instanceof ArrayBuffer) return value.byteLength === 0;
  if (value instanceof Blob) return value.size === 0;
  return false;
}

async function writeValueToFile(
  value: R2PutValue,
  target: string,
  options?: { atomic?: boolean }
): Promise<void> {
  const explicit = value ?? new Uint8Array();
  if (typeof explicit === "string") {
    await fsp.writeFile(target, explicit, "utf8");
    return;
  }
  if (ArrayBuffer.isView(explicit)) {
    await fsp.writeFile(target, explicit as unknown as Uint8Array);
    return;
  }
  if (explicit instanceof ArrayBuffer) {
    await fsp.writeFile(target, new Uint8Array(explicit));
    return;
  }
  const stream =
    explicit instanceof Blob
      ? explicit.stream()
      : explicit instanceof Request
        ? (explicit.body ?? new Response(null).body!)
        : (explicit as ReadableStream);
  const nodeReadable = Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0]);
  // 流式落盘：单文件大小不受内存限制
  const out = createWriteStream(target);
  await pipeline(nodeReadable, out);
}
