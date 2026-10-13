"""全量渠道价目录（models.dev 全网渠道）的浏览分页：关键词/厂商筛选 + 目录口径排序 + 分页。

这份目录有 8000+ 条、约 8 MB JSON，原先整份下发给浏览器、在浏览器里筛选排序；这里把同一套
筛选与排序口径搬到后端，接口只回当前页。

排序口径与前端 `web/lib/modelOrder.ts`（latestReleaseByVendor / vendorBlockCompare /
compareByReleaseDesc）和 `web/components/CatalogAllTable.tsx` 的表格一致：厂商块按各家最新
发布日期倒序（并列按厂商名升序），块内按发布日期倒序、再按模型名升序，没日期的条目垫底。
关键词口径与 `llm_price_monitor.text_search.loose_key` 一致（去分隔符后小写比较），搜索文本
含厂商显示名，所以"腾讯"也能命中 Tencent 的条目。
"""
from __future__ import annotations

from typing import Any, Iterable

from llm_price_monitor.text_search import loose_key

# 厂商显示名：与前端 web/lib/vendorNames.ts 的 VENDOR_DISPLAY 必须逐条一致（tests 里有单测钉住）。
# 后端要这份表是因为搜索在服务端做，"腾讯"这类中文别名只有映射后才能命中条目。
VENDOR_DISPLAY: dict[str, str] = {
    "alibaba cloud": "通义千问 Qwen",
    "01.ai": "零一万物",
    "baichuan": "百川智能",
    "baidu": "百度 文心",
    "iflytek": "讯飞星火",
    "moonshot ai": "月之暗面 Kimi",
    "sensenova": "商汤日日新",
    "siliconflow": "硅基流动",
    "stepfun": "阶跃星辰",
    "tencent": "腾讯混元",
    "volcengine ark": "火山方舟 豆包",
    "xiaomi": "小米 MiMo",
    "zhipu ai": "智谱 GLM",
}

# 分页响应里带上的目录元信息（其余字段如 providers 不下发，浏览用不到）
META_KEYS = ("generated_at", "generated_at_iso", "source", "source_url", "usd_cny_rate", "rate_source")

# 每页条数上限：与前端 lib/tableParams.ts 的 PAGE_SIZE_MAX 对齐
PAGE_SIZE_MAX = 500
DEFAULT_PAGE_SIZE = 100

# 可排序字段白名单：键就是前端列的标识（价格列 key=list、上下文列 key=limit、发布列 dataIndex=release_date）。
# 排序值口径与前端列的 sorter 一致：缺值按 0（发布日期按空串），升序时排在最前。
SORT_KEYS: dict[str, tuple[str, str | None]] = {
    "list": ("list", "input"),
    "limit": ("limit", "context"),
    "release_date": ("release_date", None),
}


def vendor_display(vendor: Any) -> str:
    """厂商显示名；未收录的厂商回落原始名（与前端同口径）。"""
    text = str(vendor)
    return VENDOR_DISPLAY.get(text.strip().lower(), text)


def _name_key(text: str) -> tuple[str, str]:
    """厂商/模型名排序键：对齐浏览器 `localeCompare` 的两条口径。

    1) 大小写只是次要差异——`"nanogpt".localeCompare("NanoGPT") < 0`，小写在前；
    2) 标点排在任何字母数字之前——`"~openai/x"` 排在 `"sakana/x"` 前。

    做法是给每个字符加一档前缀：标点 `1`、字母数字 `2`，档内按字符码。浏览器排序实际用的是
    ICU 表、且跟随用户语言环境（同一份数据在中文/英文浏览器里的次序都可能不同），这里只求
    稳定可复现并与原界面观感一致，不追求逐字复刻 ICU（实测 8042 条里 8 处同日并列次序不同，
    条目集合与厂商块序完全一致）。
    """
    folded = "".join(("2" + char.lower()) if char.isalnum() else ("1" + char) for char in text)
    return (folded, text.swapcase())


def _release(entry: dict[str, Any]) -> str:
    return str(entry.get("release_date") or "")


def _search_text(entry: dict[str, Any]) -> str:
    """条目参与关键词匹配的文本：模型名、厂商名与显示名、展示名。"""
    return " ".join(
        [
            str(entry.get("model") or ""),
            str(entry.get("vendor") or ""),
            vendor_display(entry.get("vendor")),
            str(entry.get("name") or ""),
        ]
    )


