# Davflare for OpenWrt

把 Davflare 装到 OpenWrt 路由器上：文件管理器、WebDAV 服务端、分享链接、图床、
静态站点发布、回收站、API 密钥与 MCP，数据全部留在路由器本机。

应用代码**零改动** —— 上游那份 `runtime/dist/server.cjs` 直接复用，适配工作全部
落在 OpenWrt 这一侧：用 **procd + uci** 替换掉飞牛 fnOS 那套
`nohup + pidfile + bash /dev/tcp` 的生命周期管理。

---

## 1. 装哪个包？

| 你的 OpenWrt 版本 | 包管理器 | 用哪个文件 |
| --- | --- | --- |
| **24.10 及更早** | opkg | `davflare_<版本>-r1_all.ipk` |
| **25.12 及更新** | apk (apk-tools 3) | `davflare-<版本>-r1.apk` |

两个包的内容**完全相同**，只是封装格式不同：

* `.ipk` 是「tar 套 tar」（外层 `debian-binary` / `data.tar.gz` / `control.tar.gz`），
  与 OpenWrt `scripts/ipkg-build` 的输出逐条对齐；
* `.apk` 是 apk-tools 3 的二进制 **adb** 格式（`ADBd` + raw deflate 流 + 类型化块），
  按 apk-tools 的 schema 逐字段生成。

包是 `PKGARCH=all`（apk 侧写作 `noarch`），一个文件全架构通用，不需要交叉编译 ——
因为服务端是 esbuild 打好的单文件 JS，第三方依赖（`fflate`、`@xmldom/xmldom`）
已内联，没有任何原生模块。

---

## 2. 先解决 Node.js 依赖

**这是唯一的前置条件，也是最容易卡住的一步。**

OpenWrt 官方 `packages` feed 从 2025 年 3 月起把 Node.js 改成了 **仅编译期使用**
（host package），不再打进固件 —— 也就是说官方的源里装不到 `node`。

### 方案 A：加第三方 node feed（推荐）

