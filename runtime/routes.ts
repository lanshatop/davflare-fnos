/**
 * 路由表：把 upstream/functions/** 的处理器按 Pages 的「文件即路由」约定登记下来。
 *
 * 这里显式 import（而不是运行时扫描目录），好处是 esbuild 能静态打包成一个产物，
 * 部署时不需要在 NAS 上带 node_modules 与源码树。
 *
 * 判定规则与 Pages 一致：
 *  - 文件名或目录名以 `_` 开头 → 不是路由（例如 api/_apikey.ts）
 *  - 只有导出了 onRequest / onRequest{Method} 的文件才是路由
 *    （例如 siteIndex.ts / sitePublish.ts 只导出工具函数，不注册）
 *  - `[[xxx]]` 是可选通配，匹配零段或多段，参数为字符串数组
 */

import * as middleware from "../upstream/functions/_middleware";

import * as apiArchive from "../upstream/functions/api/archive";
import * as apiBackup from "../upstream/functions/api/backup";
import * as apiBranding from "../upstream/functions/api/branding";
import * as apiBrandingLogo from "../upstream/functions/api/branding/logo";
import * as apiCollects from "../upstream/functions/api/collects";
import * as apiConfig from "../upstream/functions/api/config";
import * as apiCopy from "../upstream/functions/api/copy";
import * as apiCounts from "../upstream/functions/api/counts";
import * as apiDelete from "../upstream/functions/api/delete";
import * as apiDownload from "../upstream/functions/api/download";
import * as apiImages from "../upstream/functions/api/images";
import * as apiKeys from "../upstream/functions/api/keys";
import * as apiList from "../upstream/functions/api/list";
import * as apiMkdir from "../upstream/functions/api/mkdir";
import * as apiRename from "../upstream/functions/api/rename";
import * as apiSearch from "../upstream/functions/api/search";
import * as apiSetup from "../upstream/functions/api/setup";
import * as apiShares from "../upstream/functions/api/shares";
import * as apiSites from "../upstream/functions/api/sites";
import * as apiStat from "../upstream/functions/api/stat";
import * as apiTrash from "../upstream/functions/api/trash";
import * as apiUpload from "../upstream/functions/api/upload";

import * as collectToken from "../upstream/functions/collect/[[token]]";
import * as mcp from "../upstream/functions/mcp";
import * as shareToken from "../upstream/functions/share/[[token]]";
import * as webdavPath from "../upstream/functions/webdav/[[path]]";

import type { RouteDefinition, RouteHandlers } from "./lib/pages";

function asHandlers(module: unknown): RouteHandlers {
  return module as RouteHandlers;
}

export const middlewareModules: RouteHandlers[] = [asHandlers(middleware)];

export const routes: RouteDefinition[] = [
  // —— 主 API ——
  { pattern: "/api/list", handlers: asHandlers(apiList) },
  { pattern: "/api/stat", handlers: asHandlers(apiStat) },
  { pattern: "/api/download", handlers: asHandlers(apiDownload) },
  { pattern: "/api/upload", handlers: asHandlers(apiUpload) },
  { pattern: "/api/mkdir", handlers: asHandlers(apiMkdir) },
  { pattern: "/api/rename", handlers: asHandlers(apiRename) },
  { pattern: "/api/copy", handlers: asHandlers(apiCopy) },
  { pattern: "/api/delete", handlers: asHandlers(apiDelete) },
  { pattern: "/api/backup", handlers: asHandlers(apiBackup) },
  { pattern: "/api/search", handlers: asHandlers(apiSearch) },
  { pattern: "/api/counts", handlers: asHandlers(apiCounts) },
  { pattern: "/api/archive", handlers: asHandlers(apiArchive) },
  { pattern: "/api/config", handlers: asHandlers(apiConfig) },
  { pattern: "/api/setup", handlers: asHandlers(apiSetup) },
  { pattern: "/api/keys", handlers: asHandlers(apiKeys) },
  { pattern: "/api/shares", handlers: asHandlers(apiShares) },
  { pattern: "/api/trash", handlers: asHandlers(apiTrash) },
  { pattern: "/api/sites", handlers: asHandlers(apiSites) },
  { pattern: "/api/images", handlers: asHandlers(apiImages) },
  { pattern: "/api/collects", handlers: asHandlers(apiCollects) },
  { pattern: "/api/branding", handlers: asHandlers(apiBranding) },
  { pattern: "/api/branding/logo", handlers: asHandlers(apiBrandingLogo) },

  // —— 独立协议端点 ——
  { pattern: "/webdav/[[path]]", handlers: asHandlers(webdavPath) },
  { pattern: "/share/[[token]]", handlers: asHandlers(shareToken) },
  { pattern: "/collect/[[token]]", handlers: asHandlers(collectToken) },
  { pattern: "/mcp", handlers: asHandlers(mcp) },
];
