#!/usr/bin/env python3
"""apk v3 (adb) 打包 / 解析库。

OpenWrt 25.12 起包管理器由 opkg 换成 apk（Alpine Package Keeper），
包格式是 apk-tools 3 引入的 "adb" 二进制格式。本模块按 apk-tools 的
实现（src/adb.h、src/adb.c、src/apk_adb.c、src/app_mkpkg.c）逐条复刻，
用来在没有 Linux 构建环境时也能产出标准 .apk。

文件布局（adb_compress 默认走 deflate）::

    "ADBd"                       4 字节压缩标记（ADB_COMP_DEFLATE, level 默认）
    raw deflate( 内层流 )        内层流 = 下列块的串联
      ├─ adb_file_header         8 字节：magic "ADB." + schema "pckg"
      ├─ ADB  块                 载荷 = adb_hdr(8) + 值数据
      ├─ SIG  块 × N             可选，签名（本工具不生成）
      └─ DATA 块 × N             每个普通文件一个：{path_idx, file_idx} + 内容

块的封装（struct adb_block，非扩展模式只写 4 字节）::

    u32 type_size = (type << 30) | (4 + payload_len)
    payload...
    0 填充到 8 字节对齐

"ADBc" + u16 {alg, level} 是带显式压缩等级的写法；读到 buf[3] == '.' 表示
不压缩（此时 "ADB." 本身就是 file header 的 magic）。

用法::

    python3 adb_pack.py dump  <包.apk>      # 解析并打印结构
    python3 adb_pack.py check <包.apk>      # 校验偏移/长度自洽
"""

from __future__ import annotations

import hashlib
import struct
import sys
import zlib
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# 常量（对齐 src/adb.h、src/apk_adb.h）
# ---------------------------------------------------------------------------

ADB_FORMAT_MAGIC = 0x2E424441  # "ADB."
ADB_SCHEMA_PACKAGE = 0x676B6370  # "pckg"
ADB_SCHEMA_INDEX = 0x78646E69  # "indx"

ADB_TYPE_SPECIAL = 0x00000000
ADB_TYPE_INT = 0x10000000
ADB_TYPE_INT_32 = 0x20000000
ADB_TYPE_INT_64 = 0x30000000
ADB_TYPE_BLOB_8 = 0x80000000
ADB_TYPE_BLOB_16 = 0x90000000
ADB_TYPE_BLOB_32 = 0xA0000000
ADB_TYPE_ARRAY = 0xD0000000
ADB_TYPE_OBJECT = 0xE0000000
ADB_TYPE_MASK = 0xF0000000
ADB_VALUE_MASK = 0x0FFFFFFF

ADB_VAL_NULL = 0
ADB_VAL_TRUE = 1
ADB_VAL_FALSE = 2

ADB_BLOCK_ADB = 0
ADB_BLOCK_SIG = 1
ADB_BLOCK_DATA = 2
ADB_BLOCK_EXT = 3
ADB_BLOCK_ALIGNMENT = 8

# schemas（字段序号 → 名称）
FIELDS_PKGINFO = {
    1: "name", 2: "version", 3: "hashes", 4: "description", 5: "arch",
    6: "license", 7: "origin", 8: "maintainer", 9: "url", 10: "repo-commit",
    11: "build-time", 12: "installed-size", 13: "file-size",
    14: "provider-priority", 15: "depends", 16: "provides", 17: "replaces",
    18: "install-if", 19: "recommends", 20: "layer", 21: "tags",
}
FIELDS_PACKAGE = {
    1: "info", 2: "paths", 3: "scripts", 4: "triggers", 5: "replaces-priority",
}
FIELDS_DIR = {1: "name", 2: "acl", 3: "files"}
FIELDS_FILE = {1: "name", 2: "acl", 3: "size", 4: "mtime", 5: "hash", 6: "target"}
FIELDS_ACL = {1: "mode", 2: "user", 3: "group", 4: "xattrs"}
FIELDS_DEP = {1: "name", 2: "version", 3: "match"}
FIELDS_SCRIPTS = {
    1: "trigger", 2: "pre-install", 3: "post-install", 4: "pre-deinstall",
    5: "post-deinstall", 6: "pre-upgrade", 7: "post-upgrade",
}
# 数字型字段（读取时按整数解释，而不是 blob）
INT_FIELDS = {
    "installed-size", "file-size", "provider-priority", "build-time",
    "size", "mtime", "mode", "replaces-priority",
}
# 原始 blob 字段：不做 utf-8 解码，保持 bytes（否则哈希校验、符号链接目标
# 这类二进制内容会被 decode 破坏，校验也就形同虚设）
RAW_FIELDS = INT_FIELDS | {"hashes", "target", "xattrs"}

