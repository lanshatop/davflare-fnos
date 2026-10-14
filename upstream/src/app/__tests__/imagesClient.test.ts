import { vi } from "vitest";
import { authFetch } from "../auth";
import { deleteImage, listImages, uploadImage } from "../images";
import { setLang } from "../strings";
import { asAuthFetchMock } from "../testUtils";

vi.mock("../auth", () => ({
  authFetch: vi.fn(),
}));

const mockAuthFetch = asAuthFetchMock(authFetch);

beforeEach(() => {
  mockAuthFetch.mockReset();
});

describe("images client", () => {
  test("listImages GETs /api/images", async () => {
    mockAuthFetch.mockOk({ sitesHost: null, images: [] });
    await listImages();
    expect(mockAuthFetch).toHaveBeenCalledWith("/api/images");
  });

  test("uploadImage POSTs the file with original name header", async () => {
    mockAuthFetch.mockOk({ id: "x", name: "a.png" }, 201);
    const file = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
    await uploadImage(file);
    const [url, init] = mockAuthFetch.mock.calls[0];
    expect(url).toBe("/api/images");
    expect(init.method).toBe("POST");
    expect(init.headers["X-File-Name"]).toBe("a.png");
    expect(init.body).toBe(file);
  });

  test("uploadImage 中文名做百分号编码，避免 Headers 的 ISO-8859-1 限制", async () => {
    mockAuthFetch.mockOk({ id: "x", name: "截图.png" }, 201);
    const file = new File([new Uint8Array([1])], "截图 2024🎉.png", { type: "image/png" });
    await uploadImage(file);
    const [, init] = mockAuthFetch.mock.calls[0];
    const name = init.headers["X-File-Name"];
    // 编码后必须是纯 ASCII（能通过 new Headers 校验），且服务端可无损解回原名
    expect(() => new Headers(init.headers)).not.toThrow();
    expect(/^[\x20-\x7e]*$/.test(name)).toBe(true);
    expect(name).toBe(encodeURIComponent("截图 2024🎉.png"));
    expect(decodeURIComponent(name)).toBe("截图 2024🎉.png");
  });

  test("deleteImage DELETEs by id", async () => {
    mockAuthFetch.mockOk({ deleted: true });
    await deleteImage("ab".repeat(16));
    const [url, init] = mockAuthFetch.mock.calls[0];
    expect(url).toBe(`/api/images?id=${"ab".repeat(16)}`);
    expect(init.method).toBe("DELETE");
  });
});

describe("images client 错误分支", () => {
  beforeEach(() => {
    mockAuthFetch.mockReset();
  });

  test("listImages 非 2xx 抛响应文本", async () => {
    mockAuthFetch.mockError(503, "unavailable");
    await expect(listImages()).rejects.toThrow("unavailable");
  });

  test("listImages 空 body 抛默认文案", async () => {
    mockAuthFetch.mockError(500, "");
    setLang("zh");
    await expect(listImages()).rejects.toThrow("获取图片列表失败");
  });

  test("uploadImage 非 2xx 抛响应文本", async () => {
    mockAuthFetch.mockError(413, "too large");
    await expect(
      uploadImage(new File(["x"], "a.png", { type: "image/png" }))
    ).rejects.toThrow("too large");
  });

  test("deleteImage 非 2xx 抛默认文案", async () => {
    mockAuthFetch.mockError(404, "");
    setLang("zh");
    await expect(deleteImage("a".repeat(32))).rejects.toThrow("删除图片失败");
  });
});
