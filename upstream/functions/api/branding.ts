/**
 * 品牌自定义 API（NAS 自托管需求）。
 *
 *  - GET    /api/branding        公开：登录页/分享页在未登录时就要读取
 *  - PUT    /api/branding        管理员（session 或 API 密钥）：multipart 更新名称/logo
 *  - DELETE /api/branding        管理员：恢复默认（清除名称与 logo）
 *
 * Logo 图片本体走 GET /api/branding/logo（见同目录 logo.ts）。
 */

import {
  BRANDING_CONFIG_KEY,
  BRANDING_LOGO_MAX_BYTES,
  BRANDING_LOGO_PREFIX,
  BRANDING_NAME_MAX,
  DEFAULT_BRAND_NAME,
  logoExtensionFor,
  readBranding,
} from "../_branding";
import { isSessionOrKeyAuthorized, jsonResponse, textResponse } from "./_apikey";

interface BrandingEnv {
  BUCKET: R2Bucket;
  WEBDAV_USERNAME: string;
  WEBDAV_PASSWORD: string;
}

export const onRequestGet: PagesFunction<BrandingEnv> = async (context) => {
  const brand = await readBranding(context.env.BUCKET);
  return jsonResponse({
    name: brand.name,
    defaultName: DEFAULT_BRAND_NAME,
    hasCustomLogo: brand.logoKey !== null,
    logoUrl: brand.logoKey ? "/api/branding/logo" : null,
  });
};

export const onRequestPut: PagesFunction<BrandingEnv> = async (context) => {
  const { request, env } = context;
  if (
    !(await isSessionOrKeyAuthorized(
      request,
      env.BUCKET,
      env.WEBDAV_USERNAME,
      env.WEBDAV_PASSWORD
    ))
  ) {
    return textResponse("Unauthorized", 401);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return textResponse("无法解析上传内容", 400);
  }

  const current = await readBranding(env.BUCKET);

  // name 字段未提供 = 保持不变；提供了（含空串）= 覆盖（空串恢复默认名）
  let name = current.name;
  const nameInput = form.get("name");
  if (typeof nameInput === "string") {
    const trimmed = nameInput.trim().slice(0, BRANDING_NAME_MAX);
    name = trimmed || null;
  }

  // logo 文件未提供 = 保持不变；clearLogo=1 且未提供新文件 = 移除
  let logoKey = current.logoKey;
  const clearLogo = form.get("clearLogo") === "1";
  const logo = form.get("logo");
  if (logo instanceof File && logo.size > 0) {
    if (logo.size > BRANDING_LOGO_MAX_BYTES) {
      return textResponse("Logo 图片需小于 2MB", 413);
    }
    const ext = logoExtensionFor(logo.type || "");
    if (!ext) {
      return textResponse("仅支持 PNG / JPEG / GIF / WebP / SVG / ICO 图片", 415);
    }
    const nextKey = BRANDING_LOGO_PREFIX + ext;
    if (logoKey && logoKey !== nextKey) {
      await env.BUCKET.delete(logoKey);
    }
    await env.BUCKET.put(nextKey, await logo.arrayBuffer(), {
      httpMetadata: { contentType: logo.type.toLowerCase() },
    });
    logoKey = nextKey;
  } else if (clearLogo && logoKey) {
    await env.BUCKET.delete(logoKey);
    logoKey = null;
  }

  await env.BUCKET.put(BRANDING_CONFIG_KEY, JSON.stringify({ name, logoKey }), {
    httpMetadata: { contentType: "application/json" },
  });

  return jsonResponse({ name, hasCustomLogo: logoKey !== null });
};

export const onRequestDelete: PagesFunction<BrandingEnv> = async (context) => {
  const { request, env } = context;
  if (
    !(await isSessionOrKeyAuthorized(
      request,
      env.BUCKET,
      env.WEBDAV_USERNAME,
      env.WEBDAV_PASSWORD
    ))
  ) {
    return textResponse("Unauthorized", 401);
  }
  const current = await readBranding(env.BUCKET);
  if (current.logoKey) await env.BUCKET.delete(current.logoKey);
  await env.BUCKET.delete(BRANDING_CONFIG_KEY);
  return jsonResponse({ name: null, hasCustomLogo: false });
};
