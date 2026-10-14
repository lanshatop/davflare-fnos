#!/usr/bin/env python3
"""opkg (.ipk) 打包器。

OpenWrt 24.10 及更早版本使用 opkg，包格式沿用 ipkg/deb 的「tar 套 tar」结构，
与 OpenWrt ``scripts/ipkg-build`` 的输出逐条对齐::

    .ipk = gzip( tar(
        ./debian-binary      内容 "2.0\\n"
        ./data.tar.gz        gzip(tar(./, ./usr/, ./usr/..., 目标文件))
        ./control.tar.gz     gzip(tar(./, ./control, ./conffiles, ./postinst, ...))
    ) )

约定（与 ipkg-build 一致）：

* 内层 tar 用 GNU 格式、成员名带 ``./`` 前缀、数字属主（uid/gid = 0）、
  成员按名字排序、mtime 统一；
* gzip 用 ``-n``（无文件名、无时间戳），所以三个 gzip 头都是
  ``1f 8b 08 00 00 00 00 00 00 03``；
* 外层 tar 的三个成员按 debian-binary / data.tar.gz / control.tar.gz 顺序写入。

用法::

    python3 mk_ipk.py --out x.ipk --spec spec.json
"""

from __future__ import annotations

import argparse
import io
import json
import os
import struct
import tarfile
import zlib
from typing import Dict, List, Optional

GZIP_HEADER = b"\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\x03"  # gzip -n, 无 mtime, OS=unix


def gzip_deterministic(data: bytes, level: int = 9) -> bytes:
    """等价于 ``gzip -n -9``：固定头、无时间戳。"""
    co = zlib.compressobj(level, zlib.DEFLATED, -15)
    body = co.compress(data) + co.flush()
    crc = zlib.crc32(data) & 0xFFFFFFFF
    return GZIP_HEADER + body + struct.pack("<II", crc, len(data) & 0xFFFFFFFF)


class Entry:
    """打包用的一条文件系统记录。"""

    def __init__(self, name: str, *, data: bytes = b"", mode: int = 0o644,
                 is_dir: bool = False, link: Optional[str] = None):
        self.name = name          # 相对安装根，如 usr/lib/davflare/server.cjs
        self.data = data
        self.mode = mode
        self.is_dir = is_dir
        self.link = link


def _tar_bytes(entries: List[Entry], mtime: int, with_root: bool) -> bytes:
    """按 ipkg-build 的方式生成内层 tar（GNU 格式、排序、数字属主）。"""
    buf = io.BytesIO()
    tf = tarfile.open(fileobj=buf, mode="w", format=tarfile.GNU_FORMAT)

    def add(name: str, *, data: bytes = b"", mode: int = 0o644,
            is_dir: bool = False, link: Optional[str] = None) -> None:
        ti = tarfile.TarInfo(name)
        ti.mtime = mtime
        ti.uid = ti.gid = 0
        ti.uname = ti.gname = ""
        ti.mode = mode
        if is_dir:
            ti.type = tarfile.DIRTYPE
            tf.addfile(ti)
        elif link is not None:
            ti.type = tarfile.SYMTYPE
            ti.linkname = link
            tf.addfile(ti)
        else:
            ti.type = tarfile.REGTYPE
            ti.size = len(data)
            tf.addfile(ti, io.BytesIO(data))

    if with_root:
        add("./", mode=0o755, is_dir=True)
    for e in sorted(entries, key=lambda x: x.name):
        add("./" + e.name, data=e.data, mode=e.mode, is_dir=e.is_dir, link=e.link)
    tf.close()
    return buf.getvalue()