S_IFMT = 0o170000
S_IFLNK = 0o120000
S_IFREG = 0o100000
S_IFBLK = 0o060000
S_IFCHR = 0o020000
S_IFIFO = 0o010000


def val_type(v: int) -> int:
    return v & ADB_TYPE_MASK


def val_value(v: int) -> int:
    return v & ADB_VALUE_MASK


def round_up(n: int, align: int) -> int:
    return (n + align - 1) // align * align


# ---------------------------------------------------------------------------
# 编码器
# ---------------------------------------------------------------------------

class AdbWriter:
    """按 apk-tools 的写入语义构造 adb 值流。

    * ``buf`` 前 8 字节是 ``struct adb_hdr``（compat_ver/ver/reserved/root）。
    * blob、INT_32/64 的数据按需追加；对象/数组在调用时追加槽数组。
    * ``payload()`` 返回完整载荷（可直接作为 ADB 块的载荷）。
    """

    def __init__(self, schema: int):
        self.schema = schema
        self.buf = bytearray(b"\0" * 8)
        # 内容去重表：对应 adb.c 的 adb_w_data() —— 官方写入器带一个按内容
        # 哈希的桶缓存，相同内容（且满足对齐要求）复用同一个偏移，不再重复
        # 追加。文件里大量重复的 ACL（mode/user/group 完全一样）就是靠它省下来的。
        self._dedup: Dict[bytes, List[int]] = {}

    # -- 内部 ---------------------------------------------------------------
    def _align(self, n: int) -> None:
        pad = (-len(self.buf)) % n
        if pad:
            self.buf += b"\0" * pad

    def _append(self, data: bytes, align: int, dedup: bool = True) -> int:
        if dedup:
            for off in self._dedup.get(data, ()):
                if off % align == 0:
                    return off
        self._align(align)
        off = len(self.buf)
        self.buf += data
        if dedup:
            self._dedup.setdefault(bytes(data), []).append(off)
        return off

    # -- 标量 ---------------------------------------------------------------
    def blob(self, data: Optional[bytes], dedup: bool = True) -> int:
        """写入 blob，返回带偏移的 BLOB_n 标签；空数据返回 NULL。"""
        if not data:
            return ADB_VAL_NULL
        n = len(data)
        if n <= 0xFF:
            prefix, tag = 1, ADB_TYPE_BLOB_8
        elif n <= 0xFFFF:
            prefix, tag = 2, ADB_TYPE_BLOB_16
        else:
            prefix, tag = 4, ADB_TYPE_BLOB_32
        off = self._append(n.to_bytes(prefix, "little") + data, prefix, dedup)
        return tag | off

    def blob_placeholder(self, n: int) -> int:
        """写入 n 个零字节的 blob，返回标签（用于事后回填哈希）。

        刻意绕过内容去重：这个占位块随后会被 patch_blob() 原地改写，
        一旦与别的相同内容共享偏移，回填就会连带改坏那一份。
        """
        return self.blob(b"\0" * n, dedup=False)

    def patch_blob(self, tag: int, data: bytes) -> None:
        """把 blob 的内容原地替换（长度必须一致）。"""
        if val_type(tag) not in (ADB_TYPE_BLOB_8, ADB_TYPE_BLOB_16, ADB_TYPE_BLOB_32):
            raise ValueError("不是 blob 标签")
        off = val_value(tag)
        prefix = {ADB_TYPE_BLOB_8: 1, ADB_TYPE_BLOB_16: 2, ADB_TYPE_BLOB_32: 4}[val_type(tag)]
        start = off + prefix
        if len(data) != int.from_bytes(self.buf[off:start], "little"):
            raise ValueError("回填长度与占位长度不一致")
        self.buf[start:start + len(data)] = data

    def int_(self, v: int) -> int:
        """写入整数。小于 2^28 直接内联，否则落盘为 INT_32 / INT_64。"""
        if v < (1 << 28):
            return ADB_TYPE_INT | v
        if v < (1 << 32):
            off = self._append(struct.pack("<I", v), 4)
            return ADB_TYPE_INT_32 | off
        off = self._append(struct.pack("<Q", v), 4)
        return ADB_TYPE_INT_64 | off

    def string(self, s: str) -> int:
        return self.blob(s.encode("utf-8"))

    # -- 容器 ---------------------------------------------------------------
    def _slots(self, slots: Dict[int, int], tag_base: int) -> int:
        """slots 为 1 基索引 → 值；裁剪尾部 NULL，追加槽数组。"""
        top = 0
        for i, v in slots.items():
            if v != ADB_VAL_NULL and i > top:
                top = i
        if top == 0:
            return ADB_VAL_NULL
        words = [top + 1] + [slots.get(i, ADB_VAL_NULL) for i in range(1, top + 1)]
        off = self._append(struct.pack("<%dI" % len(words), *words), 4)
        return tag_base | off

    def obj(self, slots: Dict[int, int]) -> int:
        return self._slots(slots, ADB_TYPE_OBJECT)

    def array(self, items: List[int]) -> int:
        if not items:
            return ADB_VAL_NULL
        return self._slots({i + 1: v for i, v in enumerate(items)}, ADB_TYPE_ARRAY)
    # -- 收尾 ---------------------------------------------------------------
    def set_root(self, root: int) -> None:
        struct.pack_into("<I", self.buf, 4, root)

    def payload(self) -> bytes:
        return bytes(self.buf)

    def container(self, data_blocks: List[Tuple[int, int, bytes]]) -> bytes:
        """拼出内层字节流（file header + ADB 块 + DATA 块）。"""
        adb_payload = self.payload()
        out = bytearray()
        out += struct.pack("<II", ADB_FORMAT_MAGIC, self.schema)
        out += _block(ADB_BLOCK_ADB, adb_payload)
        for path_idx, file_idx, data in data_blocks:
            hdr = struct.pack("<II", path_idx, file_idx)
            out += _block(ADB_BLOCK_DATA, hdr + data)
        return bytes(out)


