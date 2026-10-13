"""事件流下发口径：列表只带渲染用得到的字段，正文与采集溯源留在库里按需另取。

背景（2026-10-13 实测）：/api/feed 原先整份下发，历史页一次 1.3 MB，其中公告正文
625 KB、价格事件 metadata 484 KB。这两块只有「点开详情」才用得到，列表侧只看标题、
分组标签与摘要，所以在下发前裁掉：

- 公告事件不带 content，改带同口径摘要 excerpt；完整正文按需取
  （GET /api/notice/event，见 routes/status.py，浏览器侧经 web 的转发路由）。
- 价格事件 metadata 走白名单 EVENT_METADATA_KEYS，其余是采集溯源自证
  （network_evidence / denomination / enable_groups / billing_expr …），只在库里留档。
"""
from __future__ import annotations

import re
from typing import Any, Iterable

# HTML 标签与 Markdown 标题井号：与前端 web/lib/format.ts 的 noticeExcerpt 同口径
_TAG_RE = re.compile(r"<[^>]*>")
_HEADING_RE = re.compile(r"^#+\s*")

# 公告事件（正文带 HTML 片段）与价格事件（正文是价对）在事件流里同构，靠 kind 区分
NOTICE_KINDS = frozenset({"notice_init", "notice_changed"})

# 价格事件 metadata 里前端真正读到的键（对 web/ 全量检索确认）：
# group 分组标签（事件流分组、折叠键）、pricing_rules 阶梯价文案、三个 cache_* 缓存价、
# confidence/notes/error 记录状态说明。新增前端读取处要同步加在这里，否则字段会被裁掉。
EVENT_METADATA_KEYS = (
    "group",
    "pricing_rules",
    "cache_read_price",
    "cache_create_price",
    "cache_create_1h_price",
    "confidence",
    "notes",
    "error",
)


def notice_excerpt(content: str, max_lines: int = 1) -> str:
    """公告正文摘要：先剥 HTML 标签，去掉 Markdown 标题井号，取前 max_lines 行；
    超长截断加省略号。默认单行、上限 120 字——与前端 noticeExcerpt 完全一致，
    列表因此可以只拿摘要、不拿正文。

    注：JS 的 length/slice 按 UTF-16 码元计，这里按码点计；正文以中英文为主，
    含代理对（emoji）时截断位置可能差一个字符，不会切出非法字符串。
    """
    parts = [_HEADING_RE.sub("", part.strip()) for part in _TAG_RE.sub(" ", content).split("\n")]
    lines = [part for part in parts if part]
    text = " ".join(lines[:max_lines]) or content
    cap = 120 if max_lines <= 1 else max_lines * 110
    return f"{text[:cap]}…" if len(text) > cap else text


def slim_price_event(event: dict[str, Any]) -> dict[str, Any]:
    """价格事件：current/previous 的 metadata 裁到白名单，其余原样保留。"""
    slimmed = dict(event)
    for side in ("current", "previous"):
        record = slimmed.get(side)
        if not isinstance(record, dict):
            continue
        metadata = record.get("metadata")
        if not isinstance(metadata, dict):
            continue
        slimmed[side] = {**record, "metadata": {key: metadata[key] for key in EVENT_METADATA_KEYS if key in metadata}}
    return slimmed


def slim_notice_event(event: dict[str, Any]) -> dict[str, Any]:
    """公告事件：正文换成同口径摘要（正文按需另取）。"""
    slimmed = {key: value for key, value in event.items() if key != "content"}
    slimmed["excerpt"] = notice_excerpt(str(event.get("content") or ""))
    return slimmed


def slim_events(price_events: Iterable[dict[str, Any]], notice_events: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """统一事件流的下发形态：两侧各自瘦身后按时间倒序合并（最新在前）。"""
    merged = [*(slim_price_event(event) for event in price_events), *(slim_notice_event(event) for event in notice_events)]
    return sorted(merged, key=lambda event: event["detected_at"], reverse=True)


__all__ = [
    "EVENT_METADATA_KEYS",
    "NOTICE_KINDS",
    "notice_excerpt",
    "slim_events",
    "slim_notice_event",
    "slim_price_event",
]