def found_entries(models: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """目录里「带价可展示」的条目（key、条目），保持传入顺序。"""
    return [(key, entry) for key, entry in models.items() if isinstance(entry, dict) and entry.get("found")]


def ordered_vendors(entries: Iterable[tuple[str, dict[str, Any]]]) -> list[str]:
    """厂商块顺序：各家最新发布日期倒序，并列按厂商名升序。

    没有发布日期的厂商照样进表（最新日期为空串），否则整家会被挤出块序、
    条目散落到别的块里去。
    """
    latest: dict[str, str] = {}
    for _, entry in entries:
        vendor = str(entry.get("vendor") or "")
        latest[vendor] = max(latest.get(vendor, ""), _release(entry))
    vendors = sorted(latest, key=_name_key)
    # 稳定排序：第二趟按最新发布日期倒序，日期相同的保持上一趟的厂商名顺序
    vendors.sort(key=lambda vendor: latest[vendor], reverse=True)
    return vendors


def sort_entries(entries: Iterable[tuple[str, dict[str, Any]]]) -> list[tuple[str, dict[str, Any]]]:
    """目录口径行序：厂商块 → 块内发布日期倒序 → 模型名升序（三趟稳定排序实现）。"""
    rows = list(entries)
    rank = {vendor: index for index, vendor in enumerate(ordered_vendors(rows))}
    rows.sort(key=lambda row: _name_key(str(row[1].get("model") or "")))
    rows.sort(key=lambda row: _release(row[1]), reverse=True)
    rows.sort(key=lambda row: rank.get(str(row[1].get("vendor") or ""), len(rank)))
    return rows


def filter_entries(
    entries: Iterable[tuple[str, dict[str, Any]]], *, q: str | None = None, vendor: str | None = None
) -> list[tuple[str, dict[str, Any]]]:
    """按厂商与关键词筛条目；厂商为精确匹配（下拉选项就是原始厂商名）。"""
    rows = list(entries)
    if vendor:
        rows = [row for row in rows if str(row[1].get("vendor") or "") == vendor]
    needle = loose_key(q or "")
    if needle:
        rows = [row for row in rows if needle in loose_key(_search_text(row[1]))]
    return rows


def _sort_value(entry: dict[str, Any], key: str) -> str | float:
    """列排序值：缺值按 0（发布日期按空串），与前端列 sorter 的 `?? 0` 同口径。"""
    parent, child = SORT_KEYS[key]
    if child is None:
        return str(entry.get(parent) or "")
    block = entry.get(parent)
    if not isinstance(block, dict):
        return 0.0
    value = block.get(child)
    if value is None:
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def apply_sort(
    rows: list[tuple[str, dict[str, Any]]], sort: str | None, direction: str = "ascend"
) -> list[tuple[str, dict[str, Any]]]:
    """按列排序（不传 sort 或不在白名单里就保持目录口径的行序）。

    稳定排序，所以并列项保持目录口径的次序（厂商块 + 发布日期），与前端在原整份数据上
    排序后的观感一致。"""
    if sort not in SORT_KEYS:
        return rows
    rows.sort(key=lambda row: _sort_value(row[1], sort), reverse=direction == "descend")
    return rows


def page_catalog_all(
    report: dict[str, Any],
    *,
    q: str | None = None,
    vendor: str | None = None,
    limit: int = DEFAULT_PAGE_SIZE,
    offset: int = 0,
    sort: str | None = None,
    direction: str = "ascend",
) -> dict[str, Any]:
    """全量渠道目录的一页：带元信息、总数、筛选后总数与厂商清单。

    `total` 是目录里带价条目的总数（不受筛选影响，表格抬头"共 N 条"用它）；
    `filtered_total` 是当前筛选后的条数（分页器按它算页数）。`limit=0` 只回计数与
    厂商清单，用于只想展示数字、不要行的场景。
    """
    models = report.get("models") or {}
    entries = found_entries(models)
    vendors = ordered_vendors(entries)
    matched = apply_sort(sort_entries(filter_entries(entries, q=q, vendor=vendor)), sort, direction)
    size = max(0, min(int(limit), PAGE_SIZE_MAX))
    start = max(0, int(offset))
    page = matched[start : start + size] if size else []
    return {
        **{key: report.get(key) for key in META_KEYS},
        "models": {key: entry for key, entry in page},
        "total": len(entries),
        "filtered_total": len(matched),
        "vendors": vendors,
    }


__all__ = [
    "DEFAULT_PAGE_SIZE",
    "META_KEYS",
    "PAGE_SIZE_MAX",
    "SORT_KEYS",
    "VENDOR_DISPLAY",
    "apply_sort",
    "filter_entries",
    "found_entries",
    "ordered_vendors",
    "page_catalog_all",
    "sort_entries",
    "vendor_display",
]
