#!/usr/bin/env python3
"""把 Davflare 打成 OpenWrt 的 .apk 与 .ipk 安装包。

一次产出三样东西（都在 dist-openwrt/ 下）：

* ``davflare-<ver>-r1.apk``           OpenWrt 25.12+（apk / apk-tools 3）
* ``davflare_<ver>-r1_all.ipk``       OpenWrt 24.10 及更早（opkg）
* ``davflare-openwrt-<ver>.tar.gz``   给 OpenWrt SDK 用的源码包（含 server.cjs + www）

两种安装包的内容完全一致（同一个 staging 文件表），只是封装格式不同：
apk 走 adb 二进制格式（见 adb_pack.py），ipk 走 tar 套 tar（见 mk_ipk.py）。
同时会把计算出来的 sha256 写回 ``package/davflare/Makefile`` 的 PKG_HASH。

几处按官方行为对齐、容易踩坑的地方
----------------------------------

1. **全架构标记在两侧不同名**：opkg（ipk）用 ``all``，apk 用 ``noarch``。
   apk 的 ``apk_db_arch_compatible()`` 只认 ``noarch``，写成 ``all`` 会被判定为
   ``uninstallable``，包直接装不上。

2. **apk 必须自带文件清单** ``/lib/apk/packages/<pkg>.list``。
   opkg 会在安装时自己生成 ``/usr/lib/opkg/info/<pkg>.list``，但 apk 不会
   （apk-tools 源码里没有任何生成 .list 的逻辑）。而 OpenWrt 的
   ``default_postinst()`` 正是靠这个清单文件去发现 ``/etc/uci-defaults/`` 与
   ``/etc/init.d/`` 条目 —— 没有它，首次初始化不会跑、服务也不会被 enable/start。
   清单内容为「所有安装文件的绝对路径，按 strcmp 排序，每行一个，不含它自己」。

3. **包脚本用官方样板**：postinst 只负责 ``. /lib/functions.sh`` 再调
   ``default_postinst``，把跑 uci-defaults、enable/start 服务这些事情交给框架，
   而不是自己写一套。apk 侧的样板比 ipk 侧多两行 ``export root/pkgname``。

4. **Installed-Size**：apk 侧与 apk-tools 的 ``mkpkg`` 完全一致 —— 所有文件内容
   字节数之和（含 .list）。ipk 侧 OpenWrt 用的是 ``du`` 口径（含目录占用的块），
   这里刻意改用精确的内容字节和：opkg 只把它当展示/容量参考，不做校验，精确值
   更直观也更可复现。

用法::

    python3 openwrt/tools/build-openwrt-packages.py            # 全部产出
    python3 openwrt/tools/build-openwrt-packages.py --only ipk # 只出 ipk
"""

from __future__ import annotations

import argparse
import hashlib
import io
import os
import re
import sys
import tarfile
from typing import Dict, List, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
OPENWRT_DIR = os.path.dirname(HERE)
REPO = os.path.dirname(OPENWRT_DIR)
PKG_DIR = os.path.join(OPENWRT_DIR, "package", "davflare")
FILES_DIR = os.path.join(PKG_DIR, "files")
OUT_DIR = os.path.join(REPO, "dist-openwrt")

sys.path.insert(0, HERE)
import adb_pack  # noqa: E402
import mk_ipk as ipk  # noqa: E402

# --- 元数据 ---------------------------------------------------------------

PKG_NAME = "davflare"
SECTION = "utils"
LICENSE = "MIT"
MAINTAINER = "lanshatop <lanshatop@users.noreply.github.com>"
URL = "https://github.com/lanshatop/davflare-fnos"
DESCRIPTION = ("自托管文件管理器 / WebDAV / 分享 / 图床 / 静态站点。"
               "把原本依赖 Cloudflare Pages + R2 的后端完整搬到本地 Node.js 运行，"
               "数据完全留在本机。")
DEPENDS = ["libc", "node"]

# opkg 与 apk 对「架构无关」的叫法不同，不能混用
ARCH_IPK = "all"
ARCH_APK = "noarch"

SOURCE_EPOCH = 1760000000          # 固定时间戳，保证产物可复现
APK_LIST_PATH = "lib/apk/packages/%s.list" % PKG_NAME

# --- 包脚本：完全照搬 OpenWrt 自己生成的样板 ------------------------------

# ipk / opkg：/usr/lib/opkg/info/<pkg>.{postinst,prerm}
IPK_POSTINST = """#!/bin/sh
[ "${IPKG_NO_SCRIPT}" = "1" ] && exit 0
[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0
. ${IPKG_INSTROOT}/lib/functions.sh
default_postinst $0 $@
"""

IPK_PRERM = """#!/bin/sh
[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0
. ${IPKG_INSTROOT}/lib/functions.sh
default_prerm $0 $@
"""

