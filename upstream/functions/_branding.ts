/**
 * 品牌自定义（NAS 自托管需求）：让用户把界面里的 Davflare 名称与云朵 Logo 换成自己的。
 *
 * 存储约定（与其它内部状态一样，都是真实对象）：
 *  - `_$flaredrive$/branding.json` —— `{ name: string | null, logoKey: string | null }`
 *    name 为 null 表示沿用默认名；logoKey 为 null 表示沿用默认云朵图
 *  - `_$flaredrive$/branding/logo.<ext>` —— 用户上传的图片（png/jpg/gif/webp/svg/ico）
 *
 * 读取方：
 *  - `GET /api/branding`（公开，登录页在未登录时就要取）
 *  - `GET /api/branding/logo`（公开，返回图片）
 *  - 各服务端直出页面（share/collect/sites/webdav listing）用 readBranding 注入名称
 *  - NAS 运行时另把 `/favicon.png`、`/logo144.png` 覆盖为自定义图（见 runtime/lib/static-assets.ts），
 *    因此所有引用 favicon 的页面无需改动就能换标
 */

export interface Branding {
  /** 自定义名称；null = 沿用默认 */
  name: string | null;
  /** 自定义 logo 对象键；null = 沿用默认 */
  logoKey: string | null;
}

export const DEFAULT_BRAND_NAME = "Davflare";
export const BRANDING_CONFIG_KEY = "_$flaredrive$/branding.json";
export const BRANDING_LOGO_PREFIX = "_$flaredrive$/branding/logo.";
/** 头像级图片，2MB 足够任何 favicon/横幅用途 */
export const BRANDING_LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const BRANDING_NAME_MAX = 40;

const LOGO_TYPES: Array<{ mime: string; ext: string }> = [
  { mime: "image/png", ext: "png" },
  { mime: "image/jpeg", ext: "jpg" },
  { mime: "image/gif", ext: "gif" },
  { mime: "image/webp", ext: "webp" },
  { mime: "image/svg+xml", ext: "svg" },
  { mime: "image/x-icon", ext: "ico" },
  { mime: "image/vnd.microsoft.icon", ext: "ico" },
];

export function logoExtensionFor(contentType: string): string | null {
  const match = LOGO_TYPES.find((t) => t.mime === contentType.toLowerCase().trim());
  return match ? match.ext : null;
}

/** 读品牌配置；任何损坏/缺失都回退默认，绝不影响页面渲染 */
export async function readBranding(bucket: R2Bucket): Promise<Branding> {
  try {
    const data = await bucket.get(BRANDING_CONFIG_KEY);
    if (data === null) return { name: null, logoKey: null };
    const parsed = (await data.json()) as { name?: unknown; logoKey?: unknown };
    const name =
      typeof parsed.name === "string" && parsed.name.trim()
        ? parsed.name.trim().slice(0, BRANDING_NAME_MAX)
        : null;
    // logoKey 就存在内部目录 _$flaredrive$/branding/ 下（与 config.json 同级约定），
    // 不能用 isInternalKey 排除——那个检查是给「用户数据区」用的，这里会把自己过滤掉
    const logoKey =
      typeof parsed.logoKey === "string" && parsed.logoKey.startsWith(BRANDING_LOGO_PREFIX)
        ? parsed.logoKey
        : null;
    return { name, logoKey };
  } catch {
    return { name: null, logoKey: null };
  }
}

/** 展示名：自定义名优先，否则默认 */
export function brandDisplayName(brand: Branding): string {
  return brand.name ?? DEFAULT_BRAND_NAME;
}

function escapeBrandHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 服务端直出页面的品牌头：favicon 由 NAS 端静态层覆盖为自定义 logo，这里只拼名称 */
export function brandMarkHtml(brand: Branding, size = 20): string {
  return `<img src="/favicon.png" alt="" width="${size}" height="${size}">${escapeBrandHtml(brandDisplayName(brand))}`;
}

/** 「页面标题 · 品牌名」的后半段 */
export function brandTitleSuffix(brand: Branding): string {
  return escapeBrandHtml(brandDisplayName(brand));
}