def _block(btype: int, payload: bytes) -> bytes:
    """按 struct adb_block 的非扩展形式封装一个块（含 8 字节对齐填充）。"""
    raw = 4 + len(payload)
    if raw > 0x3FFFFFFF - 4:
        raise ValueError("单个块过大，需要扩展块头（本工具不支持）")
    head = struct.pack("<I", (btype << 30) | raw)
    pad = round_up(raw, ADB_BLOCK_ALIGNMENT) - raw
    return head + payload + b"\0" * pad


# ---------------------------------------------------------------------------
# 压缩层
# ---------------------------------------------------------------------------

def compress_stream(inner: bytes, level: int = 9) -> bytes:
    """等价于 adb_compress()：写 "ADBd" 标记 + raw deflate。

    apk 侧用 ``deflateInit2(..., -15)``，所以这里也必须用 raw deflate
    （wbits = -15，不带 zlib 头）。
    """
    co = zlib.compressobj(level, zlib.DEFLATED, -15)
    body = co.compress(inner) + co.flush()
    return b"ADBd" + body


def decompress_stream(blob: bytes) -> bytes:
    if blob[:4] == b"ADBd":
        return zlib.decompressobj(-15).decompress(blob[4:])
    if blob[:4] == b"ADBc":
        raise NotImplementedError("显式压缩等级的容器（ADBc）")
    if blob[:4] == b"ADB.":
        return blob  # 未压缩
    raise ValueError("不是 adb 容器")


# ---------------------------------------------------------------------------
# 解析器（用于 dump / 自检）
# ---------------------------------------------------------------------------

@dataclass
class AdbFile:
    path_idx: int
    file_idx: int
    data: bytes


@dataclass
class ParsedPackage:
    schema: int
    adb: bytes
    data_blocks: List[AdbFile] = field(default_factory=list)
    values: Dict[str, Any] = field(default_factory=dict)


