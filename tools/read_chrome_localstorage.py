#!/usr/bin/env python3
"""直读系统浏览器(Chrome/Chromium 系)的 localStorage，用于取站点登录态（auth_token / refresh_token 等）。

背景：sub2api / new-api 系的登录态常放在页面 localStorage 里。Chrome 把 localStorage 存在
`<UserData>/<Profile>/Local Storage/leveldb/`，是 leveldb 格式（.log 明文 WAL + .ldb 里 snappy 压缩块），
不能用 grep 直接捞。本脚本自带最小 leveldb + snappy 解析，无需第三方依赖。

用法:
  python3 tools/read_chrome_localstorage.py ai.5mt5.com
  python3 tools/read_chrome_localstorage.py ai.5mt5.com ai.88wk.org --json
  python3 tools/read_chrome_localstorage.py --list-profiles

注意：只读、不写、不动浏览器数据；输出的 token 属敏感凭据，只贴进运行时配置，不落仓库。
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys

BROWSER_ROOTS = [
    "~/Library/Application Support/Google/Chrome",
    "~/Library/Application Support/Chromium",
    "~/Library/Application Support/Microsoft Edge",
    "~/Library/Application Support/BraveSoftware/Brave-Browser",
    "~/Library/Application Support/Vivaldi",
    # Linux
    "~/.config/google-chrome",
    "~/.config/chromium",
]


def uvarint(buf: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while True:
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            break
        shift += 7
    return result, pos


def snappy_decompress(data: bytes) -> bytes:
    """纯 Python snappy 解压（leveldb 块用）。"""
    pos = 0
    _ulen, pos = uvarint(data, pos)
    out = bytearray()

    def copy(off: int, ln: int) -> None:
        start = len(out) - off
        for i in range(ln):
            out.append(out[start + i])

    while pos < len(data):
        tag = data[pos]
        pos += 1
        t = tag & 3
        if t == 0:  # literal
            ln = tag >> 2
            if ln < 60:
                ln += 1
            else:
                nb = ln - 59
                ln = int.from_bytes(data[pos:pos + nb], "little") + 1
                pos += nb
            out += data[pos:pos + ln]
            pos += ln
        elif t == 1:  # copy, 1-byte offset
            ln = ((tag >> 2) & 0x7) + 4
            off = ((tag >> 5) << 8) | data[pos]
            pos += 1
            copy(off, ln)
        elif t == 2:  # copy, 2-byte offset
            ln = (tag >> 2) + 1
            off = int.from_bytes(data[pos:pos + 2], "little")
            pos += 2
            copy(off, ln)
        else:  # copy, 4-byte offset
            ln = (tag >> 2) + 1
            off = int.from_bytes(data[pos:pos + 4], "little")
            pos += 4
            copy(off, ln)
    return bytes(out)


def read_block(data: bytes, off: int, size: int) -> bytes:
    content = data[off:off + size]
    if not content:
        return b""
    # 压缩类型字节紧跟在块内容之后（handle 的 size 不含它）
    typ = data[off + size] if off + size < len(data) else 0
    if typ == 1:
        try:
            return snappy_decompress(content)
        except Exception:
            return b""
    return content


def iter_block(blk: bytes):
    pos = 0
    prev = b""
    n = len(blk)
    if n < 4:
        return
    num_restarts = int.from_bytes(blk[-4:], "little")
    data_end = n - 4 - 4 * num_restarts
    if data_end < 0 or data_end > n:
        data_end = n - 4
    while pos < data_end:
        try:
            shared, pos = uvarint(blk, pos)
            nonshared, pos = uvarint(blk, pos)
            vlen, pos = uvarint(blk, pos)
        except IndexError:
            return
        key = prev[:shared] + blk[pos:pos + nonshared]
        pos += nonshared
        val = blk[pos:pos + vlen]
        pos += vlen
        prev = key
        yield key, val


def iter_table(path: str):
    """.ldb（SSTable）"""
    data = open(path, "rb").read()
    if len(data) < 48:
        return
    foot = data[-48:]
    pos = 0
    _m_off, pos = uvarint(foot, pos)
    _m_size, pos = uvarint(foot, pos)
    i_off, pos = uvarint(foot, pos)
    i_size, pos = uvarint(foot, pos)
    idx = read_block(data, i_off, i_size)
    for _k, v in iter_block(idx):
        p = 0
        o, p = uvarint(v, p)
        s, p = uvarint(v, p)
        blk = read_block(data, o, s)
        yield from iter_block(blk)


def _parse_batch(buf: bytes):
    res = []
    if len(buf) < 12:
        return res
    cnt = int.from_bytes(buf[8:12], "little")
    pos = 12
    for _ in range(cnt):
        if pos >= len(buf):
            break
        t = buf[pos]
        pos += 1
        klen, pos = uvarint(buf, pos)
        key = buf[pos:pos + klen]
        pos += klen
        if t == 1:  # PUT
            vlen, pos = uvarint(buf, pos)
            val = buf[pos:pos + vlen]
            pos += vlen
            res.append((key, val))
        else:  # DELETE
            res.append((key, None))
    return res


def iter_log(path: str):
    """.log（WAL，未压缩）"""
    data = open(path, "rb").read()
    pos = 0
    buf = b""
    while pos < len(data):
        rest = 32768 - (pos % 32768)
        if rest < 7:
            pos += rest
            continue
        hdr = data[pos:pos + 7]
        if len(hdr) < 7:
            break
        length = int.from_bytes(hdr[4:6], "little")
        typ = hdr[6]
        pos += 7
        frag = data[pos:pos + length]
        pos += length
        if typ == 0:
            yield from _parse_batch(frag)
            buf = b""
        elif typ == 1:
            buf = frag
        elif typ == 2:
            buf += frag
        elif typ == 3:
            buf += frag
            yield from _parse_batch(buf)
            buf = b""
        elif typ == 4:
            pass
        else:
            break


def decode_val(v: bytes | None) -> str | None:
    """Chrome localStorage 的值带 1 字节编码前缀：0=UTF-16LE，1=UTF-8。"""
    if v is None:
        return None
    if not v:
        return ""
    flag, body = v[0], v[1:]
    if flag == 0:
        try:
            return body.decode("utf-16-le")
        except Exception:
            return body.decode("utf-8", "replace")
    return body.decode("utf-8", "replace")


def split_key(k: bytes) -> tuple[str | None, str | None]:
    """Chrome localStorage 键形如 `_<origin>\\x00\\x01<name>`（尾部可能带 8 字节内部后缀）。"""
    s = k.decode("utf-8", "replace")
    m = re.match(r"^_(https?://[^\x00]*)\x00\x01(.*)$", s, re.S)
    if not m:
        try:
            s = k.decode("utf-16-le", "replace")
            m = re.match(r"^_(https?://[^\x00]*)\x00\x01(.*)$", s, re.S)
        except Exception:
            return None, None
    if not m:
        return None, None
    name = re.split(r"[\x00-\x1f]", m.group(2))[0]
    return m.group(1), name


def find_profiles() -> list[str]:
    out = []
    for root in BROWSER_ROOTS:
        root = os.path.expanduser(root)
        if not os.path.isdir(root):
            continue
        for d in sorted(os.listdir(root)):
            p = os.path.join(root, d, "Local Storage", "leveldb")
            if os.path.isdir(p):
                out.append(p)
    return out


def collect(leveldb_dir: str) -> dict[bytes, bytes | None]:
    kv: dict[bytes, bytes | None] = {}
    files = sorted(glob.glob(leveldb_dir + "/*.log")) + sorted(glob.glob(leveldb_dir + "/*.ldb"))
    for f in files:
        try:
            it = iter_log(f) if f.endswith(".log") else iter_table(f)
            for k, v in it:
                if k:
                    kv[k] = v
        except Exception as e:  # 单文件失败不影响整体
            print(f"  [warn] {os.path.basename(f)}: {e}", file=sys.stderr)
    return kv


def main() -> int:
    ap = argparse.ArgumentParser(description="直读系统 Chrome/Chromium 系 localStorage")
    ap.add_argument("domains", nargs="*", help="按域名子串过滤，如 ai.5mt5.com")
    ap.add_argument("--list-profiles", action="store_true", help="只列出扫到的 profile 目录")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出")
    ap.add_argument("--all-keys", action="store_true", help="不过滤域名，打印全部 origin 的键名")
    args = ap.parse_args()

    profiles = find_profiles()
    if args.list_profiles:
        for p in profiles:
            print(p)
        return 0
    if not profiles:
        print("没找到 Chrome 系 profile（Windows 需另指定路径）", file=sys.stderr)
        return 1
    if not args.domains and not args.all_keys:
        print("请给至少一个域名，或用 --list-profiles / --all-keys", file=sys.stderr)
        return 2

    found: dict[str, dict[str, str | None]] = {}
    for p in profiles:
        kv = collect(p)
        for k, v in kv.items():
            origin, name = split_key(k)
            if origin is None or name is None:
                continue
            if args.all_keys or any(d in origin for d in args.domains):
                found.setdefault(origin, {})[name] = decode_val(v)

    if args.json:
        print(json.dumps(found, ensure_ascii=False, indent=1))
        return 0
    if not found:
        print("未命中：这些域名在 localStorage 里没有记录（可能未登录 / 未访问，或用的是非 Chromium 浏览器）")
        return 1
    for origin, kvs in sorted(found.items()):
        print(f"### {origin}")
        for name, val in sorted(kvs.items()):
            show = val if val is None or len(val) <= 120 else val[:120] + f"...({len(val)} 字符)"
            print(f"   {name} = {show}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
