/**
 * 构建脚本：把运行时 + upstream/functions/** 打包成单个 Node 产物。
 *
 * 产物：
 *   dist/server.cjs   服务端主程序（可直接 node dist/server.cjs）
 *   dist/r2-fs.mjs    R2 兼容层（供测试单独引用）
 *
 * 之所以打成单文件：飞牛 NAS 上只需放一个 js 文件即可运行，
 * 不需要在设备上装 node_modules，也避免依赖被用户误改。
 */

import { build } from "esbuild";
import { rm, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "dist");

const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  sourcemap: true,
  logLevel: "info",
  // Node 内置模块一律外部化
  external: [
    "node:*",
    "fs",
    "path",
    "crypto",
    "stream",
    "stream/promises",
    "http",
    "https",
    "url",
    "util",
    "events",
    "os",
    "zlib",
    "buffer",
    "assert",
    "net",
    "tls",
    "worker_threads",
  ],
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
  },
};

async function main() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  await build({
    ...shared,
    entryPoints: [path.join(here, "server.ts")],
    outfile: path.join(outDir, "server.cjs"),
    format: "cjs",
  });

  await build({
    ...shared,
    entryPoints: [path.join(here, "lib", "r2-fs.ts")],
    outfile: path.join(outDir, "r2-fs.mjs"),
    format: "esm",
  });

  console.log("构建完成 → dist/server.cjs, dist/r2-fs.mjs");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
