/**
 * Cloudflare Pages Functions 运行时（飞牛 fnOS 本地版）
 *
 * upstream/functions/** 是按 Pages 的「文件即路由」约定写的：
 *   functions/_middleware.ts        → 全局中间件（对所有请求生效）
 *   functions/api/list.ts           → /api/list
 *   functions/webdav/[[path]].ts    → /webdav/*
 *   functions/share/[[token]].ts    → /share/*
 *   functions/collect/[[token]].ts  → /collect/*
 *   functions/mcp.ts                → /mcp
 *   functions/xxx/_yyy.ts           → 以下划线开头的文件不是路由
 *
 * 本模块用一张等价的路由表复刻这套语义，并实现 EventContext
 * （request / env / params / data / next / waitUntil / passThroughOnException），
 * 让业务代码一行都不用改。
 */

export interface PagesEnv {
  BUCKET: unknown;
  WEBDAV_USERNAME?: string;
  WEBDAV_PASSWORD?: string;
  WEBDAV_PUBLIC_READ?: string;
  SITES_HOST?: string;
  TRASH_RETENTION_DAYS?: string;
  [key: string]: unknown;
}

export type RouteHandlers = Record<string, unknown>;

export interface RouteDefinition {
  /** 形如 "/api/list" 或 "/webdav/[[path]]" */
  pattern: string;
  handlers: RouteHandlers;
}

export interface RouterOptions {
  routes: RouteDefinition[];
  /** 全局中间件，按数组顺序执行 */
  middleware?: RouteHandlers[];
  env: PagesEnv;
  /** 静态资源处理（vite 产物）；返回 null 表示未命中 */
  serveStatic: (request: Request) => Promise<Response | null>;
  /** 静态资源也未命中时的最终兜底（Pages 的 SPA 回退） */
  fallback: (request: Request) => Promise<Response>;
  onError?: (error: unknown, request: Request) => void;
}

const METHOD_HANDLER: Record<string, string> = {
  GET: "onRequestGet",
  HEAD: "onRequestHead",
  POST: "onRequestPost",
  PUT: "onRequestPut",
  PATCH: "onRequestPatch",
  DELETE: "onRequestDelete",
  OPTIONS: "onRequestOptions",
};

const ALL_METHODS = Object.keys(METHOD_HANDLER);

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** 把路由 pattern 与请求路径做匹配，返回捕获参数；不匹配返回 null */
export function matchPattern(
  pattern: string,
  pathname: string
): Record<string, unknown> | null {
  const patternSegments = pattern.split("/").filter(Boolean);
  const pathSegments = pathname.split("/").filter(Boolean);
  const params: Record<string, unknown> = {};

  for (let index = 0; index < patternSegments.length; index += 1) {
    const segment = patternSegments[index]!;
    const catchAll = /^\[\[(.+)\]\]$/.exec(segment);
    if (catchAll) {
      // [[path]]：吞掉剩余全部段；Pages 里这种参数是「字符串数组」
      params[catchAll[1]!] = pathSegments.slice(index).map(decodeSegment);
      return params;
    }
    const single = /^\[(.+)\]$/.exec(segment);
    if (single) {
      if (index >= pathSegments.length) return null;
      params[single[1]!] = decodeSegment(pathSegments[index]!);
      continue;
    }
    if (index >= pathSegments.length) return null;
    if (decodeSegment(pathSegments[index]!) !== segment) return null;
  }

  // pattern 消费完，路径也必须恰好消费完
  if (pathSegments.length !== patternSegments.length) return null;
  return params;
}

function allowedMethods(handlers: RouteHandlers): string[] {
  return ALL_METHODS.filter(
    (method) => typeof handlers[METHOD_HANDLER[method]!] === "function"
  );
}