社区维护的 [nxhack/openwrt-node-packages](https://github.com/nxhack/openwrt-node-packages)
把 Node.js 重新做成了可安装的固件包：

```sh
# 1. 添加 feed（OpenWrt 源码树根目录下执行）
echo 'src-git node https://github.com/nxhack/openwrt-node-packages.git' >> feeds.conf.default
# 24.10 及更早请改用对应分支，例如：
#   src-git node https://github.com/nxhack/openwrt-node-packages.git^openwrt-24.10

# 2. 更新并安装
./scripts/feeds update node
rm -f ./package/feeds/packages/node ./package/feeds/packages/node-* 2>/dev/null
./scripts/feeds install -a -p node

# 3. 进 menuconfig 勾上 Languages → node → node（以及 node-npm 可选）
make menuconfig
make -j$(nproc)
```

刷入新固件后 `node -v` 应能看到 v20 以上。

### 方案 B：直接把 node 编进固件

如果只想要一个固件、不想维护本地 feed，也可以在 `make menuconfig` 里
把 `node` 选成 `<*>`（内建）。构建 Node.js 很吃内存和时间，宿主机建议 ≥ 8 GB 内存。

### 已知跑不起来的硬件

Node.js 的 V8 JIT 会生成浮点指令，**没有硬件 FPU 的目标跑不了**：

* MIPS：`ar71xx` / `ar933x` / `mt76x8`（老款 4/8 MB 闪存路由）
* ARM：没有 vfp / neon 的核心，例如 `bcm53xx`

官方支持的架构是 **aarch64、arm（带 vfp/neon）、x86_64**。

### 内存要求

Node.js 空跑就要几十 MB 常驻内存，Davflare 还要处理上传/下载：

* **建议 ≥ 256 MB 可用内存**；
* 128 MB 级别的设备需要在 uci 里收紧 V8 堆（见下面 `node_options`），
  或者干脆加一块 swap；
* WebDAV 挂载浏览大量文件、以及大文件分块上传都会明显吃内存。

---

## 3. 安装

把包传到路由器（`scp` 或 U 盘），然后：

```sh
# OpenWrt 25.12+（apk）
apk add --allow-untrusted ./davflare-1.0.4-r1.apk

# OpenWrt 24.10 及更早（opkg）
opkg install ./davflare_1.0.4-r1_all.ipk
```

> `.apk` 本身不带签名块 —— 这与 OpenWrt 官方仓库里的包一致（已核对 25.12 的
> `ca-bundle.apk` 等）。本地安装时如果 apk 提示信任问题，加上
> `--allow-untrusted` 即可。

装完会看到一段提示，里面有访问地址和**自动生成**的 WebDAV 密码：

```
davflare: 安装完成，服务即将启动。
          网盘/图床/分享：http://<路由器地址>:8087/
          WebDAV：        http://<路由器地址>:8087/webdav/
          账号：          admin / a1b2c3d4e5f6
          数据目录：      /srv/davflare/files（默认在 overlay 闪存上，建议改到外置挂载点）
```

密码不会用弱口令做默认值 —— 首次安装时随机生成（`openssl rand -hex 6`，
没有 openssl 时退回 `/dev/urandom`）。随时可以用
`uci get davflare.main.password` 查回来。

---

## 4. 配置

配置文件是 `/etc/config/davflare`，全部选项如下（改完
`/etc/init.d/davflare reload` 或 `restart` 生效）：

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `1` | 总开关。置 0 只停服务，配置保留 |
| `port` | `8087` | 监听端口 |
| `host` | `0.0.0.0` | 监听地址。只想内网访问可改成一个具体地址 |
| `data_dir` | `/srv/davflare/files` | **网盘里的文件都放这里** |
| `state_dir` | `/srv/davflare` | meta（对象元数据）与 tmp（分块上传暂存）的父目录 |
| `meta_dir` | 空 | 留空 = `$state_dir/meta` |
| `tmp_dir` | 空 | 留空 = `$state_dir/tmp` |
| `username` | `admin` | 管理后台 / WebDAV 账号 |
| `password` | 随机生成 | 鉴权是 **fail-closed**：密码为空时所有受保护接口一律拒绝 |
| `public_read` | `0` | 允许匿名只读访问整个网盘 |
| `public_dir` | 空 | 匿名只读的 WebDAV 目录（网盘根下的文件夹名） |
| `public_dir_on` | `1` | 上面那个目录的生效开关 |
| `allow_iframe` | `0` | 是否允许被 iframe 内嵌 |
| `log` | `0` | 是否逐请求写日志（排障用） |
| `max_request_bytes` | `0` | 单次请求体上限，0 = 不限 |
| `node_options` | 空 | 传给 node 的启动参数，见下 |
| `brand_name` | 空 | 品牌名（改登录页/顶栏/标题） |
| `sites_host` | 空 | 静态站点的自定义域名，留空 = 用 IP:端口 访问 |
| `trash_retention_days` | 空 | 回收站自动清理天数，留空 = 不自动清理 |

### ⚠️ 一定要改 `data_dir`

默认值 `/srv/davflare` 落在 **overlay（路由器闪存）** 上。路由器闪存通常只有
几十 MB 且写入寿命有限，拿它当网盘用会很快写满、还会加速磨损。

正确做法是指到外置存储的挂载点：

```sh
uci set davflare.main.data_dir='/mnt/sda1/davflare/files'
uci set davflare.main.state_dir='/mnt/sda1/davflare'
uci commit davflare
/etc/init.d/davflare restart
```

`meta` 与 `tmp` 必须和 `data_dir` 在**同一个存储**上（分块上传的暂存和最终
落盘要能原子改名），所以别把它们单独放到闪存上。

### 低内存设备

```sh
uci set davflare.main.node_options='--max-old-space-size=128 --optimize_for_size'
uci commit davflare
/etc/init.d/davflare restart
```

---

## 5. 服务管理

服务由 OpenWrt 的 **procd** 托管，不用 `nohup`、没有 pidfile：

```sh
/etc/init.d/davflare start
/etc/init.d/davflare stop
/etc/init.d/davflare restart
/etc/init.d/davflare reload     # 重读 uci 配置
/etc/init.d/davflare enable     # 开机自启（安装时已自动 enable）
/etc/init.d/davflare disable
```

崩溃会被自动拉起（`respawn 3600 5 5`），日志走 syslog：

```sh
logread -e davflare          # 只看 davflare 的日志
logread -f -e davflare       # 持续跟踪
```

开 `option log '1'` 会把每个 HTTP 请求也写进 syslog；日常建议关掉，否则
`logread` 会被刷屏，而且 syslog 在内存里，写太多没意义。

---

## 6. 从源码构建

### 方式一：用 OpenWrt SDK（官方、推荐）

`dist-openwrt/davflare-openwrt-<版本>.tar.gz` 就是给 SDK 用的源码包
（内含 `server.cjs` + `www/` + `LICENSE`）。把它放进 `package/davflare/`：

```sh
# 从 OpenWrt 下载页取对应版本 SDK，解压后：
cd openwrt-sdk-*/
mkdir -p package/davflare
cp -r /path/to/openwrt/package/davflare/files package/davflare/
cp /path/to/openwrt/package/davflare/Makefile package/davflare/
cp /path/to/davflare-openwrt-1.0.4.tar.gz dl/
make package/davflare/compile V=s
# 产物在 bin/packages/<架构>/base/davflare_*.ipk 或 .apk
```

同一份 Makefile 会**按目标自动**产出 `.ipk` 或 `.apk` —— 这正是 OpenWrt 官方
包的做法。`PKG_HASH` 已经按源码包的真实 sha256 填好，可以直接用。

### 方式二：用仓库里的工具（无需 SDK）

`openwrt/tools/` 下有一套纯 Python 的实现，不依赖 OpenWrt 构建环境、
也不需要 Linux、`fakeroot`、`abuild`、`apk-tools`：

```sh
# 一次产出 .ipk + .apk + SDK 源码包到 dist-openwrt/
python3 openwrt/tools/build-openwrt-packages.py

# 也可以只出其中一种
python3 openwrt/tools/build-openwrt-packages.py --only ipk
python3 openwrt/tools/build-openwrt-packages.py --only apk

# 检查一个 .apk 的结构（字段、目录/文件表、DATA 块、哈希）
python3 openwrt/tools/adb_pack.py check dist-openwrt/davflare-1.0.4-r1.apk

# 打印一个 .apk 的完整结构
python3 openwrt/tools/adb_pack.py dump dist-openwrt/davflare-1.0.4-r1.apk
```

* `adb_pack.py` —— apk v3（adb 格式）的读/写/校验实现；
* `mk_ipk.py` —— opkg `.ipk` 打包器；
* `build-openwrt-packages.py` —— 把上面两个串起来，读 `davflare/manifest`
  的版本号，组装 staging 文件表，产出三种东西，并把源码包的 sha256 回写
  `Makefile` 的 `PKG_HASH`。

构建是**可复现**的：所有时间戳固定为 `SOURCE_EPOCH=1760000000`，
gzip 用 `-n`（无文件名、无时间戳），连打两次产物 sha256 完全一致。

---

## 7. 包结构

```
/etc/config/davflare                  uci 配置（conffile，升级不覆盖）
/etc/init.d/davflare                  procd 服务脚本
/etc/uci-defaults/99-davflare         首次安装的一次性初始化（执行后自动删除）
/usr/lib/davflare/server.cjs          服务端（esbuild 单文件，701 KB）
/usr/lib/davflare/www/                前端构建产物
/lib/apk/packages/davflare.list       apk 侧的文件清单（见下）
```

### 为什么 apk 包里要多一个 `.list`

opkg 在安装时会自己生成 `/usr/lib/opkg/info/<包名>.list`，**但 apk 不会**
（apk-tools 源码里没有任何生成 `.list` 的逻辑）。而 OpenWrt 的
`default_postinst()` 正是靠这个清单文件去发现包里的
`/etc/uci-defaults/` 和 `/etc/init.d/` 条目 —— 没有它，首次初始化不会执行、
服务也不会被 enable/start。所以 apk 包必须自带一份，
内容为「所有安装文件的绝对路径，按 `strcmp` 排序，每行一个，不含它自己」。

### 安装脚本用的是官方样板

`postinst` / `prerm` 不自己造轮子。OpenWrt 会为**每个**包自动生成这套样板
（已核对 `464xlat` / `base-files` / `procd` / `ca-bundle` / `luci-lib-base`
的 ipk，全都带一模一样的脚本），所以 `package/davflare/Makefile` 里**没有**
也**不需要**写它们 ——

```sh
#!/bin/sh
[ "${IPKG_NO_SCRIPT}" = "1" ] && exit 0
[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0
. ${IPKG_INSTROOT}/lib/functions.sh
default_postinst $0 $@
```

跑 uci-defaults、`uci commit`、把 `/etc/init.d/davflare` enable + start，
全都交给 `/lib/functions.sh` 里的 `default_postinst()`。apk 侧样板多两行
`export root/pkgname`，因为那两个函数直接读这两个变量。

> `openwrt/tools/build-openwrt-packages.py` 不走 OpenWrt 构建系统，
> 所以它会**显式**写出对应格式的样板（`.ipk` 用 opkg 版、`.apk` 用 apk 版），
> 内容与官方生成的一模一样。这样手工做的包和 SDK 做出来的包行为完全一致。

---

## 8. 排障

**服务起不来，`logread -e davflare` 看到「未找到 Node.js 运行时」**
没装 node。回到第 2 节加 feed 并编译。也可以先手工确认：
`command -v node && node -v`。

**「安装包不完整」**
`/usr/lib/davflare/server.cjs` 或 `www/` 缺失。重新安装一次；
若是自己改过包，检查 `build-openwrt-packages.py` 的 `collect_payload()`
里 staging 路径有没有对。

**进程反复重启，日志里有 OOM / `JavaScript heap out of memory`**
内存不够。设 `node_options='--max-old-space-size=64 --optimize_for_size'`
试试，或加 swap。也要检查 `max_request_bytes` 是不是放得太宽。

**上传大文件失败 / 闪存被写满**
`data_dir` 还在默认的 `/srv/davflare`（overlay）上。改成外置挂载点。

**WebDAV 挂载后所有请求 401**
密码没设或设成了空 —— 鉴权是 fail-closed，空密码会全部拒绝。
`uci get davflare.main.password` 看一下，没有就补一个。

**升级后配置被覆盖了**
不应该发生：`/etc/config/davflare` 在 `conffiles` 里，opkg/apk 都会保留用户改动。
如果你手工 `rm` 过它，重装后 uci-defaults 会重新生成一份（含新的随机密码）。

**卸载**

```sh
apk del davflare            # 或 opkg remove davflare
```

卸载**不会**删掉 `data_dir` —— 你的文件还在那儿。要清干净得自己删。
`pre-deinstall` 只会 stop + disable 服务。

---

## 9. 与飞牛 fnOS 版的差异

| | 飞牛 fnOS | OpenWrt |
| --- | --- | --- |
| 进程管理 | `nohup` + pidfile + `cmd/*` 脚本 | procd（`USE_PROCD=1`） |
| 配置 | `TRIM_*` 环境变量 + 安装向导 | uci（`/etc/config/davflare`） |
| 端口探测 | `bash` 的 `/dev/tcp` | procd 原生 |
| 日志 | `$APP_DIR/var/davflare.log` | syslog（`logread -e davflare`） |
| 首次初始化 | 安装向导 | `/etc/uci-defaults/99-davflare` |
| 前端入口 | 飞牛桌面内嵌 | 浏览器直接访问 `http://<地址>:8087/` |
| 运行时配置 | 同一套 `DAVFLARE_*` / `WEBDAV_*` 环境变量 | ← 完全相同，应用代码零改动 |

不适合搬到 OpenWrt 的是飞牛那套 `cmd/*`：它依赖 `TRIM_*` 环境变量、
`bash` 的 `/dev/tcp` 探活和 pidfile 约定，这些在 OpenWrt 上都不存在，
所以整层替换成了 procd + uci。

---

## 10. 已验证的事项

打包工具链本身经过这些验证（都不是"看起来对"，是逐字节比对过的）：

* **apk 结构**：官方 25.12 的 `ca-bundle.apk` / `464xlat-13.apk` /
  `adb-enablemodem.apk` 用本项目的解析器读出来，再用本项目的写入器重建，
  **pkginfo 全字段、目录表（含所有中间目录与根节点）、文件顺序、大小、
  mtime、SHA256 哈希、符号链接 target、ACL 全部一致，DATA 块内容逐字节一致**；
  重建后的内层 ADB 载荷长度与官方**完全相同**（1536→1536、1604→1604）。
* **ipk 结构**：外层成员顺序（`debian-binary` → `data.tar.gz` → `control.tar.gz`）、
  内层 `./` 前缀与成员排序、`gzip -n` 头（`1f8b08000000000000 03`）、
  control 字段顺序（`… Architecture / Installed-Size / Description`，
  `Description` 恒为末位）与官方 `ca-bundle_*_all.ipk`、
  `luci-lib-base_*_all.ipk` 逐行对齐。
* **可复现**：连续构建两次，三种产物的 sha256 完全一致。