class AdbReader:
    def __init__(self, adb: bytes):
        self.adb = adb

    def _deref(self, val: int, off: int, size: int) -> bytes:
        p = val_value(val) + off
        if p + size > len(self.adb):
            raise ValueError("越界访问 offset=%d size=%d" % (p, size))
        return self.adb[p:p + size]

    def scalar(self, val: int) -> Any:
        t = val_type(val)
        if t == ADB_TYPE_SPECIAL:
            return {0: None, 1: True, 2: False}.get(val_value(val), "?special")
        if t == ADB_TYPE_INT:
            return val_value(val)
        if t == ADB_TYPE_INT_32:
            return struct.unpack("<I", self._deref(val, 0, 4))[0]
        if t == ADB_TYPE_INT_64:
            return struct.unpack("<Q", self._deref(val, 0, 8))[0]
        if t in (ADB_TYPE_BLOB_8, ADB_TYPE_BLOB_16, ADB_TYPE_BLOB_32):
            pf = {ADB_TYPE_BLOB_8: 1, ADB_TYPE_BLOB_16: 2, ADB_TYPE_BLOB_32: 4}[t]
            n = int.from_bytes(self._deref(val, 0, pf), "little")
            return self._deref(val, pf, n)
        raise ValueError("不是标量: 0x%08x" % val)

    def slots(self, val: int) -> List[int]:
        t = val_type(val)
        if t not in (ADB_TYPE_ARRAY, ADB_TYPE_OBJECT):
            raise ValueError("不是对象/数组: 0x%08x" % val)
        off = val_value(val)
        n = struct.unpack("<I", self._deref(val, 0, 4))[0]
        raw = self._deref(val, 0, 4 * n)
        return list(struct.unpack("<%dI" % n, raw))

    def object(self, val: int, names: Dict[int, str]) -> Dict[str, Any]:
        words = self.slots(val)
        n = words[0]
        out: Dict[str, Any] = {}
        for i in range(1, n):
            v = words[i]
            if v == ADB_VAL_NULL:
                continue
            name = names.get(i, "field%d" % i)
            t = val_type(v)
            if t in (ADB_TYPE_OBJECT, ADB_TYPE_ARRAY):
                out[name] = ("obj", v)
            elif t in (ADB_TYPE_BLOB_8, ADB_TYPE_BLOB_16, ADB_TYPE_BLOB_32):
                b = self.scalar(v)
                out[name] = b if name in RAW_FIELDS else b.decode("utf-8", "replace")
            else:
                out[name] = self.scalar(v)
        return out

    def root(self) -> int:
        if len(self.adb) < 8:
            raise ValueError("ADB 载荷过短")
        return struct.unpack("<I", self.adb[4:8])[0]


def parse_apk(blob: bytes) -> ParsedPackage:
    """解析 .apk：还原块结构、ADB 载荷与 DATA 块。"""
    inner = decompress_stream(blob)
    if len(inner) < 8:
        raise ValueError("内层流过短")
    magic, schema = struct.unpack("<II", inner[:8])
    if magic != ADB_FORMAT_MAGIC:
        raise ValueError("file header magic 不对")
    pos = 8
    adb: Optional[bytes] = None
    result = ParsedPackage(schema=schema, adb=b"")
    while pos + 4 <= len(inner):
        ts = struct.unpack("<I", inner[pos:pos + 4])[0]
        btype = ts >> 30
        rawsize = ts & 0x3FFFFFFF
        if rawsize < 4 or pos + rawsize > len(inner):
            break
        payload = inner[pos + 4:pos + rawsize]
        if btype == ADB_BLOCK_ADB:
            adb = payload
        elif btype == ADB_BLOCK_DATA:
            if len(payload) < 8:
                raise ValueError("DATA 块头过短")
            p_idx, f_idx = struct.unpack("<II", payload[:8])
            result.data_blocks.append(AdbFile(p_idx, f_idx, payload[8:]))
        pos += round_up(rawsize, ADB_BLOCK_ALIGNMENT)
    if adb is None:
        raise ValueError("缺少 ADB 块")
    result.adb = adb
    r = AdbReader(adb)
    pkg = r.object(r.root(), FIELDS_PACKAGE)
    info = pkg.get("info")
    if info is not None and info[0] == "obj":
        result.values = r.object(info[1], FIELDS_PKGINFO)
    return result


