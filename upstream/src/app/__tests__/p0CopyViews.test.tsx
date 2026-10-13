import { vi, type Mock } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import ImagesView from "../../ImagesView";
import SettingsView from "../../SettingsView";
import SitesView from "../../SitesView";
import { DEFAULT_FEATURE_FLAGS, useFeatures } from "../features";
import { listImages } from "../images";
import { listSites } from "../sites";
import { setLang, strings } from "../strings";

vi.mock("../features", async () => {
  const actual = await vi.importActual("../features");
  return { ...actual, useFeatures: vi.fn() };
});

vi.mock("../sites", async () => {
  const actual = await vi.importActual("../sites");
  return { ...actual, listSites: vi.fn() };
});

vi.mock("../images", async () => {
  const actual = await vi.importActual("../images");
  return { ...actual, listImages: vi.fn() };
});

vi.mock("../transferQueue", () => ({
  useUploadEnqueue: () => vi.fn(),
}));

const mockUseFeatures = useFeatures as unknown as Mock;
const mockListSites = listSites as unknown as Mock;
const mockListImages = listImages as unknown as Mock;

beforeEach(() => {
  setLang("en");
  mockUseFeatures.mockReset();
  mockListSites.mockReset();
  mockListImages.mockReset();
  mockUseFeatures.mockReturnValue({
    flags: DEFAULT_FEATURE_FLAGS,
    sitesHost: null,
    updateFlags: vi.fn(),
  });
});

describe("P0 copy: Settings / Sites / Images", () => {
  test("Settings states MCP is 404 when API Key is off", () => {
    render(<SettingsView onNotify={vi.fn()} />);
    expect(screen.getByText(strings.mcpRequiresApiKey)).toBeInTheDocument();
    expect(strings.mcpRequiresApiKey).toMatch(/404/);
    expect(strings.mcpRequiresApiKey).toMatch(/API Key/i);
    expect(screen.getByText(strings.flagWebdav)).toBeInTheDocument();
    expect(screen.getByText(strings.flagMcp)).toBeInTheDocument();
    expect(screen.getByText(strings.flagApiKey)).toBeInTheDocument();
    expect(screen.getByText(strings.flagSites)).toBeInTheDocument();
    expect(screen.getByText(strings.flagImageHost)).toBeInTheDocument();
  });

  test("Sites view works without SITES_HOST（飞牛适配：站点任意主机可访问，不再警告阻断）", async () => {
    mockListSites.mockResolvedValue({ sitesHost: null, sites: [] });
    render(<SitesView onNotify={vi.fn()} onManageFiles={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(strings.emptySites)).toBeInTheDocument();
    });
    // 未配置 SITES_HOST 也不显示「公开地址打不开」的警告
    expect(screen.queryByText(strings.sitesHostMissing)).not.toBeInTheDocument();
  });

  test("Images view tells NAS users where to set the sites host", async () => {
    mockListImages.mockResolvedValue({ sitesHost: null, images: [] });
    render(<ImagesView onNotify={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(strings.imagesHostMissing)).toBeInTheDocument();
    });
    expect(screen.getByText(strings.imagesHostMissingHint)).toBeInTheDocument();
    expect(strings.imagesHostMissingHint).toMatch(/应用中心|[Aa]pp [Cc]enter/);
    expect(strings.imagesHostMissingHint).toMatch(/fnos\.local/);
    expect(strings.imagesHostMissing).toMatch(/will not open/);
  });
});
