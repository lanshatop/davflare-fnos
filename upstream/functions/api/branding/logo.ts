/**
 * GET /api/branding/logo —— 公开返回用户自定义的 Logo 图片。
 * 未自定义时 404，前端回退到默认的 /favicon.png。
 */

import { readBranding } from "../../_branding";

interface BrandingEnv {
  BUCKET: R2Bucket;
}

export const onRequestGet: PagesFunction<BrandingEnv> = async (context) => {
  const { env } = context;
  const brand = await readBranding(env.BUCKET);
  if (!brand.logoKey) return new Response("Not Found", { status: 404 });
  const object = await env.BUCKET.get(brand.logoKey);
  if (object === null) return new Response("Not Found", { status: 404 });
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      // 改 logo 后要立即生效，不能吃缓存
      "Cache-Control": "no-cache",
    },
  });
};