def decode_package(parsed: ParsedPackage) -> Tuple[Dict[str, Any], List[Tuple[str, List[Dict[str, Any]]]], Dict[str, Any]]:
    """把解析出的包还原成 (pkginfo, [(目录名, [文件字典])], scripts)。"""
    r = AdbReader(parsed.adb)

    def expand_acl(obj: Dict[str, Any]) -> Dict[str, Any]:
        acl = obj.get("acl")
        if isinstance(acl, tuple) and acl[0] == "obj":
            obj["acl"] = r.object(acl[1], FIELDS_ACL)
        return obj

    def expand_target(obj: Dict[str, Any]) -> Dict[str, Any]:
        """把 ADBI_FI_TARGET 的原始 blob 解成可读形式，同时保留原始字节。"""
        raw = obj.get("target")
        if isinstance(raw, bytes) and len(raw) >= 2:
            kind = struct.unpack("<H", raw[:2])[0]
            body = raw[2:]
            if kind == S_IFLNK:
                obj["target"] = body.decode("utf-8", "replace")
            elif kind == S_IFREG:
                obj["target"] = "hardlink:" + body.decode("utf-8", "replace")
            else:
                obj["target"] = "device:0o%o:%d" % (kind, int.from_bytes(body, "little"))
            obj["target_raw"] = raw
        return obj

    def expand_file(obj: Dict[str, Any]) -> Dict[str, Any]:
        return expand_target(expand_acl(obj))

    root = r.object(r.root(), FIELDS_PACKAGE)
    info: Dict[str, Any] = {}
    if root.get("info", (None,))[0] == "obj":
        info = r.object(root["info"][1], FIELDS_PKGINFO)
        for key in ("depends", "provides", "replaces", "install-if", "recommends"):
            v = info.get(key)
            if isinstance(v, tuple) and v[0] == "obj":
                words = r.slots(v[1])
                deps = []
                for i in range(1, words[0]):
                    d = r.object(words[i], FIELDS_DEP)
                    text = d.get("name", "")
                    if d.get("version"):
                        text += "#%d:%s" % (d.get("match", 0), d["version"])
                    deps.append(text)
                info[key] = deps
    dirs: List[Tuple[str, List[Dict[str, Any]]]] = []
    if root.get("paths", (None,))[0] == "obj":
        pw = r.slots(root["paths"][1])
        for i in range(1, pw[0]):
            d = expand_acl(r.object(pw[i], FIELDS_DIR))
            files: List[Dict[str, Any]] = []
            if d.get("files", (None,))[0] == "obj":
                fw = r.slots(d["files"][1])
                for j in range(1, fw[0]):
                    files.append(expand_file(r.object(fw[j], FIELDS_FILE)))
            dirs.append((d.get("name", ""), files))
    scripts: Dict[str, Any] = {}
    if root.get("scripts", (None,))[0] == "obj":
        scripts = r.object(root["scripts"][1], FIELDS_SCRIPTS)
    return info, dirs, scripts