# apk：多两行 export，因为 default_postinst/default_prerm 直接读 $root/$pkgname
APK_POSTINST = """#!/bin/sh
[ "${IPKG_NO_SCRIPT}" = "1" ] && exit 0
[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0
. ${IPKG_INSTROOT}/lib/functions.sh
export root="${IPKG_INSTROOT}"
export pkgname="%(name)s"
add_group_and_user
default_postinst
""" % {"name": PKG_NAME}

APK_PRERM = """#!/bin/sh
[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0
. ${IPKG_INSTROOT}/lib/functions.sh
export root="${IPKG_INSTROOT}"
export pkgname="%(name)s"
default_prerm
""" % {"name": PKG_NAME}

APK_POSTUPGRADE = """#!/bin/sh
export PKG_UPGRADE=1
[ "${IPKG_NO_SCRIPT}" = "1" ] && exit 0
[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0
. ${IPKG_INSTROOT}/lib/functions.sh
export root="${IPKG_INSTROOT}"
export pkgname="%(name)s"
add_group_and_user
default_postinst
""" % {"name": PKG_NAME}


# ---------------------------------------------------------------------------
# 组装 staging 文件表
# ---------------------------------------------------------------------------

def read_version() -> str:
    manifest = os.path.join(REPO, "davflare", "manifest")
    text = open(manifest, encoding="utf-8").read()
    m = re.search(r"^version\s*=\s*(\S+)", text, re.M)
    if not m:
        raise SystemExit("无法从 davflare/manifest 读取版本号")
    return m.group(1).strip()


def script(name: str) -> bytes:
    with open(os.path.join(FILES_DIR, name), "rb") as fh:
        return fh.read()


def collect_payload() -> List[Tuple[str, bytes, int]]:
    """返回 (安装路径, 内容, 权限) 列表；路径相对安装根、不带前导斜杠。"""
    server = os.path.join(REPO, "runtime", "dist", "server.cjs")
    www = os.path.join(REPO, "upstream", "build")
    if not os.path.isfile(server):
        raise SystemExit("缺少 %s，请先执行 (cd runtime && npm run build)" % server)
    if not os.path.isfile(os.path.join(www, "index.html")):
        raise SystemExit("缺少 %s/index.html，请先执行 (cd upstream && npm run build)" % www)

    out: List[Tuple[str, bytes, int]] = []
    with open(server, "rb") as fh:
        out.append(("usr/lib/davflare/server.cjs", fh.read(), 0o644))
    for dirpath, dirnames, filenames in os.walk(www):
        dirnames.sort()
        for fn in sorted(filenames):
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, www).replace(os.sep, "/")
            with open(full, "rb") as fh:
                out.append(("usr/lib/davflare/www/" + rel, fh.read(), 0o644))
    out.append(("etc/init.d/davflare", script("davflare.init"), 0o755))
    out.append(("etc/config/davflare", script("davflare.config"), 0o644))
    out.append(("etc/uci-defaults/99-davflare", script("davflare.uci-defaults"), 0o755))
    return out


def apk_filelist(payload: List[Tuple[str, bytes, int]]) -> bytes:
    """生成 /lib/apk/packages/<pkg>.list 的内容。

    格式与官方一致：绝对路径、每行一个、按 strcmp 排序、不含清单文件本身。
    ``default_postinst`` 靠它来找 /etc/uci-defaults 与 /etc/init.d。
    """
    names = sorted({"/" + path for path, _d, _m in payload if path != APK_LIST_PATH})
    return ("\n".join(names) + "\n").encode("utf-8")


# ---------------------------------------------------------------------------
# 产出
# ---------------------------------------------------------------------------

def build_apk(version: str, payload: List[Tuple[str, bytes, int]]) -> bytes:
    # apk 侧要额外带上文件清单
    full = list(payload)
    full.append((APK_LIST_PATH, apk_filelist(payload), 0o644))

    files = [adb_pack.PackageFile(path, data, mode=mode, mtime=SOURCE_EPOCH)
             for path, data, mode in full]
    return adb_pack.build_apk(
        name=PKG_NAME,
        version="%s-r1" % version,
        arch=ARCH_APK,
        files=files,
        description=DESCRIPTION,
        url=URL,
        license_=LICENSE,
        maintainer=MAINTAINER,
        origin="openwrt/packages/%s" % PKG_NAME,
        depends=DEPENDS,
        provides=["%s-any" % PKG_NAME],
        scripts=adb_pack.PackageScripts(
            post_install=APK_POSTINST.encode("utf-8"),
            pre_deinstall=APK_PRERM.encode("utf-8"),
            post_upgrade=APK_POSTUPGRADE.encode("utf-8"),
        ),
    )