/** 静态路径优先、动态次之、通配最后，和 Pages 的目录层级一致 */
function patternSpecificity(pattern: string): number {
  const catchAll = pattern.includes("[[") ? -1000 : 0;
  const dynamic = (pattern.match(/\[/g) ?? []).length * -10;
  return catchAll + dynamic + pattern.length;
}

type ChainFn = (ctx: EventContext) => Promise<Response>;

export class PagesRuntime {
  private readonly options: RouterOptions;
  private readonly middleware: ChainFn[];
  private readonly routes: RouteDefinition[];

  constructor(options: RouterOptions) {
    this.options = options;
    this.middleware = (options.middleware ?? [])
      .map((entry) => entry.onRequest)
      .filter((handler): handler is ChainFn => typeof handler === "function");
    this.routes = [...options.routes].sort(
      (a, b) => patternSpecificity(b.pattern) - patternSpecificity(a.pattern)
    );
  }

  private matchRoute(pathname: string): { handlers: RouteHandlers; params: Record<string, unknown> } | null {
    for (const route of this.routes) {
      const params = matchPattern(route.pattern, pathname);
      if (params !== null) return { handlers: route.handlers, params };
    }
    return null;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const matched = this.matchRoute(url.pathname);

    let methodAllowed: string[] | null = null;
    let routeHandler: ChainFn | null = null;
    if (matched) {
      const method = request.method.toUpperCase();
      const candidate = matched.handlers.onRequest ?? matched.handlers[METHOD_HANDLER[method] ?? ""];
      if (typeof candidate === "function") routeHandler = candidate as ChainFn;
      else methodAllowed = allowedMethods(matched.handlers);
    }

    const chain: ChainFn[] = [...this.middleware];
    if (routeHandler) chain.push(routeHandler);

    const pending: Promise<unknown>[] = [];
    const context = new EventContext({
      request,
      env: this.options.env,
      params: matched?.params ?? {},
      pending,
      methodAllowed,
      serveStatic: this.options.serveStatic,
      fallback: this.options.fallback,
    });

    let response: Response;
    try {
      if (chain.length === 0) {
        response = await context.finalResponse();
      } else {
        context.setChain(chain);
        response = await context.next();
      }
    } catch (error) {
      this.options.onError?.(error, request);
      throw error;
    }

    if (pending.length > 0) {
      void Promise.allSettled(pending).then((results) => {
        for (const result of results) {
          if (result.status === "rejected") this.options.onError?.(result.reason, request);
        }
      });
    }
    return response;
  }
}

interface EventContextInit {
  request: Request;
  env: PagesEnv;
  params: Record<string, unknown>;
  pending: Promise<unknown>[];
  methodAllowed: string[] | null;
  serveStatic: (request: Request) => Promise<Response | null>;
  fallback: (request: Request) => Promise<Response>;
}

/** 复刻 Pages 的 EventContext */
export class EventContext {
  request: Request;
  env: PagesEnv;
  params: Record<string, unknown>;
  data: Record<string, unknown> = {};
  functionPath: string;

  private readonly init: EventContextInit;
  private chain: ChainFn[] = [];
  private cursor = 0;
  private nextCalls = 0;

  constructor(init: EventContextInit) {
    this.init = init;
    this.request = init.request;
    this.env = init.env;
    this.params = init.params;
    this.functionPath = new URL(init.request.url).pathname;
  }

  setChain(chain: ChainFn[]): void {
    this.chain = chain;
    this.cursor = 0;
  }

  waitUntil(promise: Promise<unknown>): void {
    this.init.pending.push(promise);
  }

  passThroughOnException(): void {
    // 本地运行时没有 Cloudflare 的边缘错误页：异常直接冒泡到服务器层统一处理
  }

  /**
   * next() 语义：先跑剩下的中间件；中间件跑完后再看路由处理器（已在链里），
   * 链尾是「静态资源 → SPA 回退」。
   */
  async next(request?: Request): Promise<Response> {
    if (request) this.request = request;
    this.nextCalls += 1;
    if (this.nextCalls > 64) throw new Error("next() called too many times");
    if (this.cursor < this.chain.length) {
      const handler = this.chain[this.cursor]!;
      this.cursor += 1;
      return handler(this);
    }
    return this.finalResponse();
  }

  /** 链尾：路由未命中 → 静态资源 → SPA 回退 */
  async finalResponse(): Promise<Response> {
    if (this.init.methodAllowed !== null) {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: this.init.methodAllowed.join(", ") },
      });
    }
    const staticResponse = await this.init.serveStatic(this.request);
    if (staticResponse !== null) return staticResponse;
    return this.init.fallback(this.request);
  }
}
