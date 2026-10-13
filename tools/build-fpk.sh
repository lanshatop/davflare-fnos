#!/usr/bin/env bash
#
# 一键构建 Davflare 飞牛 fpk
#
# 用法（在仓库根目录 davflare-fnos/ 下执行）：
#   bash tools/build-fpk.sh
#
# 前置条件：
#   * Node.js >= 20（用于构建前端与后端产物）
#   * 飞牛官方 fnpack 1.2.3 在 PATH 中（或通过 FNPACK 环境变量指定）
#   * 已执行过 npm install（upstream/ 与 runtime/ 各一次）
#
# 产物：davflare/davflare.fpk
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM="${ROOT}/upstream"
RUNTIME="${ROOT}/runtime"
PKG="${ROOT}/davflare"

FNPACK="${FNPACK:-fnpack}"
command -v "${FNPACK}" >/dev/null 2>&1 || {
    echo "错误：找不到 fnpack，请安装飞牛官方 fnpack 1.2.3 或用 FNPACK=/path/to/fnpack 指定。" >&2
    exit 1
}

echo "==> 1/5 构建前端 SPA（upstream/build）"
( cd "${UPSTREAM}" && NODE_ENV=production ./node_modules/.bin/vite build )

echo "==> 2/5 构建后端单文件（runtime/dist/server.cjs）"
( cd "${RUNTIME}" && node build.mjs )

echo "==> 3/5 装入 fpk 工程（app/server + app/www）"
mkdir -p "${PKG}/app/server" "${PKG}/app/www"
cp "${RUNTIME}/dist/server.cjs" "${PKG}/app/server/server.cjs"
rm -rf "${PKG}/app/www"
mkdir -p "${PKG}/app/www"
cp -r "${UPSTREAM}/build/." "${PKG}/app/www/"

echo "==> 4/5 重新生成图标（可选，跳过时沿用现有 PNG）"
if command -v python >/dev/null 2>&1; then
    python "${ROOT}/tools/make_icon.py" || echo "（图标生成失败，沿用现有图标）"
fi

echo "==> 5/5 fnpack build"
( cd "${PKG}" && rm -f davflare.fpk && "${FNPACK}" build )

echo
echo "构建完成：${PKG}/davflare.fpk"