def build_ipk(version: str, payload: List[Tuple[str, bytes, int]]) -> bytes:
    entries = [ipk.Entry(path, data=data, mode=mode) for path, data, mode in payload]
    # 字段顺序照抄真实 OpenWrt 包（见 mk_ipk.build_ipk：Installed-Size 会插在
    # Description 之前）
    control: Dict[str, str] = {
        "Package": PKG_NAME,
        "Version": "%s-r1" % version,
        "Depends": ", ".join(DEPENDS),
        "Source": "openwrt/package/%s" % PKG_NAME,
        "SourceName": PKG_NAME,
        "License": LICENSE,
        "LicenseFiles": "LICENSE",
        "Section": SECTION,
        "SourceDateEpoch": str(SOURCE_EPOCH),
        "URL": URL,
        "Maintainer": MAINTAINER,
        "Architecture": ARCH_IPK,
        "Description": " " + DESCRIPTION,
    }
    return ipk.build_ipk(
        control=control,
        files=entries,
        scripts={"postinst": IPK_POSTINST.encode("utf-8"),
                 "prerm": IPK_PRERM.encode("utf-8")},
        conffiles=["/etc/config/davflare"],
        mtime=SOURCE_EPOCH,
    )


def build_sdk_tarball(version: str, payload: List[Tuple[str, bytes, int]]) -> bytes:
    """只含 server.cjs 与 www/ 的源码包，供 OpenWrt SDK 的 Makefile 消费。"""
    buf = io.BytesIO()
    # 先写未压缩的 tar，再套一层「固定头、无时间戳」的 gzip —— 直接用
    # tarfile 的 w:gz 会把当前时间写进 gzip 头，产物就不可复现了。
    tf = tarfile.open(fileobj=buf, mode="w", format=tarfile.GNU_FORMAT)
    root = "%s-%s/" % (PKG_NAME, version)

    def add(name: str, data: bytes) -> None:
        ti = tarfile.TarInfo(name)
        ti.size = len(data)
        ti.mtime = SOURCE_EPOCH
        ti.uid = ti.gid = 0
        ti.uname = ti.gname = ""
        ti.mode = 0o644
        tf.addfile(ti, io.BytesIO(data))

    for path, data, _mode in payload:
        if not (path == "usr/lib/davflare/server.cjs"
                or path.startswith("usr/lib/davflare/www/")):
            continue
        add(root + path[len("usr/lib/davflare/"):], data)

    # Makefile 里声明了 PKG_LICENSE_FILES:=LICENSE，源码包得把它带上
    lic = os.path.join(REPO, "LICENSE")
    if os.path.isfile(lic):
        with open(lic, "rb") as fh:
            add(root + "LICENSE", fh.read())

    tf.close()
    return ipk.gzip_deterministic(buf.getvalue())


def update_makefile_hash(digest: str) -> None:
    path = os.path.join(PKG_DIR, "Makefile")
    text = open(path, encoding="utf-8").read()
    new = re.sub(r"^PKG_HASH:=.*$", "PKG_HASH:=%s" % digest, text, count=1, flags=re.M)
    if new != text:
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(new)


def main() -> int:
    ap = argparse.ArgumentParser(description="构建 OpenWrt 安装包")
    ap.add_argument("--only", choices=["apk", "ipk", "sdk"], help="只产出其中一种")
    args = ap.parse_args()

    version = read_version()
    payload = collect_payload()
    total = sum(len(d) for _p, d, _m in payload)
    os.makedirs(OUT_DIR, exist_ok=True)
    print("Davflare %s → OpenWrt 包（%d 个文件，%d 字节）" % (version, len(payload), total))

    ipk_name = "%s_%s-r1_%s.ipk" % (PKG_NAME, version, ARCH_IPK)
    apk_name = "%s-%s-r1.apk" % (PKG_NAME, version)

    if args.only in (None, "ipk"):
        blob = build_ipk(version, payload)
        with open(os.path.join(OUT_DIR, ipk_name), "wb") as fh:
            fh.write(blob)
        print("  ✓ %-36s %9d 字节   opkg / OpenWrt <= 24.10" % (ipk_name, len(blob)))

    if args.only in (None, "apk"):
        blob = build_apk(version, payload)
        with open(os.path.join(OUT_DIR, apk_name), "wb") as fh:
            fh.write(blob)
        problems = adb_pack.check_apk(blob)
        print("  ✓ %-36s %9d 字节   apk / OpenWrt >= 25.12%s"
              % (apk_name, len(blob), "" if not problems else "  ⚠ " + "; ".join(problems)))

    if args.only in (None, "sdk"):
        blob = build_sdk_tarball(version, payload)
        tar_name = "%s-openwrt-%s.tar.gz" % (PKG_NAME, version)
        with open(os.path.join(OUT_DIR, tar_name), "wb") as fh:
            fh.write(blob)
        digest = hashlib.sha256(blob).hexdigest()
        update_makefile_hash(digest)
        print("  ✓ %-36s %9d 字节   OpenWrt SDK 源码包" % (tar_name, len(blob)))
        print("      sha256 %s" % digest)
        print("      已写入 package/davflare/Makefile 的 PKG_HASH")

    print("\n产物目录：%s" % OUT_DIR)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
