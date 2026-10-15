"""搜索关键词归一：与前端 web/lib/format.ts 的 looseSearchKey 同一套规则。

去除非「字母 / 数字 / CJK」之外的字符再转小写，于是「GPT-4o」与「gpt4o」能互相命中。
后端按同一套规则做服务端搜索，结果与前端旧的前端过滤保持一致。"""
from __future__ import annotations

import re

_STRIP = re.compile(r"[^a-z0-9\u4e00-\u9fff]")


def loose_key(text: str) -> str:
    return _STRIP.sub("", text.lower())