def build_ipk(
    *,
    control: Dict[str, str],
    files: List[Entry],
    scripts: Optional[Dict[str, bytes]] = None,
    conffiles: Optional[List[str]] = None,
    mtime: int = 0,
) -> bytes:
    """组装 .ipk 字节。``control`` 是有序字典（字段顺序即写入顺序）。"""
    # --- data.tar.gz ---------------------------------------------------
    merged: Dict[str, Entry] = {}
    for e in files:
        parts = e.name.split("/")[:-1]
        for i in range(1, len(parts) + 1):
            d = "/".join(parts[:i]) + "/"
            merged.setdefault(d, Entry(d, mode=0o755, is_dir=True))
    for e in files:
        merged[e.name] = e
    data_tar = _tar_bytes(list(merged.values()), mtime, with_root=True)
    data_gz = gzip_deterministic(data_tar)

    # --- control.tar.gz ------------------------------------------------
    ctl_dir = dict(control)
    if conffiles:
        ctl_dir["__conffiles"] = "\n".join(conffiles) + "\n"
    installed = sum(len(e.data) for e in files if not e.is_dir and e.link is None)
    ctl_lines = []
    for k, v in ctl_dir.items():
        if k == "__conffiles":
            continue
        # Installed-Size 插在 Description 之前 —— 真实 OpenWrt 包的字段顺序是
        # ... Architecture / Installed-Size / Description，Description 恒为末位
        # （它是唯一允许续行的自由文本字段）。
        if k == "Description" and "Installed-Size" not in ctl_dir:
            ctl_lines.append("Installed-Size: %d" % installed)
        ctl_lines.append("%s: %s" % (k, v))
    if "Installed-Size" not in ctl_dir and "Description" not in ctl_dir:
        ctl_lines.append("Installed-Size: %d" % installed)

    ctl_entries = [Entry("control", data=("\n".join(ctl_lines) + "\n").encode(), mode=0o644)]
    if conffiles:
        ctl_entries.append(Entry("conffiles", data=ctl_dir["__conffiles"].encode(), mode=0o644))
    for name, body in (scripts or {}).items():
        ctl_entries.append(Entry(name, data=body, mode=0o755))
    control_tar = _tar_bytes(ctl_entries, mtime, with_root=True)
    control_gz = gzip_deterministic(control_tar)

    # --- 外层 ----------------------------------------------------------
    buf = io.BytesIO()
    tf = tarfile.open(fileobj=buf, mode="w", format=tarfile.GNU_FORMAT)

    def add(name: str, data: bytes) -> None:
        ti = tarfile.TarInfo(name)
        ti.mtime = mtime
        ti.uid = ti.gid = 0
        ti.uname = ti.gname = ""
        ti.mode = 0o644
        ti.size = len(data)
        tf.addfile(ti, io.BytesIO(data))

    add("./debian-binary", b"2.0\n")
    add("./data.tar.gz", data_gz)
    add("./control.tar.gz", control_gz)
    tf.close()
    return gzip_deterministic(buf.getvalue())


# ---------------------------------------------------------------------------
# 从「安装树」目录打包（便于 Makefile / 脚本复用）
# ---------------------------------------------------------------------------

def collect_tree(root: str, conffiles: Optional[List[str]] = None) -> List[Entry]:
    """把目录树读成 Entry 列表；conffiles 里的相对路径按模式无关处理。"""
    out: List[Entry] = []
    root = os.path.abspath(root)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        rel_dir = os.path.relpath(dirpath, root).replace(os.sep, "/")
        if rel_dir != ".":
            out.append(Entry(rel_dir.rstrip("/") + "/", mode=0o755, is_dir=True))
        for fn in sorted(filenames):
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            if os.path.islink(full):
                out.append(Entry(rel, link=os.readlink(full), mode=0o777))
                continue
            st = os.stat(full)
            out.append(Entry(rel, data=open(full, "rb").read(), mode=st.st_mode & 0o7777))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="构建 opkg .ipk")
    ap.add_argument("--root", required=True, help="安装根目录（其内容会成为 /）")
    ap.add_argument("--out", required=True)
    ap.add_argument("--spec", required=True, help="JSON：control 字段 + conffiles + scripts")
    args = ap.parse_args()

    spec = json.load(open(args.spec, encoding="utf-8"))
    entries = collect_tree(args.root)
    scripts = {}
    for key in ("preinst", "postinst", "prerm", "postrm"):
        if spec.get(key):
            scripts[key] = spec[key].encode("utf-8")
    blob = build_ipk(
        control=spec["control"],
        files=entries,
        scripts=scripts,
        conffiles=spec.get("conffiles"),
        mtime=int(spec.get("mtime", 0)),
    )
    with open(args.out, "wb") as fh:
        fh.write(blob)
    print("%s  %d 字节" % (args.out, len(blob)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
