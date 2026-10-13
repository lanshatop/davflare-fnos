import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

/**
 * 品牌自定义（NAS 自托管需求）：界面里的 Davflare 名称与云朵 Logo 允许用户换成自己的。
 *
 * 数据来源 `GET /api/branding`（公开端点，登录页在未登录时就要读取）：
 *   { name: string | null, defaultName: string, hasCustomLogo: boolean }
 * logo 图片在 `/api/branding/logo`（同样公开，no-cache）。
 * 默认 favicon 由 NAS 端静态层覆盖为自定义图，因此浏览器标签页图标无需前端干预；
 * 这里只负责展示名与登录页/顶栏的 Logo 图。
 */

export interface BrandingInfo {
  name: string | null;
  defaultName: string;
  hasCustomLogo: boolean;
}

interface BrandingState {
  loaded: boolean;
  info: BrandingInfo | null;
  /** 每次重新拉取时递增，用作 logo URL 的缓存击穿参数 */
  version: number;
  /** 供设置页保存后刷新品牌 */
  reload: () => void;
}

const BrandingContext = createContext<BrandingState>({
  loaded: false,
  info: null,
  version: 0,
  reload: () => undefined,
});

const FALLBACK_NAME = "Davflare";

export function BrandingProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<Omit<BrandingState, "reload">>({
    loaded: false,
    info: null,
    version: 0,
  });

  const reload = useCallback(() => {
    let cancelled = false;
    fetch("/api/branding")
      .then((response) => (response.ok ? (response.json() as Promise<BrandingInfo>) : null))
      .then((data) => {
        if (cancelled) return;
        setState((prev) => ({ loaded: true, info: data, version: prev.version + 1 }));
      })
      .catch(() => {
        if (cancelled) return;
        setState((prev) => ({ loaded: true, info: null, version: prev.version + 1 }));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => reload(), [reload]);

  const value = useMemo<BrandingState>(() => ({ ...state, reload }), [state, reload]);

  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export interface BrandingView {
  /** 界面展示名：自定义名优先，否则默认 Davflare */
  name: string;
  /** 自定义 logo 地址（带版本参数防缓存）；null = 用默认 favicon.png */
  logoSrc: string | null;
  /** 用户是否自定义过（名称或 logo 任一） */
  isCustom: boolean;
  /** 服务端原始配置；加载完成前为 null */
  info: BrandingInfo | null;
  loaded: boolean;
  /** 供设置页保存后刷新品牌 */
  reload: () => void;
}

export function useBranding(): BrandingView {
  const state = useContext(BrandingContext);
  return useMemo(
    () => ({
      name: state.info?.name || state.info?.defaultName || FALLBACK_NAME,
      logoSrc: state.info?.hasCustomLogo
        ? `/api/branding/logo?v=${state.version}`
        : null,
      isCustom: Boolean(state.info?.name || state.info?.hasCustomLogo),
      info: state.info,
      loaded: state.loaded,
      reload: state.reload,
    }),
    [state]
  );
}
