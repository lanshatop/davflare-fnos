import {
  createImageId,
  imageMarkdown,
  imageObjectKey,
  imageResponseHeaders,
  isImageId,
  parseImagePath,
  publicImageUrl,
  resolveSitesHostRoute,
} from "../../../functions/_images";

describe("image host keys and ids", () => {
  test("object key stays under the internal prefix, not sites/ or shares", () => {
    expect(imageObjectKey("a".repeat(32))).toBe(
      `_$flaredrive$/img/${"a".repeat(32)}`
    );
    expect(imageObjectKey("a".repeat(32)).startsWith("sites/")).toBe(false);
  });

  test("generated id is unguessable hex, not a filename", () => {
    const id = createImageId();
    expect(isImageId(id)).toBe(true);
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    expect(id.includes("photo")).toBe(false);
  });

  test("public URL prefers the request origin, falls back to https SITES_HOST", () => {
    const id = "ab".repeat(16);
    // 飞牛适配：给了 origin 就用它（自托管只有一个地址，且是明文 HTTP，不能用写死的 https）
    expect(publicImageUrl("sites.example.com", id, "http://10.0.0.5:8087")).toBe(
      `http://10.0.0.5:8087/i/${id}`
    );
    // origin 末尾多余的斜杠会被归一化
    expect(publicImageUrl(null, id, "http://10.0.0.5:8087/")).toBe(
      `http://10.0.0.5:8087/i/${id}`
    );
    // 没有 origin 时保持上游语义（脚本 / 非 HTTP 上下文）
    expect(publicImageUrl("sites.example.com", id)).toBe(
      `https://sites.example.com/i/${id}`
    );
    expect(publicImageUrl(null, id)).toBeNull();
    expect(imageMarkdown("https://sites.example.com/i/abc")).toBe(
      "![](https://sites.example.com/i/abc)"
    );
  });
});

describe("parseImagePath", () => {
  const id = "0123456789abcdef0123456789abcdef";

  test("matches /i/{id} only", () => {
    expect(parseImagePath(`/i/${id}`)).toEqual({ ok: true, id });
    expect(parseImagePath(`/i/${id}/`)).toEqual({ ok: true, id });
    expect(parseImagePath("/i/")).toEqual({ ok: false });
    expect(parseImagePath("/i/not-hex")).toEqual({ ok: false });
    expect(parseImagePath("/blog/pic.png")).toEqual({ ok: false });
  });
});

describe("/i/ vs slug routing", () => {
  const id = "0123456789abcdef0123456789abcdef";

  test("imageHost on + sites off: /i/{id} works, slugs 404", () => {
    expect(
      resolveSitesHostRoute(`/i/${id}`, { sites: false, imageHost: true })
    ).toEqual({ kind: "image", id });
    expect(
      resolveSitesHostRoute("/blog/", { sites: false, imageHost: true })
    ).toEqual({ kind: "notFound" });
  });

  test("imageHost off + sites on: /i/* 404, slugs still route", () => {
    expect(
      resolveSitesHostRoute(`/i/${id}`, { sites: true, imageHost: false })
    ).toEqual({ kind: "notFound" });
    expect(
      resolveSitesHostRoute("/blog/style.css", { sites: true, imageHost: false })
    ).toEqual({
      kind: "site",
      slug: "blog",
      key: "sites/blog/style.css",
      tryIndex: false,
    });
  });

  test("/i/{id} is matched before a slug named i", () => {
    expect(
      resolveSitesHostRoute(`/i/${id}`, { sites: true, imageHost: true })
    ).toEqual({ kind: "image", id });
  });

  test("both off: everything 404", () => {
    expect(
      resolveSitesHostRoute(`/i/${id}`, { sites: false, imageHost: false })
    ).toEqual({ kind: "notFound" });
    expect(
      resolveSitesHostRoute("/blog", { sites: false, imageHost: false })
    ).toEqual({ kind: "notFound" });
  });
});

describe("SVG disposition", () => {
  test("SVG is attachment + nosniff, never a navigable page", () => {
    const headers = imageResponseHeaders({
      contentType: "image/svg+xml",
      filename: "logo.svg",
    });
    expect(headers.get("Content-Type")).toBe("image/svg+xml");
    expect(headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(headers.get("Content-Disposition")).toContain("logo.svg");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("filename .svg is treated as SVG even if type is generic", () => {
    const headers = imageResponseHeaders({
      contentType: "application/octet-stream",
      filename: "draw.svg",
    });
    expect(headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("raster images stay inline with nosniff", () => {
    const headers = imageResponseHeaders({
      contentType: "image/png",
      filename: "shot.png",
    });
    expect(headers.get("Content-Disposition")).toBe("inline");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Content-Type")).toBe("image/png");
  });
});
