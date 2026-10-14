#
# Davflare —— OpenWrt 包定义
#
# 这是标准的 OpenWrt package feed 形式：把本目录放到 OpenWrt 源码树的
# package/ 下（或做成 feed），即可用 SDK/buildroot 构建：
#
#   opkg 目标（OpenWrt 24.10 及更早）: make package/davflare/compile
#   apk  目标（OpenWrt 25.12 及更新）: make package/davflare/compile
#
# 同一份 Makefile 会按目标自动产出 .ipk 或 .apk —— 这正是 OpenWrt 官方的做法，
# 而不是手工拼包。仓库里 openwrt/tools/ 下的脚本是为了在没有 SDK 的环境
# 也能直接产出这两种安装包，二者内容一致。
#
include $(TOPDIR)/rules.mk

PKG_NAME:=davflare
PKG_VERSION:=1.0.4
PKG_RELEASE:=1

PKG_LICENSE:=MIT
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=lanshatop <lanshatop@users.noreply.github.com>

# 运行时是 esbuild 打好的单文件 JS（第三方依赖 fflate / @xmldom/xmldom 已内联，
# 无原生模块），所以按「预编译产物」处理，不需要交叉编译，一个包全架构通用。
PKG_SOURCE:=davflare-openwrt-$(PKG_VERSION).tar.gz
PKG_SOURCE_URL:=https://github.com/lanshatop/davflare-fnos/releases/download/v$(PKG_VERSION)
PKG_HASH:=4e198a696a756cd4d8c38ec384ee3901550b3fcfd9d7acef76f262cddb08547c

PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)
PKGARCH:=all

include $(INCLUDE_DIR)/package.mk

define Package/davflare
  SECTION:=utils
  CATEGORY:=Utilities
  SUBMENU:=File Transfer
  TITLE:=Davflare - 自托管文件管理 / WebDAV / 分享 / 图床 / 静态站点
  URL:=https://github.com/lanshatop/davflare-fnos
  # node 不在 OpenWrt 官方 feed 里（2025-03 起官方源把 nodejs 改为编译期专用），
  # 需要先添加第三方 node feed，见 openwrt/README.md。
  # 本包 PKGARCH:=all，构建系统不会自动补 libc，所以显式写上。
  DEPENDS:=+libc +node
  PKGARCH:=all
endef

define Package/davflare/description
 Davflare 是基于对象存储语义的文件管理器与分享服务。本包把原本依赖
 Cloudflare Pages Functions + R2 的后端完整搬到本地 Node.js 上运行：
 文件管理（含大文件分块续传与 Range 断点下载）、WebDAV 服务端、
 分享链接（提取码/有效期/ZIP 打包）、回收站、静态站点发布、图床、
 文件收集、API 密钥与 MCP（25 个工具）、整库备份。
 数据完全留在本机，不依赖任何云服务。
endef

define Package/davflare/conffiles
/etc/config/davflare
endef

define Build/Compile
	# 预编译产物，无需编译
endef

define Package/davflare/install
	$(INSTALL_DIR) $(1)/usr/lib/davflare
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/server.cjs $(1)/usr/lib/davflare/server.cjs
	$(INSTALL_DIR) $(1)/usr/lib/davflare/www
	$(CP) $(PKG_BUILD_DIR)/www/. $(1)/usr/lib/davflare/www/

	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/davflare.init $(1)/etc/init.d/davflare

	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/davflare.config $(1)/etc/config/davflare

	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./files/davflare.uci-defaults $(1)/etc/uci-defaults/99-davflare
endef

# 不用手写 postinst / prerm：OpenWrt 会为每个包自动生成官方样板
#   （opkg 侧：. /lib/functions.sh; default_postinst $0 $@
#     apk  侧：多两行 export root/pkgname 再调 default_postinst）
# 已核对 464xlat / base-files / procd / ca-bundle / luci-lib-base 的 ipk，
# 全部带这套一模一样的样板。default_postinst() 会依据包内文件清单自动
# 执行 /etc/uci-defaults/*、并把 /etc/init.d/davflare enable + start，
# 所以这里什么都不用做；手写反而会在两种包格式间产生差异。
#
# （openwrt/tools/build-openwrt-packages.py 不走 OpenWrt 构建系统，
#   所以那份脚本会显式写出对应格式的样板。）

$(eval $(call BuildPackage,davflare))
