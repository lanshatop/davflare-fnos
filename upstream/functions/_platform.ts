/**
 * 平台适配层：请求体上限。
 *
 * 上游部署在 Cloudflare Pages Functions 上时，单次请求体约 100MB，
 * 因此服务端在两处「单次直传」路径上做前置校验：
 *   - functions/api/upload.ts    （POST /api/upload 的单次上传）
 *   - functions/webdav/protocol.ts（WebDAV PUT 的单次上传）
 * 分块上传（?uploads / ?uploadId&partNumber）与 MCP / collect 的分块协议不受此限。
 *
 * 自托管运行时（飞牛 fnOS 等）没有这个平台限制，运行时启动时会通过
 * globalThis.__DAVFLARE_MAX_REQUEST_BYTES__ 覆盖本值：
 *   - 未设置 / 非数字 → 保持 Cloudflare 的 100MB（等同于上游默认行为）
 *   - <= 0           → 不限制（只受磁盘容量约束）
 *   - > 0            → 该字节数为上限
 *
 * 之所以用 globalThis 而不是 env 参数：上游这两个检查点分布在辅助函数内部，
 * 逐个改签名会大幅扩大与上游的差异面。globalThis 让上游源文件只多一行 import，
 * 其余逻辑与上游逐字一致。
 */
export const CLOUDFLARE_MAX_REQUEST_BYTES = 100 * 1024 * 1024;

type PlatformHolder = typeof globalThis & {
  __DAVFLARE_MAX_REQUEST_BYTES__?: number;
};

/** 当前运行时允许的最大请求体字节数；Infinity 表示不限制。 */
export function maxRequestBytes(): number {
  const raw = (globalThis as PlatformHolder).__DAVFLARE_MAX_REQUEST_BYTES__;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw <= 0 ? Number.POSITIVE_INFINITY : raw;
  }
  return CLOUDFLARE_MAX_REQUEST_BYTES;
}

/** 该大小的正文是否超过当前上限（Infinity 时恒为 false）。 */
export function exceedsRequestLimit(bytes: number): boolean {
  return bytes >= maxRequestBytes();
}
