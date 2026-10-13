import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import PublishDirDialog from "../../PublishDirDialog";
import { SitePublishInterruptedError, publishDirSite, siteUrl } from "../sites";
import { getLang, strings, translate } from "../strings";
import { fetchPath } from "../transfer";
import { FileItem } from "../types";

vi.mock("../sites", async () => {
  const actual = await vi.importActual<typeof import("../sites")>("../sites");
  return { ...actual, publishDirSite: vi.fn() };
});
vi.mock("../transfer", async () => {
  const actual = await vi.importActual<typeof import("../transfer")>("../transfer");
  return { ...actual, fetchPath: vi.fn() };
});

const folder: FileItem = {
  key: "docs/Share Folder",
  name: "Share Folder",
  isDir: true,
  size: 0,
  uploaded: "",
  contentType: "application/x-directory",
};

function item(name: string, size = 1024, isDir = false): FileItem {
  return {
    key: `docs/Share Folder/${name}`,
    name,
    isDir,
    size,
    uploaded: "2026-01-01T00:00:00.000Z",
    contentType: isDir ? "application/x-directory" : "text/plain",
  };
}

describe("PublishDirDialog", () => {
  beforeEach(() => {
    vi.mocked(publishDirSite).mockReset();
    vi.mocked(fetchPath).mockReset();
  });

  test("lists the current level, shows subfolder/copy notes and progress, then the link", async () => {
    vi.mocked(fetchPath).mockResolvedValue([item("a.txt"), item("b.pdf", 2048), item("sub", 0, true)]);
    let release: () => void = () => undefined;
    vi.mocked(publishDirSite).mockImplementation(async (_slug, _source, options) => {
      options?.onProgress?.({ phase: "copy", done: 1, total: 2 });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { slug: "share-folder", kind: "dir", copied: 2, bytes: 3072, sitesHost: "sites.example.com" };
    });
    const onNotify = vi.fn();
    render(<PublishDirDialog open folder={folder} onClose={vi.fn()} onNotify={onNotify} />);
    expect(fetchPath).toHaveBeenCalledWith("docs/Share Folder/");
    await waitFor(() => expect(screen.getByText(/3 KB|3\.0 KB/)).toBeInTheDocument());
    expect(screen.getByText(translate("publishDirSubdirs", { count: 1 }))).toBeInTheDocument();
    expect(screen.getByText(strings.publishDirCopyNote)).toBeInTheDocument();
    const slugInput = screen.getByLabelText(strings.publishSiteSlug) as HTMLInputElement;
    expect(slugInput.value).toBe("share-folder");

    fireEvent.click(screen.getByRole("button", { name: strings.publishSiteSubmit }));
    await waitFor(() =>
      expect(screen.getByText(translate("publishDirProgress", { done: 1, total: 2 }))).toBeInTheDocument()
    );
    expect(publishDirSite).toHaveBeenCalledWith(
      "share-folder",
      "docs/Share Folder",
      expect.objectContaining({ lang: getLang(), title: "Share Folder" })
    );
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    release();
    const expected = siteUrl("share-folder");
    await waitFor(() => expect(screen.getByDisplayValue(expected)).toBeInTheDocument());
    expect(onNotify).toHaveBeenCalledWith(translate("publishDirDone", { count: 2 }), "success");
  });

  test("many top-level files are publishable (no count limit on fnOS)", async () => {
    // 飞牛自托管版：公开目录不再有 500 个文件的上限，超过后仍可正常发布
    vi.mocked(fetchPath).mockResolvedValue(
      Array.from({ length: 501 }, (_, i) => item(`${i}.txt`, 1))
    );
    render(<PublishDirDialog open folder={folder} onClose={vi.fn()} onNotify={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: strings.publishSiteSubmit })).toBeEnabled()
    );
    expect(publishDirSite).not.toHaveBeenCalled();
  });

  test("empty folder is blocked", async () => {
    vi.mocked(fetchPath).mockResolvedValue([item("only-sub", 0, true)]);
    render(<PublishDirDialog open folder={folder} onClose={vi.fn()} onNotify={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(translate("publishDirEmpty"))).toBeInTheDocument());
    expect(screen.getByRole("button", { name: strings.publishSiteSubmit })).toBeDisabled();
  });

  test("interrupted publish shows the may-be-incomplete message", async () => {
    vi.mocked(fetchPath).mockResolvedValue([item("a.txt")]);
    vi.mocked(publishDirSite).mockRejectedValue(new SitePublishInterruptedError("boom"));
    render(<PublishDirDialog open folder={folder} onClose={vi.fn()} onNotify={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: strings.publishSiteSubmit })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: strings.publishSiteSubmit }));
    await waitFor(() =>
      expect(screen.getByText(translate("publishDirInterrupted", { reason: "boom" }))).toBeInTheDocument()
    );
  });

  test("bad slug and folder read failure", async () => {
    vi.mocked(fetchPath).mockResolvedValueOnce([item("a.txt")]);
    const { unmount } = render(
      <PublishDirDialog open folder={folder} onClose={vi.fn()} onNotify={vi.fn()} />
    );
    await waitFor(() => expect(screen.getByRole("button", { name: strings.publishSiteSubmit })).toBeEnabled());
    fireEvent.change(screen.getByLabelText(strings.publishSiteSlug), { target: { value: "Bad Slug!" } });
    fireEvent.click(screen.getByRole("button", { name: strings.publishSiteSubmit }));
    expect(await screen.findByText(translate("publishSiteBadSlug"))).toBeInTheDocument();
    expect(publishDirSite).not.toHaveBeenCalled();
    unmount();

    vi.mocked(fetchPath).mockRejectedValueOnce(new Error("net"));
    render(<PublishDirDialog open folder={folder} onClose={vi.fn()} onNotify={vi.fn()} />);
    expect(await screen.findByText(translate("publishDirLoadFailed"))).toBeInTheDocument();
  });

  test("no sites host → 仍有成功提示与链接（飞牛适配：站点任意主机可访问）", async () => {
    vi.mocked(fetchPath).mockResolvedValue([item("a.txt")]);
    vi.mocked(publishDirSite).mockResolvedValue({
      slug: "share-folder",
      kind: "dir",
      copied: 1,
      bytes: 1,
      sitesHost: null,
    });
    const onNotify = vi.fn();
    render(<PublishDirDialog open folder={folder} onClose={vi.fn()} onNotify={onNotify} />);
    await waitFor(() => expect(screen.getByRole("button", { name: strings.publishSiteSubmit })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: strings.publishSiteSubmit }));
    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(translate("publishDirDone", { count: 1 }), "success")
    );
  });
});