def check_apk(blob: bytes) -> List[str]:
    """结构自检：返回问题列表（空 = 通过）。"""
    problems: List[str] = []
    try:
        parsed = parse_apk(blob)
        info, dirs, _scripts = decode_package(parsed)
    except Exception as exc:  # noqa: BLE001
        return ["解析失败: %s" % exc]

    for name in ("name", "version", "arch"):
        if not info.get(name):
            problems.append("pkginfo 缺少字段 %s" % name)

    r = AdbReader(parsed.adb)
    dir_index = {i + 1: d for i, d in enumerate(dirs)}
    # 符号链接（有 target）不算内容体积，也不产生 DATA 块——与 apk mkpkg 一致
    total_declared = sum(f.get("size", 0) for _n, files in dirs for f in files
                         if not f.get("target"))
    if info.get("installed-size") not in (None, total_declared, max(total_declared, 1)):
        problems.append("installed-size=%s 与文件合计 %d 不一致"
                        % (info.get("installed-size"), total_declared))

    for blk in parsed.data_blocks:
        d = dir_index.get(blk.path_idx)
        if d is None:
            problems.append("DATA 块指向不存在的目录 idx=%d" % blk.path_idx)
            continue
        files = d[1]
        if blk.file_idx < 1 or blk.file_idx > len(files):
            problems.append("DATA 块 file_idx=%d 越界" % blk.file_idx)
            continue
        fobj = files[blk.file_idx - 1]
        if fobj.get("size") != len(blk.data):
            problems.append("文件 %s 声明 %s 字节，DATA 块实际 %d 字节"
                            % (fobj.get("name"), fobj.get("size"), len(blk.data)))
        h = fobj.get("hash")
        if isinstance(h, bytes):
            alg = {20: "sha1", 32: "sha256"}.get(len(h))
            if alg is None:
                problems.append("文件 %s 的哈希长度异常 %d" % (fobj.get("name"), len(h)))
            elif hashlib.new(alg, blk.data).digest() != h:
                problems.append("文件 %s 的内容哈希不匹配" % fobj.get("name"))

    # 每个声明了 size>0 且非符号链接的文件都应有对应 DATA 块
    declared = {(i + 1, j + 1) for i, (_n, fs) in enumerate(dirs)
                for j, f in enumerate(fs) if f.get("size", 0) > 0 and not f.get("target")}
    have = {(b.path_idx, b.file_idx) for b in parsed.data_blocks}
    for missing in sorted(declared - have):
        problems.append("文件 (path=%d,file=%d) 缺少 DATA 块" % missing)
    return problems


# ---------------------------------------------------------------------------
# 构建：把一个文件树打成 .apk
# ---------------------------------------------------------------------------

@dataclass
class PackageFile:
    """待打包的一条文件系统记录：相对安装根的路径（不含前导 /）。

    * 普通文件：填 ``data``，会自动算 SHA256 并生成 DATA 块；
    * 符号链接：填 ``link``（目标路径）。按 apk 语义，符号链接**不计入**
      installed-size、**不产生** DATA 块，它的 ``size`` 字段是目标路径的长度，
      ``target`` 字段是 ``u16 LE S_IFLNK + 目标路径``。
    """
    path: str          # 例：usr/lib/davflare/server.cjs
    data: bytes = b""
    mode: int = 0o644
    mtime: int = 0
    user: str = "root"
    group: str = "root"
    link: Optional[str] = None

    @property
    def target_blob(self) -> Optional[bytes]:
        """apk 的 ADBI_FI_TARGET 载荷（仅符号链接）。"""
        if self.link is None:
            return None
        raw = self.link.encode("utf-8")
        return struct.pack("<H", S_IFLNK) + raw

    @property
    def declared_size(self) -> int:
        """ADBI_FI_SIZE：普通文件是内容长度，符号链接是目标路径长度。"""
        if self.link is not None:
            return len(self.link.encode("utf-8"))
        return len(self.data)


@dataclass
class PackageScripts:
    pre_install: Optional[bytes] = None
    post_install: Optional[bytes] = None
    pre_deinstall: Optional[bytes] = None
    post_deinstall: Optional[bytes] = None
    pre_upgrade: Optional[bytes] = None
    post_upgrade: Optional[bytes] = None


# apk 的依赖匹配位（apk_version.h）
APK_VERSION_EQUAL = 1
APK_VERSION_LESS = 2
APK_VERSION_GREATER = 4
APK_DEPMASK_ANY = APK_VERSION_EQUAL | APK_VERSION_LESS | APK_VERSION_GREATER

_DEP_OPS = [
    (">=", APK_VERSION_GREATER | APK_VERSION_EQUAL),
    ("<=", APK_VERSION_LESS | APK_VERSION_EQUAL),
    ("~=", APK_VERSION_LESS | APK_VERSION_GREATER),
    ("=", APK_VERSION_EQUAL),
    (">", APK_VERSION_GREATER),
    ("<", APK_VERSION_LESS),
]


