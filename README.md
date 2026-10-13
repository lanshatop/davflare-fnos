# Davflare · 飞牛 fnOS 适配版

把 [Davflare](https://github.com/fanchenggang/Davflare)（Cloudflare R2 文件管理器 / 分享服务）完整搬到飞牛 fnOS 上本地运行：**程序跑在 NAS 上，数据也存在 NAS 上**，不再依赖 Cloudflare。

**功能与上游零删减**，仅把平台耦合点做了替换。

---

## 下载与安装

| 渠道 | 说明 |
| --- | --- |
| **安装包（推荐）** | 到 [Releases](https://github.com/lanshatop/davflare-fnos/releases/latest) 下载 `davflare-fnos-1.0.1.fpk`，在飞牛「应用中心 → 手动安装」中选择该文件 |
| 源码自行构建 | 执行 `bash tools/build-fpk.sh`（需 `fnpack`），产物为 `davflare/davflare.fpk` |

> **环境要求**：飞牛 fnOS `>= 1.1.3100`；依赖应用 `nodejs_v24`（应用中心会自动安装）；默认服务端口 `8087`。
>
> **覆盖安装**不影响数据目录中的网盘文件与品牌设置，可放心升级。
> 安装失败时查看日志：`/var/apps/davflare/var/davflare.log`。

---

## 一、功能清单（与上游一一对应）

| 功能 | 上游实现 | fnOS 版实现 |
| --- | --- | --- |
| 文件管理器（浏览/上传/下载/新建/重命名/复制/移动/删除/搜索/统计） | Pages Functions + R2 | 同一套前端 + 本地 Pages 运行时 |
| 大文件分块上传 | R2 Multipart | 文件系统分块上传（无大小上限，流式落盘） |
| HTTP Range 断点续传 | R2 `get(range)` | `resolveRange` + 206 |
| WebDAV（`/webdav/`） | Pages Functions | OPTIONS / PROPFIND / MKCOL / PUT / GET / MOVE / COPY / DELETE / PROPPATCH / LOCK / UNLOCK |
| 分享链接（提取码、有效期、目录 ZIP） | Pages Functions | 同上 |
| 回收站（软删/还原/彻底删/自动清理） | R2 对象 | 同语义 |
| 静态站点发布（`/sites/`） | Pages Functions | 同上；**飞牛适配：站点在任意主机 / IP 上都可直接打开，无需登录**（见 §7.2） |
| 图床（`/i/{id}` + Markdown） | Pages Functions | 同上 |
| 文件收集（四步分块协议） | Pages Functions | 同上 |
| API 密钥（签发/列表/删除） | Pages Functions | 同上 |
| MCP 服务端（25 个工具） | Pages Functions | 同上 |
| 整库备份（流式 ZIP） | Pages Functions | 同上 |
| 前端 SPA | Vite 产物 | **同一份产物，未裁剪** |
| 品牌自定义（名称 + Logo） | 无（硬编码 `Davflare`） | **本适配新增**，见 §2.6；**安装向导即可配置**（仅首次初始化生效），见 §7.5 |
| 公开目录发布限额 | 500 个文件 / 2 GiB（Cloudflare 平台约束） | **取消上限**，流式复制支持 >2 GB 单文件 |
| 匿名只读 WebDAV 目录 | 无 | **本适配新增**（`WEBDAV_PUBLIC_DIR` + `WEBDAV_PUBLIC_DIR_ON` 生效开关），见 §7.3 |
| WebDAV 浏览目录页 | 760px 窄卡 | 加宽到 1100px，宽屏行距更舒展 |

**路由数量核对**：`runtime/routes.ts` 登记 26 条路由（22 个 `/api/*` + `/webdav/[[path]]` + `/share/[[token]]` + `/collect/[[token]]` + `/mcp`）。其中 24 条与上游 `functions/` 目录一一对应，另 2 条（`/api/branding`、`/api/branding/logo`）为本适配新增。

---

## 二、平台耦合点替换

上游只耦合了两个 Cloudflare 平台能力，本适配把这两处替换掉，其余代码原样复用：

1. **R2 桶绑定 → 文件系统**
   `runtime/lib/r2-fs.ts`（约 730 行）完整复刻 R2 语义：
   - 目录 = 不带尾斜杠的 0 字节标记对象（`application/x-directory` + `resourcetype: <collection />`）
   - 删除目录标记不影响子键，目录仍以 `DelimitedPrefix` 形式出现（惰性清理）
   - 字节序列举（`byteCompare` 排序）、游标分页收敛、`StartAfter`/`Delimiter`
   - 条件请求 `If-Match`/`If-None-Match` → 412
   - `Range` → 206（含后缀 Range）
   - Multipart：`createMultipartUpload` 返回 Promise、`resumeMultipartUpload` **同步**返回（与真实 R2 API 一致，上游按同步调用）
   - `_$flaredrive$` 内部状态（分享、回收站、图床、配置、API 密钥、收集链接）作为真实对象存放

2. **Pages Functions 运行时 → 本地 Node 运行时**
   `runtime/lib/pages.ts` 复刻 `EventContext` / `env` / 中间件链 / 静态资源 fallback；`runtime/server.ts` 用 `node:http` 起服务，请求体直接把 Node 流交给下游（**不缓冲**，上传大小只受磁盘限制）。

3. **飞牛桌面 iframe 适配**
   fnOS 桌面用 iframe 打开应用入口。上游 `_headers` 里的 `X-Frame-Options: DENY` 会让桌面窗口白屏。
   `runtime/lib/static-assets.ts` 在 `DAVFLARE_ALLOW_IFRAME=1` 时跳过 `X-Frame-Options`，改发 `Content-Security-Policy: frame-ancestors <wizard_frame_ancestors>`。

4. **请求体上限适配（Cloudflare 平台限制）**
   上游把「Cloudflare 单次请求体约 100MB」这个平台限制写死在两处**单次直传**路径里，
   并且都把正文整体读进内存：
   - `functions/api/upload.ts` —— `POST /api/upload` 的 `X-File-Name` 与 multipart 路径
   - `functions/webdav/protocol.ts` —— WebDAV `PUT`

   自托管（数据与程序都在 NAS 上）没有这个平台限制，所以在 NAS 上：
   - 新增 `functions/_platform.ts` 统一提供上限，运行时通过 `globalThis.__DAVFLARE_MAX_REQUEST_BYTES__` 注入
     （环境变量 `DAVFLARE_MAX_REQUEST_BYTES`，**默认 `0` = 不限制**，只受磁盘容量约束）
   - 两条路径的正文从 `await request.arrayBuffer()` 改为**直接把请求流交给存储层**，
     由 `r2-fs.ts` 的 `writeValueToFile` 流式落盘，**内存占用与文件大小无关**
   - 显式设置 `DAVFLARE_MAX_REQUEST_BYTES=<字节数>` 即可恢复限流；超限仍返回 413，
     且响应会声明 `Connection: close`（避免半读连接被客户端复用导致 ECONNRESET）

   这让 WebDAV 挂载（Windows 映射驱动器 / macOS Finder / 手机文件管理器）能够直接上传
   超过 100MB 的单个文件，与真实 NAS 的体验一致。

5. **登录页首屏（fnOS 桌面入口观感）**
   上游未登录时主界面骨架仍在登录框的半透明遮罩下隐约可见。本适配要求「除登录框外其余背景均不可见」：
   - `src/App.tsx`：未登录时把「跳转按钮 + 顶栏 + 主界面」用 `visibility: hidden` 藏起来。
     **保留挂载**，不破坏上游「未登录也渲染主界面」的行为、数据预取与既有测试。
     注意：MUI 的 Snackbar 默认不走 Portal，是 Stack 的直接子元素——不能对整个 Stack 用
     `& > *` 一并隐藏，否则未登录时的错误提示（如登录失败）也会看不见；这里用一层
     `display: contents` 的包裹盒只藏上述三块（LoginDialog / TransferManager 等走 Portal，不受影响）
   - `src/LoginDialog.tsx`：遮罩从默认半透明黑改为**不透明的纸面底色**（亮暗模式各用
     `background.default`），登录卡片补一道细描边，避免卡片与同色背景糊在一起
   - 效果：打开应用只见「纯色背景 + 居中登录卡片」，目录结构零泄露；登录后主界面恢复
   - 已用系统 Chrome + CDP 真实渲染验证（浅色 / 深色 / 登录后三场景 8 项断言全过，
     截图见 `davflare-login-light.png` / `davflare-login-dark.png` / `davflare-after-login.png`，
     脚本 `tools/ui-check.mjs` + `tools/run-ui-check.sh`）

6. **品牌自定义（Logo 与名称用户可定义）**
   上游把品牌名 `Davflare` 与云朵 Logo 硬编码在十来处（前端顶栏 / 登录框 / 页面标题 /
   favicon / manifest，以及服务端直出的分享落地页、收集页、导航站、相册站、公开目录、WebDAV 目录页）。
   本适配新增一套品牌存储与读取链路，让用户把**所有**出现点一次性换成自己的名称与图标：

   **存储契约**（沿用上游「内部状态均为真实对象」约定，全部落在数据目录内，云端/本地通用）
   ```
   _$flaredrive$/branding.json           { "name": "家庭云盘", "logoKey": "_$flaredrive$/branding/logo.png" }
   _$flaredrive$/branding/logo.<ext>     自定义 Logo 图片（png / jpeg / webp / gif / svg）
   ```
   - 名称为 `null` → 用默认名 `Davflare`；`logoKey` 为 `null` → 用内置图标
   - 名称长度 ≤ 40 字，Logo ≤ 2 MB，类型白名单校验（非图片 415、超限 413）
   - 升级 / 迁移只需带走数据目录，品牌配置随数据一起走

   **接口**（新增 `functions/api/branding.ts` + `functions/api/branding/logo.ts`）
   | 方法 | 路径 | 权限 | 说明 |
   | --- | --- | --- | --- |
   | `GET` | `/api/branding` | **公开** | 返回 `{name, defaultName, hasCustomLogo, logoUrl}`（登录页未登录就要读） |
   | `GET` | `/api/branding/logo` | **公开** | 返回自定义 Logo 原图（`no-cache`）；未设置时 404 由前端回退内置图标 |
   | `PUT` | `/api/branding` | 管理员 | multipart：`name` 文本字段 + `logo` 文件；`clearLogo=1` 仅清 Logo |
   | `DELETE` | `/api/branding` | 管理员 | 恢复默认（删配置 + 删图片） |

   鉴权沿用 `isSessionOrKeyAuthorized`（会话或 API 密钥任一），与其它管理接口一致。

   **一次改，全站生效的两条路子**
   - *前端 SPA*：新增 `src/app/branding.tsx` 的 `BrandingProvider` / `useBranding()`，
     在 `ThemedApp` 顶层注入；`Header`、`LoginDialog` 改用 `brand.name` / `brand.logoSrc`，
     并同步 `document.title` 与 `<link rel="icon">`。设置页新增 `BrandingCard`
     （Logo 预览 / 上传（≤2 MB）/ 清除、名称输入、保存、恢复默认）。
   - *服务端直出页面*：所有直出页共用 `/favicon.png` 作为图标，因此运行时在静态层
     拦截 `/favicon.png` 与 `/logo144.png`，命中时返回自定义 Logo
     （`runtime/lib/static-assets.ts` 的 `logoOverride` + `runtime/server.ts` 的
     `createLogoOverride(dataDir)`，带 3 秒 TTL 缓存，避免每次请求都读盘）。
     名称则通过 `functions/_branding.ts` 的 `brandMarkHtml()` / `brandTitleSuffix()` 注入，
     覆盖分享落地页、提取码表单、收集页、导航站 / 相册站 / 公开目录 / 文档站、WebDAV 目录页。

   **顺带修复**：文件系统存储会为一级目录创建**不带尾斜杠**的 0 字节标记对象（key = `_$flaredrive$`），
   而 `functions/webdav/davUtil.ts` 原先只用 `startsWith("_$flaredrive$/")` 过滤，
   导致该标记对象把内部状态目录暴露在 WebDAV 列表里。现补 `INTERNAL_DIR_MARKER` 判断，两处过滤点均已修正。

   - 已用系统 Chrome + CDP 真实渲染验证 5 项断言全过（标题 = 自定义名、登录框 Logo 指向
     `/api/branding/logo`、顶栏显示自定义名、favicon 换标），截图见
     `davflare-branding-login.png` / `davflare-branding-header.png`，脚本 `tools/verify-branding.mjs` + `tools/run-branding-check.sh`

---

## 三、fpk 工程结构（严格按飞牛官方规范）

```
davflare/
├── manifest                     应用清单（appname/version/platform=all/service_port…）
├── ICON.PNG                     64×64 图标
├── ICON_256.PNG                 256×256 图标
├── app/                         打包进 target/ 的运行文件
│   ├── server/server.cjs        后端单文件（esbuild 打包，无需 node_modules）
│   ├── www/                     前端 SPA 产物（upstream vite build）
│   └── ui/
│       ├── config               桌面入口（type: iframe, port: ${wizard_port}）
│       └── images/icon_{64,256}.png
├── cmd/                         生命周期脚本（官方模板九件套 + _common.sh）
│   ├── main                     start / stop / status，退出码 0/1/3
│   ├── install_init             安装前（no-op）
│   ├── install_callback         建目录 + 固化向导配置
│   ├── config_init              配置校验（端口、天数）
│   ├── config_callback          重写配置，运行中则自动重启
│   ├── upgrade_init             升级前（no-op，绝不删数据）
│   ├── upgrade_callback         补齐目录与新增配置项，保留旧值
│   ├── uninstall_init           卸载前（no-op）
│   ├── uninstall_callback       按向导选择保留/删除数据（带安全闸门）
│   └── _common.sh               配置读写唯一实现（非生命周期脚本）
├── config/
│   ├── privilege                run-as: package，专用用户 davflare
│   └── resource                 data-share: davflare、davflare/data
└── wizard/
    ├── install                  端口 / 数据目录 / 账号密码 / 匿名只读 / 站点域名…
    ├── config                   同一套字段，留空 = 保持不变
    ├── upgrade                  升级说明（数据全保留）
    └── uninstall                wizard_data_action = keep | delete
```

### manifest 关键字段

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `platform` | `all` | 包内不含架构相关二进制（纯 JS + 静态资源），x86 与 ARM 通用 |
| `install_dep_apps` | `nodejs_v24` | Node 运行时由应用中心提供，`cmd/main` 按优先级探测多个路径 |
| `service_port` | `8087` | 默认端口；实际以向导 `wizard_port` 为准 |
| `checkport` | `false` | 端口可由向导修改，由 `cmd/main start` 自行做占用检查 |
| `desktop_applaunchname` | `davflare.Application` | 与 `app/ui/config` 的入口 key 一致 |
| `ctl_stop` | `true` | 应用中心显示启停按钮 |
| `distributor` / `distributor_url` | `Davflare fnOS 适配` / `github.com/lanshatop/davflare-fnos` | 应用中心展示的发行方，指向本适配版仓库，用户可据此找到源码与更新；上游署名保留在 `maintainer*` 字段与 `LICENSE` |

### `cmd/main` 契约

- `start`：读配置 → 定位 node → 检查端口占用 → `nohup node server.cjs` → 写 PID → 等待端口就绪（进程退出即报错，超时但存活则交回应用中心轮询）
- `stop`：`SIGTERM`（服务端优雅关闭）→ 15 秒后 `SIGKILL`
- `status`：PID 文件 + `kill -0`，并用 `/proc/<pid>/cmdline` 校验确实是本服务（防 PID 复用误判）；退出码 **0 = 运行中，3 = 未运行**

### 卸载安全闸门

Davflare 允许把数据目录指向用户已有的 NAS 目录（如 `/vol1/SSD`）。因此卸载分三档：

1. 数据目录 = 应用自己的 data-share（`davflare`）→ 按用户选择整体清空
2. 数据目录在 `${TRIM_PKGVAR}` 内（兜底目录）→ 整体删除
3. **其它任何目录 → 只删 Davflare 自己的 `_$flaredrive$` 状态目录，用户文件一律保留**

已在本地模拟验证：指向用户目录时卸载「删除数据」，`我的论文.docx` 原样保留，仅 `_$flaredrive$` 被移除。

---

## 四、验证情况

| 项 | 结果 |
| --- | --- |
| `runtime/test/r2-fs.test.mjs` | 35 用例全绿（R2 语义逐条对齐） |
| `runtime/test/e2e.test.mjs` | 87 用例全绿（24 条上游路由 + 25 个 MCP 工具逐个核对 + 匿名 WebDAV 目录 6 项 + 任意主机站点访问 3 项 + 任意主机图床 1 项 + 品牌种子化 3 项） |
| `runtime/test/limits.test.mjs` | 8 用例全绿（单次直传上限控制面、流式落盘、超限后连接不被污染） |
| `runtime/test/branding.test.mjs` | 12 用例全绿（默认态、未登录 401、管理员 PUT/DELETE、API 密钥改品牌、favicon 覆盖与 TTL、分享落地页 / WebDAV 目录页注入品牌、内部目录不暴露、非法类型 415、超限 413） |
| **合计（后端）** | **142 通过 / 0 失败** |
| 前端 vitest 全量 | 1755 用例通过 / 0 失败（130 个测试文件；唯一失败项是「Chrome 扩展打包」用例，因本机缺 `zip` 命令，与改动无关） |
| 前端类型检查 | `tsc --noEmit` 通过 |
| 前端相关单测 | `App.test.tsx` 4 项 + `LoginDialog.test.tsx` 4 项全绿（登录页改动无回归） |
| 登录页真实渲染验证 | Chrome headless + CDP：未登录主界面/顶栏 `visibility=hidden`、遮罩不透明纸面底色（亮 `rgb(244,241,236)` / 暗 `rgb(23,19,16)`，opacity=1）、卡片描边生效；登录后主界面恢复、登录框消失 —— 8 项断言全过 |
| 品牌真实渲染验证 | Chrome headless + CDP：标签页标题 = 自定义名、登录框 Logo 指向 `/api/branding/logo`、顶栏显示自定义名、favicon 换标 —— 5 项断言全过 |
| 匿名 WebDAV 目录验证 | 接口级：目录页 200 / PROPFIND 207 / 文件 200 / 匿名 PUT 401 / 根目录 401；真实渲染（Chrome + CDP）：目录页加宽 1100px、条目渲染、品牌标 —— 3 项断言全过 |
| 匿名目录**生效开关**验证 | ① 运行时：配了目录名 + 开关 `0` 的三个实例并行起服，开关关闭的实例上目录页 / PROPFIND / 读文件全部 401，同实例带凭据仍 200（证明关的是匿名而非整个 WebDAV）；开关写成 `off` 词形同样关闭；开关缺省时保持启用（老配置向后兼容）<br>② 向导链路：沙箱直调 `davflare_write_config`，覆盖 7 个场景（新装 / 老配置升级 / 保持 / 关 / 开 / 只有开关没目录 / 填 `off` 清空目录名），写出的 `davflare.env` 逐项符合预期 |
| 大文件实测 | raw 单次 120MB → 201；WebDAV `PUT` 120MB → 201（HEAD `content-length` 一致）；分块 120MB → 200；磁盘实际写入 361MB |
| 公开目录发布实测 | plan → copy → finish 三步全通（`kind: dir`）；**任意主机验证**：未配 `SITES_HOST` 的网盘主机上 `/{slug}/` 直接返回站点内容（200，无需登录）、`/{slug}` 301 到 `/{slug}/`、子资源可读、未发布的 slug 仍回退网盘 SPA —— e2e 3 项断言全过 |
| 品牌种子化（安装向导）验证 | 首次启动写入 `BRAND_NAME` / `BRAND_LOGO_PATH`（`/api/branding` 公开可读、logo 经 `/api/branding/logo` 返回）；重启后向导旧值不覆盖界面配置 —— e2e 3 项断言全过 |
| 打包产物冒烟 | `/` 200 + `frame-ancestors *`（无 X-Frame-Options）；`/api/keys` Basic 签发；`/api/list` Basic→401、X-Api-Key→200；`mkdir` 201；`PROPFIND` 207；`/healthz` 200 |
| 生命周期模拟（mock `TRIM_*`） | install → start → status(0/3) → 重复 start 幂等 → config 改端口自动重启（旧端口关、新端口开、密码/域名/天数留空保留）→ stop → uninstall keep/delete 两档 → 用户目录安全闸门 |
| **真机实测（真实飞牛 NAS，局域网访问）** | 用真实账号逐项走查：WebDAV `MKCOL / PUT / GET / PROPFIND / COPY / MOVE / DELETE` 全通（含中文文件名、1 MiB 二进制逐字节一致、`Range` → 206、`If-None-Match` → 304）；`PUT` 300 MB → 201（5.6 s，无 100 MB / 2 GiB 上限）；`/api/keys` 签发密钥后 `/api/list`、`/api/upload`（multipart 与 raw，同名自动改名）全通；`/mcp` `initialize` + `tools/list` 通、无凭据 401；`/api/sites` 两种发布（`{slug,source}` 与 `dir` 三步 plan→copy→finish）均成功且**匿名可读**；分享（文件 + 带提取码目录）匿名可读；品牌 PUT / clearLogo 与 `/favicon.png` 全站换标生效后已还原 —— 本次由真机实测发现并修复了图床直链缺陷，验证数据已全部清理 |
| `fnpack build` | 通过，`davflare.fpk` **541,204 字节**（gzip tar，内含 app.tgz）；包内已核对 `manifest` 为 `version = 1.0.1` 且 `distributor_url` 指向本适配版仓库、`server.cjs` 含品牌路由与任意主机站点逻辑、向导含品牌字段、前端主 chunk 含品牌调用 |

> ⚠️ fnpack 在 Windows 上打包时文件权限位为 666（无执行位）。这是官方打包工具在非 POSIX 系统上的固有行为，fnOS 侧通过 `bash cmd/main` 方式调用脚本，不影响安装与运行；如在真机上遇到问题，可在 `cmd/install_callback` 里自行补 `chmod +x`。

---

## 五、从源码构建

```bash
# 前置：Node.js >= 20，飞牛官方 fnpack 1.2.3 在 PATH
cd upstream && npm install
cd ../runtime && npm install

# 一键构建
bash tools/build-fpk.sh
#  → davflare/davflare.fpk
```

图标由 `tools/make_icon.py`（Pillow）生成，也可手工替换 `ICON.PNG` / `ICON_256.PNG` / `app/ui/images/icon_{64,256}.png`（尺寸必须严格 64×64 与 256×256）。

## 六、安装

在 fnOS 上：

```bash
# 方式一：应用中心手动安装 davflare.fpk
# 方式二：命令行
appcenter-cli install-fpk davflare.fpk
```

安装向导会依次询问：

1. **基础配置**：服务端口（默认 8087）、数据目录（留空 = 应用共享目录 `davflare`，也可填 `/vol1/SSD` 这类已有目录）、是否允许桌面内嵌
2. **访问凭据**：管理员账号 / 密码（同时用于 WebDAV；未配置密码时受保护接口一律拒绝）
3. **可选功能**：匿名只读、匿名 WebDAV 目录（含生效开关）、站点/图床域名、回收站保留天数、内嵌来源、访问日志

安装后在飞牛桌面点 Davflare 图标即可打开；WebDAV 地址为 `http://<NAS>:<端口>/webdav/`。

卸载时可选「保留数据」或「删除数据」，具体删除范围见上文安全闸门。

---

## 七、上传限制 / 公开目录限制 / 账号密码

### 7.1 文件上传

| 通道 | 单文件上限（fnOS 版默认） | 说明 |
| --- | --- | --- |
| 网页端 ≥ 50MB | **无** | 自动切分块上传（每块 50MB，流式落盘、可断点续传、可跨刷新续传） |
| 网页端 < 50MB | **无** | 走 multipart 单次上传；正文需整体过一遍内存，所以只用于小文件 |
| WebDAV（映射盘 / Finder / 手机文件管理器） | **无** | 单次 `PUT` 已是流式落盘 |
| API 直传（`X-File-Name` 原始请求体） | **无** | 流式落盘；CLI / 浏览器扩展 / Remotely Save 走这条 |
| 分块上传（网页端 / CLI / MCP） | 单对象 5 TiB、最多 10000 块（R2 语义） | 每块 ≥ 5 MiB（末块除外） |
| 图床 `/api/images` | 单图 20 MB | 上游产品限制，未改动 |
| 文件收集 `/collect` | 每块 10 MiB | 上游四步协议，未改动 |

- 实测：raw 单次 120MB → `201`；WebDAV `PUT` 120MB → `201`；分块 120MB → `200`。
- 需要收紧时设置 `DAVFLARE_MAX_REQUEST_BYTES=<字节数>`（写入 `var/conf/davflare.env` 后重启应用），
  超限返回 `413`。默认 `0` 表示不限制。
- **注意**：multipart 单次上传（<50MB 那条路）正文必须整体进内存。虽然默认不限制，
  但传大文件请走分块上传或 WebDAV，不要依赖 multipart 直传。

### 7.2 发布为公开目录

「发布为公开目录」= `POST /api/sites` 的 `dir` 三步协议（`plan` → `copy` → `finish`），
会生成一个带文件列表与下载链接的浏览页。

**飞牛自托管版已取消上游的文件数 / 容量上限**（Cloudflare 时代的 500 文件 / 2 GiB 是 R2
子请求数与 CPU 配额的平台约束）：分批复制 + 流式落盘，**单文件大于 2 GB、总量数十 GB、
上千个文件都可以发布**，只受磁盘容量与发布计划有效期约束。

| 项 | 限制 | 来源 |
| --- | --- | --- |
| 文件数量 | **无上限**（上游为 500，已放开） | — |
| 总大小 / 单文件大小 | **无上限**（上游为 2 GiB，已放开；流式复制，支持 >2 GB 单文件） | — |
| 单批复制 | ≤ 60 个文件 | `SITE_PUBLISH_BATCH_MAX` |
| 发布计划有效期 | 24 小时（过期作废，重新发布即可） | `SITE_PUBLISH_PLAN_TTL_MS` |
| 目录层级 | 只发布所选目录的**当层**文件；子目录只记数量，不递归展开 | `isDirectChildKey` |
| 发布源 | 不能是站点自身目录 `sites/<slug>` | `planDirPublish` |
| 站点 slug | 小写字母、数字与连字符，以字母或数字开头，长度 ≤ 63 | `SLUG_RE` |
| 站点密码（可选） | ≤ 128 字符，仅存 SHA-256 | `SITE_PASSWORD_MAX_LEN` |
| 自定义域名（可选） | 必须是含点的 DNS 名（不能填 IP），一个域名只能绑一个 slug | `isValidHostname` |

另外两种发布形态沿用上游限额：**相册** ≤ 100 MB、**文档站** ≤ 200 个文件且 ≤ 100 MB；
普通文件夹发布（`{slug, source}`）本来就没有限制。

**访问地址（飞牛适配：任意主机直接打开，无需登录）**

发布后的站点在**任何一个能访问 NAS 的地址上都能直接打开** —— `http://192.168.1.10:8087/<slug>/`、
`http://fnos.local:8087/<slug>/` 都行，不需要登录，也**不再依赖「站点 / 图床域名」配置**。
原理：网盘界面是 hash 路由（`location.pathname` 不参与网盘导航），所以中间件在任意主机上
都可以安全地把 `/{slug}/…` 交给站点处理 —— 按 slug 探测放行，只有真实存在的已发布站点才会
被站点页接住，其余路径照旧落到网盘 SPA；带密码的站点仍会先要求站点密码。

「站点 / 图床域名」（`SITES_HOST`）在本适配版里**已不是必需项**：图床图片的公开直链
（`POST /api/images` 返回的 `url` / `markdown`）会**按你实际访问网盘的地址**拼 —— 形如
`http://<你的NAS地址>:8087/i/<id>`，协议与端口都对，上传完就能直接打开。不会再出现
「直链被写成 `https://<域名>/i/<id>`、那个域名在局域网根本解析不了、还缺端口」的情况。
原理与站点一致：`/i/{id}` 在任意主机上都按 id 提供图片（只对合法 id 读一次存储，
图片不存在或图床开关关闭时返回 404，不会落回网盘 SPA）。

| 项 | 说明 |
| --- | --- |
| 站点访问 | 任意主机 / IP 直接打开 `/<slug>/`，无需任何配置 |
| 图床直链 | 上传后按**当前访问地址**生成，开箱即用；「站点 / 图床域名」**留空即可**，不必再填 |
| 站点密码 | 在发布对话框或站点卡片里设置；设置后访问 `/<slug>/` 会弹出 Basic 认证 |

### 7.3 匿名只读 WebDAV 目录（可选，默认关闭）

想让某个文件夹不用账号密码就能被访问（比如给电视盒子、下载工具、访客投文件），
在 **应用中心 → Davflare → 设置** 里配置下面**两项**，设置页与安装向导都有：

| 字段 | 说明 |
| --- | --- |
| **启用匿名 WebDAV 目录**（开关） | 总开关。安装向导里默认开启，但目录名为空时同样不生效 |
| **匿名 WebDAV 目录（只读）**（文本） | 网盘根目录下已存在的文件夹名，例如 `public` 或 `共享文件`（不要带 `/`） |

**判定规则：目录名非空 _且_ 总开关开启，才生效**，任何一边不具备都不生效（运行时两级判断）。

| 配置组合 | 效果 |
| --- | --- |
| 开关开 + 目录 `public` | 访客打开 `http://<NAS>:8087/webdav/public/` 即可浏览/下载（浏览器目录页与 WebDAV 客户端挂载均可） |
| 开关开 + 目录 `共享文件` | 同上，地址为 `http://<NAS>:8087/webdav/共享文件/`（中文目录名同样支持） |
| 开关**关** + 目录 `public` | **匿名访问整体失效**（目录页 / PROPFIND / 读文件全部 401），但目录名配置保留，重新打开开关即恢复 |
| 开关开 + 目录留空 | 不生效（没有目标目录） |
| 目录填 `0` / `off` | 清空目录名（等价于永久关闭） |

**开关的实际行为**（这几个点容易踩）：

- 关掉开关是**停用而非删除**：`WEBDAV_PUBLIC_DIR` 原样保留在配置里，随时可以再打开 —— 这是应对「临时要映射到公网」这类场景的推荐做法；
- 开关关闭时运行时**完全不向处理器注入** `WEBDAV_PUBLIC_DIR`，处理器侧等同于「未配置」，而不是靠处理器再判断一次，因此不存在绕过开关的路径；
- 设置页的开关遵循「**留空或不改动即保持当前设置**」，和其它开关一致；由于向导不支持回显当前值，**设置页的开关默认显示为「关」**，想确保开启需要显式打开一次；
- 开关是后加的：**升级老配置**（只有目录名、没有开关）时按「有目录名即启用」处理，匿名目录不会因为升级而静默失效。

其余规则：

- **只读**：匿名只能 `GET` / `HEAD` / `PROPFIND`（浏览与下载）；`PUT` / `DELETE` / `MKCOL` 等写入仍要求管理员凭据（401）；
- **隔离**：匿名只能看到这一个文件夹（含其子文件夹），目录外与 WebDAV 根目录仍一律 401；路径穿越（`%2e%2e`）也拿不到目录外内容；
- **前提**：文件夹必须真实存在于网盘根目录（先在网页端或 WebDAV 里建好）；
- **安全提示**：这是全网盘唯一无需凭据即可读取的位置，不要把私密文件放进去；
  客户端挂载示例（以 Rclone 为例）：`rclone ls :http:public --http-url http://<NAS>:8087`。

**与「允许匿名只读访问」的区别**：设置页还有一个 `WEBDAV_PUBLIC_READ` 开关，那是**整个网盘**匿名只读，
风险量级远大于本节的单目录，两者互不影响，请勿混淆。

**关于公网暴露（重要）**：服务默认监听 `0.0.0.0` 且没有 IP 白名单，端口映射到公网后匿名目录会直接对全网开放。
运行时目前**没有失败限流、也没有 TLS**，因此不建议直接映射 8087。若确需公网访问，建议：

1. 前置带 HTTPS 的反向代理（fnOS 网关 / Nginx / cloudflared / Tailscale），不要在路由器上裸映射 8087；
2. 公网分享优先改用「**分享链接 + 提取码**」而非匿名目录（有门槛、可撤销、可设有效期）；
3. 不确定是否长期需要时，**把本开关关掉**，需要时再打开。

### 7.4 默认账号与密码

| 项 | 值 |
| --- | --- |
| 默认账号 | `admin`（安装向导里的预填值，可改成别的） |
| 默认密码 | **没有默认密码** —— 安装向导「访问凭据」步骤必填，至少 6 位 |
| 未设密码会怎样 | 上游鉴权是 fail-closed：受保护接口（文件列表、上传、WebDAV…）一律拒绝 |
| 存放位置 | `/var/apps/davflare/var/conf/davflare.env`（用户名，权限 600）<br>`/var/apps/davflare/var/conf/password`（密码明文，权限 600，仅本机 root 可读） |
| 用途 | Web 界面登录、WebDAV 挂载（同一组凭据）、分享管理、应用设置 |
| 修改方式 | 应用中心 → Davflare → 设置；**留空的字段保持不变**，只改你想改的 |
| 匿名只读 | 安装向导可选开启（默认关闭）；开启后访客可浏览下载，但不能上传/修改/删除 |
| 匿名 WebDAV 目录 | 需「总开关开启 + 填了目录名」两项同时具备（默认关闭）；只读、且只限该目录。想临时停用只关开关即可，目录名保留 —— 见 §7.3 |

### 7.5 修改品牌名称与 Logo

应用内的品牌（顶栏名称、登录框、浏览器标签标题、favicon，以及分享页 / 收集页 / 站点页 / WebDAV 目录页）
都可换成你自己的名称与图标。有**两个入口**：

**入口一：安装向导（首次安装时）**

「可选功能」步骤里有 **品牌名称** 与 **品牌 Logo 图片路径** 两个字段：

| 字段 | 填写示例 | 说明 |
| --- | --- | --- |
| 品牌名称 | `家庭云盘` | 登录页、顶栏、标签页与全部直出页面显示的名称；留空 = 默认 `Davflare` |
| 品牌 Logo 图片路径 | `/vol1/1000/logo.png` | NAS 上已存在的图片文件绝对路径，支持 png / jpg / gif / webp / svg / ico，≤ 2 MB；留空 = 默认云朵图标 |

⚠️ **生效时机**：这两个字段只在数据目录**首次初始化**（还没有品牌配置）时写入。
已安装过的应用重新跑向导**不会**覆盖现有品牌 —— 想改品牌请用入口二，
或删除数据目录里的 `_$flaredrive$/branding.json` 后重启（慎用，会同时清掉 Logo）。

**入口二：网盘「设置 → 品牌」（推荐，随时可改）**

1. 登录后打开 **设置 → 品牌**（`BrandingCard`）
2. **名称**：填你想显示的名字（≤ 40 字），留空 = 恢复默认 `Davflare`
3. **Logo**：选择本地图片（png / jpeg / webp / gif / svg，≤ 2 MB），保存后立即生效
4. **恢复默认**：一键回到内置品牌
5. 保存后**无需重启**：浏览器打开会刷新，其余直出页面下一次请求即生效
   （静态图标覆盖带 3 秒缓存，最多 3 秒后全部换标）

对应接口（也可用 API 密钥脚本化改品牌）：

```bash
# 查看当前品牌（公开）
curl http://<NAS>:8087/api/branding

# 修改名称与 Logo（管理员）
curl -u admin:<密码> -X PUT http://<NAS>:8087/api/branding \
     -F 'name=家庭云盘' -F 'logo=@./logo.png'

# 恢复默认
curl -u admin:<密码> -X DELETE http://<NAS>:8087/api/branding
```

品牌配置存放在数据目录的 `_$flaredrive$/branding.json` 与 `_$flaredrive$/branding/logo.<ext>`，
升级与迁移时随数据一起带走；卸载时按 §三 的「卸载安全闸门」处理，不会误删用户文件。

---

## 八、许可与致谢

### 8.1 许可

本项目采用 **MIT 许可证**，全文见仓库根目录 [`LICENSE`](./LICENSE)。

由于 MIT 要求保留原作者的版权与许可声明，仓库根目录的 `LICENSE` 中同时列出了上游版权与本适配版权：

```
Copyright (c) 2026 Siyu Long — Davflare 上游项目
Copyright (c) 2026 lanshatop  — 飞牛 fnOS 适配版（本仓库）
```

上游源码位于 `upstream/`，**原样保留、未作删改**，其原始许可证文件
[`upstream/LICENSE`](./upstream/LICENSE) 一并保留不动。

> 若要用于商业分发或闭源产品，MIT 允许这样做，但请务必保留上述版权声明与许可全文
> （放在「关于」页、随附文件或源码中均可）。

### 8.2 来源与致谢

| 项目 | 作者 | 说明 |
| --- | --- | --- |
| [Davflare](https://github.com/fanchenggang/Davflare) | [Siyu Long](https://github.com/fanchenggang) | **本项目的上游**。Cloudflare R2 文件管理器 / 分享服务，MIT 许可 |
| [longern/FlareDrive](https://github.com/longern/FlareDrive) | [longern](https://github.com/longern) | Davflare 最初的 fork 来源。内部对象前缀 `_$flaredrive$/` 沿用自此 |
| [r2-webdav](https://github.com/abersheeran/r2-webdav) | [abersheeran](https://github.com/abersheeran) | WebDAV 实现参考 |
| [HamHome](https://github.com/bingoYB/ham_home) | [bingoYB](https://github.com/bingoYB) | 书签库交互参考 |

### 8.3 本适配做了什么

本仓库在上游基础上完成的移植与增强，逐条对应前文：

- **§二 平台耦合点替换**：把 Cloudflare Pages Functions + R2 换成 NAS 本地的 Pages 运行时与文件系统，
  前端 SPA 产物零裁剪
- **§三 fpk 工程**：按飞牛官方规范打包的 `davflare/` 工程与一键构建脚本 `tools/build-fpk.sh`
- **§2.6 / §7.5 品牌自定义**：名称 + Logo（上游硬编码 `Davflare`），安装向导即可配置
- **§7.1 取消上传限额**：去掉公开目录发布的 500 文件 / 2 GiB 限制，复制改流式，支持 >2 GB 单文件
- **§7.2 站点免登录**：站点在任意主机 / IP 上直接打开，无需配置域名
- **§7.3 匿名只读 WebDAV 目录**：`WEBDAV_PUBLIC_DIR` + 生效开关，默认关闭
- **WebDAV 目录浏览页加宽**：760px → 1100px
- **图床直链修正**：直链按实际访问地址拼接（协议 / 主机 / 端口都对），不再写死 `https://<SITES_HOST>`

### 8.4 免责声明

- 本项目是个人移植作品，**与 Cloudflare、飞牛（fnOS）官方均无隶属或背书关系**。
- 「飞牛」「fnOS」等名称与商标归其各自权利人所有，本项目仅在描述兼容性时使用。
- 软件按「原样」提供，不附带任何担保。请自行评估数据安全风险，
  **重要数据务必备份**；对公网暴露 WebDAV / 匿名目录前请先阅读 §7.3 的安全提示。


