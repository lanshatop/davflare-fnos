import { authFetch } from "./auth";
import { translate } from "./strings";

export interface HostedImage {
  id: string;
  name: string;
  size: number;
  uploaded: string;
  contentType: string;
  url: string | null;
  markdown: string;
}

export interface ImagesResponse {
  sitesHost: string | null;
  images: HostedImage[];
}

export async function listImages(): Promise<ImagesResponse> {
  const response = await authFetch("/api/images");
  if (!response.ok) throw new Error((await response.text()) || translate("loadImagesFailed"));
  return response.json();
}

export async function uploadImage(file: File): Promise<HostedImage> {
  // HTTP 头只能携带 ISO-8859-1 字符：中文名直接放进 X-File-Name 会让
  // new Headers() 抛 "non ISO-8859-1 code point"（整个上传直接失败）。
  // 这里对文件名做百分号编码（纯 ASCII，任何客户端都安全），服务端会解回来。
  const response = await authFetch("/api/images", {
    method: "POST",
    headers: { "X-File-Name": encodeURIComponent(file.name) },
    body: file,
  });
  if (!response.ok) {
    throw new Error((await response.text()) || translate("uploadImageFailed"));
  }
  return response.json();
}

export async function deleteImage(id: string): Promise<void> {
  const response = await authFetch(`/api/images?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error((await response.text()) || translate("deleteImageFailed"));
  }
}