def encode_dependency(w: "AdbWriter", spec: str) -> int:
    """把 "name" / "name>=1.2" 这类依赖串编成 dependency 对象。

    apk v3 的 depends/provides 是「对象数组」，每个对象形如
    ``{name, [version], [match]}``，而不是裸字符串。
    """
    spec = spec.strip()
    name, op, ver = spec, APK_DEPMASK_ANY, ""
    for token, value in _DEP_OPS:
        pos = spec.find(token)
        if pos > 0:
            name, ver, op = spec[:pos].strip(), spec[pos + len(token):].strip(), value
            break
    slots = {1: w.string(name)}
    if op != APK_DEPMASK_ANY and ver:
        slots[2] = w.string(ver)
        slots[3] = w.int_(op)
    return w.obj(slots)


def encode_dependencies(w: "AdbWriter", specs: List[str]) -> int:
    """依赖数组：去重 + 排序（对应 schema 的 adb_wa_sort_unique）。"""
    uniq = sorted({s.strip() for s in specs if s and s.strip()})
    return w.array([encode_dependency(w, s) for s in uniq])


def build_apk(
    name: str,
    version: str,
    arch: str,
    files: List[PackageFile],
    *,
    description: str = "",
    url: str = "",
    license_: str = "",
    maintainer: str = "",
    origin: str = "",
    depends: Optional[List[str]] = None,
    provides: Optional[List[str]] = None,
    scripts: Optional[PackageScripts] = None,
    level: int = 9,
) -> bytes:
    """生成标准 apk v3 包（未签名，安装需 --allow-untrusted）。"""
    w = AdbWriter(ADB_SCHEMA_PACKAGE)

    # 1) pkginfo：按字段序号写入（与 apk mkpkg 的 assign_fields 一致）
    info: Dict[int, int] = {1: w.string(name), 2: w.string(version)}
    if description:
        info[4] = w.string(description)
    info[5] = w.string(arch)
    if license_:
        info[6] = w.string(license_)
    if origin:
        info[7] = w.string(origin)
    if maintainer:
        info[8] = w.string(maintainer)
    if url:
        info[9] = w.string(url)
    if depends:
        info[15] = encode_dependencies(w, depends)
    if provides:
        info[16] = encode_dependencies(w, provides)

    # 2) 文件树：**根目录 + 每一级目录**都要单独成项。
    #    app_mkpkg.c 的 mkpkg_setup_compat() 在默认 compat 版本下会把
    #    compat_rootnode 与 compat_dirnode 都置 1，因此官方打出来的包连
    #    「不含直接文件的中间目录」也会写进 paths（例如 ca-bundle.apk 里有
    #    独立的 etc/、lib/、lib/apk/ 节点）。目录与文件都按名字排序
    #    （目录按完整相对路径 strcmp 排 —— 对应 apk_string_array_qsort；
    #      目录内文件按文件名排 —— 对应 apk_dir_foreach_file_sorted）。
    by_dir: Dict[str, List[PackageFile]] = {}
    for f in files:
        d = f.path.rsplit("/", 1)[0] if "/" in f.path else ""
        by_dir.setdefault(d, []).append(f)

    all_dirs = {""}                                    # 根目录：名字为空
    for f in files:
        parts = f.path.split("/")[:-1]
        for i in range(1, len(parts) + 1):
            all_dirs.add("/".join(parts[:i]))
    dir_names = sorted(all_dirs)                       # 空名排最前，即根目录
    dir_index = {d: i + 1 for i, d in enumerate(dir_names)}

    dir_values: List[int] = []
    file_index_by_dir: Dict[str, Dict[str, int]] = {}
    for d in dir_names:
        entries = sorted(by_dir.get(d, []), key=lambda x: x.path.rsplit("/", 1)[-1])
        file_index_by_dir[d] = {}
        file_vals: List[int] = []
        for idx, f in enumerate(entries, start=1):
            fname = f.path.rsplit("/", 1)[-1]
            file_index_by_dir[d][fname] = idx
            fobj = {1: w.string(fname)}
            target = f.target_blob
            if target is None:
                # 普通文件：算 SHA256 内容摘要（正好是 32 字节原始摘要）
                digest = hashlib.sha256(f.data).digest()
                fobj[5] = w.blob(digest)
            else:
                # 符号链接 / 设备节点：写入 target，且没有哈希
                fobj[6] = w.blob(target)
            fobj[3] = w.int_(f.declared_size)
            fobj[4] = w.int_(f.mtime)
            acl = {1: w.int_(f.mode & 0o7777), 2: w.string(f.user), 3: w.string(f.group)}
            fobj[2] = w.obj(acl)
            file_vals.append(w.obj(fobj))
        dacl = {1: w.int_(0o755), 2: w.string("root"), 3: w.string("root")}
        dobj = {
            # 根目录名是空（写出来就是 NULL），其余是相对路径且不带前导斜杠
            1: w.string(d),
            2: w.obj(dacl),
            3: w.array(file_vals),
        }
        dir_values.append(w.obj(dobj))

    paths_val = w.array(dir_values)

    # 3) 安装后体积、pkginfo 唯一 ID（SHA256 前 20 字节，先占位后回填）
    total = sum(len(f.data) for f in files)
    info[12] = w.int_(max(total, 1))
    hashes_tag = w.blob_placeholder(20)
    info[3] = hashes_tag

    # 4) 对象槽数组：由内向外
    info_val = w.obj(info)
    pkg_slots: Dict[int, int] = {1: info_val, 2: paths_val}
    if scripts:
        s: Dict[int, int] = {}
        for idx, val in ((2, scripts.pre_install), (3, scripts.post_install),
                         (4, scripts.pre_deinstall), (5, scripts.post_deinstall),
                         (6, scripts.pre_upgrade), (7, scripts.post_upgrade)):
            if val:
                s[idx] = w.blob(val)
        if s:
            pkg_slots[3] = w.obj(s)
    root_val = w.obj(pkg_slots)
    w.set_root(root_val)

    adb_payload = w.payload()
    uid = hashlib.sha256(adb_payload).digest()[:20]
    w.patch_blob(hashes_tag, uid)
    adb_payload = w.payload()

    # 5) DATA 块：有内容且非符号链接的文件各一个，
    #    顺序必须与 paths 的遍历顺序完全一致（extract_v3 是按序边遍历边取块）
    data_blocks: List[Tuple[int, int, bytes]] = []
    for d in dir_names:
        for f in sorted(by_dir.get(d, []), key=lambda x: x.path.rsplit("/", 1)[-1]):
            if f.link is not None or not f.data:
                continue
            fname = f.path.rsplit("/", 1)[-1]
            data_blocks.append((dir_index[d], file_index_by_dir[d][fname], f.data))

    return compress_stream(w.container(data_blocks), level)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _dump(blob: bytes) -> None:
    parsed = parse_apk(blob)
    print("压缩: %s  |  schema: %s  内层 adb: %d 字节"
          % (blob[:4].decode("latin1"),
             struct.pack("<I", parsed.schema).decode("latin1"), len(parsed.adb)))
    info, dirs, scripts = decode_package(parsed)
    print("\n[pkginfo]")
    for k, v in info.items():
        if isinstance(v, bytes):
            v = v.hex() if k == "hashes" else repr(v)
        print("  %-18s %s" % (k, v))
    print("\n[paths] %d 个目录，%d 个文件"
          % (len(dirs), sum(len(f) for _n, f in dirs)))
    for name, files in dirs:
        print("  %s/" % name)
        for f in files:
            print("      %-34s %7d  %s" % (f.get("name"), f.get("size", 0),
                                           (f.get("acl") or {})))
    if scripts:
        print("\n[scripts]")
        for k, v in scripts.items():
            n = v if isinstance(v, int) else len(v or b"")
            print("  %-18s %d 字节" % (k, n))
    if parsed.data_blocks:
        print("\n[data blocks] %d 个，合计 %d 字节"
              % (len(parsed.data_blocks), sum(len(b.data) for b in parsed.data_blocks)))
        for b in parsed.data_blocks:
            print("  path_idx=%d file_idx=%d  %d 字节" % (b.path_idx, b.file_idx, len(b.data)))


def main(argv: List[str]) -> int:
    if len(argv) < 3:
        print(__doc__)
        return 2
    cmd, path = argv[1], argv[2]
    blob = open(path, "rb").read()
    if cmd == "dump":
        _dump(blob)
        return 0
    if cmd == "check":
        problems = check_apk(blob)
        for p in problems:
            print("✗", p)
        print("检查完成：%s" % ("通过" if not problems else "%d 个问题" % len(problems)))
        return 1 if problems else 0
    print("未知命令 %s" % cmd)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
