"""渠道状态视图：把站点状态快照解析成「渠道 → 检测点」并聚合出可用率序列与时段分桶。

这是前端 web/lib/channelStatus.ts 的 Python 移植版，规则必须逐字对齐（同一份状态快照、
同一套启发式键名，产出同一组数字）。为什么要搬过来：列表页（首页/总览）原先要逐站拉
最近 400 条原始快照（21 站合计约 49MB，内含站点上游整包 JSON），再在 Node 里解析；
瓶颈是这 49MB 的传输与解析，不是请求个数。放到后端算，原始 JSON 一步都不出后端，
前端只拿算好的可用率/时段分桶/渠道成功率，体积降到 1MB 级。

只提供给「列表页」用的精简结果：不含 dots（点阵仍由详情页/点阵接口按需拉），也不含
latency（列表不用）。详情页继续走前端 TS 版，两边标准由本文件顶部的常量与函数一一对齐。
"""
from __future__ import annotations

import math
import re
from collections.abc import Iterable
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Callable

# ---------- 与 web/lib/channelStatus.ts 对齐的常量 ----------

# 判定为“正常”的状态词表；与前端 UP_WORDS 一致（大小写不敏感、去首尾空格）
UP_WORDS = {
    "up", "ok", "okay", "normal", "available", "online", "healthy", "operational",
    "active", "success", "true", "1", "正常", "可用", "在线", "运行中", "健康",
}

STATUS_KEYS = ("status", "state", "health")
# "key"：分组形态接口的分组名（如 groups[].key），与前端 NAME_KEYS 一致
NAME_KEYS = ("name", "channel", "model", "model_name", "id", "title", "key")
# 纯容器键名：可以递归进入，但不能当作渠道名回退
FALLBACK_NAME_KEYS = {"items", "channels", "data", "list", "models", "services", "result", "results"}
# 非对话渠道关键词：与前端 NON_CHAT_CHANNEL_WORDS 逐字一致
NON_CHAT_CHANNEL_WORDS = (
    "图像", "生图", "画图", "绘图", "绘画", "image", "flux", "midjourney", "dall",
    "视频", "video", "veo", "sora", "seedance", "seedence", "kling", "可灵", "hailuo", "海螺",
    "vidu", "runway", "pika", "luma", "pixverse", "即梦", "jimeng", "万相", "wanx", "t2v", "i2v",
)
# 历史序列键名：不作为独立渠道递归，而是并成所属渠道的检测点
TIMELINE_KEYS = {"timeline", "history", "checks", "events", "logs", "log", "uptime"}
TIME_KEYS = ("checked_at", "checkedAt", "checked", "timestamp", "detected_at", "time", "at", "ts")
# 上限只防异常膨胀，与前端一致（展示量由在售范围过滤收窄）
MAX_CHANNELS = 256
MAX_DOTS = 720
MAX_SERIES_POINTS = 1440

LATENCY_KEYS = ("latency_ms", "latency", "response_ms", "primary_latency_ms", "average_latency_ms", "avg_latency_ms")
SUCCESS_RATE_KEYS = ("success_rate", "successRate")
ERROR_RATE_KEYS = ("error_rate", "errorRate")
TPS_KEYS = ("avg_tps", "tps")
RECENT_RATES_KEYS = ("recent_success_rates", "recentSuccessRates")
CACHE_READ_KEYS = ("cache_read_tokens", "cache_read", "cached_tokens", "cacheRead")
CACHE_WRITE_KEYS = (
    "cache_creation_tokens", "cache_write_tokens", "cache_create_tokens",
    "cache_creation", "cache_write", "cacheWrite",
)
CACHE_RATE_KEYS = ("cache_rate", "cache_hit_rate", "cacheRate")
# 站点状态里无名的汇总桶（sub2api v2 监控把未单列模型并进 __other__），不是渠道行
SENTINEL_NAMES = {"__other__"}

# JS Date.parse 的宽松 ISO：日期 + 可选时间，空格或 T 分隔，可选 Z/偏移
_DATE_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})"
    r"(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?"
    r"(Z|[+-]\d{2}:?\d{2})?)?$"
)


def _js_round(value: float) -> int:
    """JS Math.round：floor(x + 0.5)（与 Python 的银行家舍入不同）。"""
    return math.floor(value + 0.5)


def _js_str(value: Any) -> str:
    """JS String(value)：布尔小写、整数型浮点去掉 .0，其余同 repr。"""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        if math.isnan(value):
            return "NaN"
        if math.isinf(value):
            return "Infinity" if value > 0 else "-Infinity"
        if value.is_integer():
            return str(int(value))
        return repr(value)
    return str(value)


def _tofixed(value: float, digits: int = 2) -> str:
    """JS Number.toFixed：四舍五入到指定小数位（半值向外进，Python format 是半值取偶）。"""
    quantum = Decimal(1).scaleb(-digits)
    return str(Decimal(repr(value)).quantize(quantum, rounding=ROUND_HALF_UP))


def _is_up(raw: str) -> bool:
    return raw.strip().lower() in UP_WORDS


def find_status_key(obj: dict[str, Any]) -> str | None:
    """渠道状态键：精确的 status/state/health 优先，其次 *status 后缀（排除 status_code）。"""
    for key in STATUS_KEYS:
        value = obj.get(key)
        if value is not None and type(value) not in (dict, list):
            return key
    for key in obj:
        lower = key.lower()
        if lower.endswith("status") and not lower.endswith("status_code"):
            value = obj[key]
            if value is not None and type(value) not in (dict, list):
                return key
    return None


def _name_key(obj: dict[str, Any]) -> str | None:
    # type(v) in (int, float) 天然排除 bool（type(True) is bool），与 JS typeof 规则一致
    for key in NAME_KEYS:
        kind = type(obj.get(key))
        if kind is str or kind is int or kind is float:
            return key
    return None


def _parse_time(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(value):
        return _js_round(value / 1000) if value > 1e12 else value
    if isinstance(value, str):
        parsed = _date_parse(value)
        return None if parsed is None else _js_round(parsed / 1000)
    return None


def _date_parse(value: str) -> float | None:
    """宽松解析时间字符串为毫秒时间戳（对齐 JS Date.parse 常见输入）；无法解析返回 None。"""
    match = _DATE_RE.match(value.strip())
    if not match:
        return None
    year, month, day, hour, minute, second, milli, tz = match.groups()
    try:
        dt = datetime(
            int(year), int(month), int(day),
            int(hour or 0), int(minute or 0), int(second or 0), int((milli or "0").ljust(3, "0")) * 1000,
        )
    except ValueError:
        return None
    # 时区语义对齐 JS Date.parse：带 Z 按 UTC、带偏移按偏移、无时区按本机时区（naive.timestamp()）
    if tz == "Z":
        dt = dt.replace(tzinfo=timezone.utc)
    elif tz:
        sign = 1 if tz[0] == "+" else -1
        body = tz[1:].replace(":", "")
        dt = dt.replace(tzinfo=timezone(sign * timedelta(minutes=int(body[:2]) * 60 + int(body[2:4]))))
    return dt.timestamp() * 1000


def _number_or(*values: Any) -> float | None:
    for value in values:
        if type(value) in (int, float) and math.isfinite(value):
            return value
    return None


def _availability_pct(*values: Any) -> float | None:
    value = _number_or(*values)
    if value is None:
        return None
    return _js_round(value * 10000) / 100 if value <= 1 else value


def _find_latency(obj: dict[str, Any]) -> float | None:
    get = obj.get
    for key in LATENCY_KEYS:
        value = get(key)
        if type(value) in (int, float) and math.isfinite(value):
            return value
    metrics = get("metrics")
    if type(metrics) is dict:
        for container in ("ttft", "duration"):
            box = metrics.get(container)
            if type(box) is dict:
                avg = box.get("avg_ms")
                if type(avg) in (int, float) and math.isfinite(avg):
                    return avg
    return None


def _find_metric(obj: dict[str, Any], keys: tuple[str, ...]) -> float | None:
    get = obj.get
    for key in keys:
        value = get(key)
        if type(value) in (int, float) and math.isfinite(value):
            return value
    metrics = get("metrics")
    if type(metrics) is dict:
        for key in keys:
            value = metrics.get(key)
            if type(value) in (int, float) and math.isfinite(value):
                return value
    return None


def _normalize_rate(rate: float) -> float:
    return rate * 100 if 0 < rate <= 1 else rate


def _recent_rounds(obj: dict[str, Any]) -> list[float]:
    for key in RECENT_RATES_KEYS:
        value = obj.get(key)
        if type(value) is list:
            return [_normalize_rate(v) for v in value if type(v) in (int, float) and math.isfinite(v)]
    return []


def _find_cache_metrics(obj: dict[str, Any]) -> dict[str, float]:
    rate = _find_metric(obj, CACHE_RATE_KEYS)
    return {
        "cacheRead": _find_metric(obj, CACHE_READ_KEYS),
        "cacheWrite": _find_metric(obj, CACHE_WRITE_KEYS),
        "cacheRate": _normalize_rate(rate) if rate is not None else None,
    }


# 非对话渠道词表预编译成一条大小写不敏感的正则：逐词 any(... in lower) 在热路径上太慢
_NON_CHAT_RE = re.compile("|".join(re.escape(word) for word in NON_CHAT_CHANNEL_WORDS), re.IGNORECASE)


def _is_non_chat_channel(name: str) -> bool:
    return _NON_CHAT_RE.search(name) is not None


def _success_rate_level(rate: float) -> str:
    if rate >= 95:
        return "ok"
    if rate >= 80:
        return "warn"
    return "down"


def _timeline_dots(node: Any) -> list[dict[str, Any]]:
    if not isinstance(node, list):
        return []
    dots: list[dict[str, Any]] = []
    for item in node:
        if not isinstance(item, dict):
            continue
        status_key = find_status_key(item)
        if status_key is None:
            continue
        status = _js_str(item[status_key])
        at = next((_parse_time(item[key]) for key in TIME_KEYS if item.get(key) is not None), None)
        dots.append({"status": status, "ok": _is_up(status), "at": at, "latency": _find_latency(item), **_find_cache_metrics(item)})
    return dots


def _collect_channels(node: Any, fallback: str | None, depth: int, out: list[dict[str, Any]]) -> None:
    if len(out) >= MAX_CHANNELS:
        return
    if type(node) is list:
        for index, item in enumerate(node):
            _collect_channels(item, fallback if fallback is not None else f"#{index + 1}", depth, out)
        return
    if type(node) is not dict:
        return
    status_key = find_status_key(node)
    own: dict[str, Any] | None = None
    if status_key is not None:
        name_key = _name_key(node)
        name = _js_str(node[name_key]) if name_key is not None else (fallback if fallback is not None else "渠道")
        # 非对话渠道先短路：省掉缓存指标/延迟等只对被采纳渠道有用的计算
        if not _is_non_chat_channel(name):
            status = _js_str(node[status_key])
            cache = _find_cache_metrics(node)
            own = {
                "name": name,
                "status": status,
                "ok": _is_up(status),
                "provider": node.get("provider") if type(node.get("provider")) is str else None,
                "model": node.get("primary_model") if type(node.get("primary_model")) is str else (node.get("model") if type(node.get("model")) is str else None),
                "availability7d": _availability_pct(node.get("availability_7d"), node.get("availability")),
                **cache,
                "dots": [{"status": status, "ok": _is_up(status), "latency": _find_latency(node), **cache}],
            }
            out.append(own)
    else:
        # 指标型条目：没有状态词，用数值成功率表达健康度；先看名字，没名字就不必算指标
        name_key = _name_key(node)
        name = _js_str(node[name_key]) if name_key is not None else None
        if name is not None and name not in SENTINEL_NAMES and not _is_non_chat_channel(name):
            rounds = _recent_rounds(node)
            summary_rate = _find_metric(node, SUCCESS_RATE_KEYS)
            raw_rate = rounds[-1] if rounds else summary_rate
            rate = _normalize_rate(raw_rate) if raw_rate is not None else None
            error_rate = _find_metric(node, ERROR_RATE_KEYS)
            # 无样本行跳过：成功率与错误率双零说明窗口内没流量
            has_samples = (rate is not None and rate > 0) or (error_rate is not None and _normalize_rate(error_rate) > 0)
            if rate is not None and has_samples:
                ok = _success_rate_level(rate) == "ok"
                status = f"{_tofixed(rate)}%"
                cache = _find_cache_metrics(node)
                own = {
                    "name": name,
                    "status": status,
                    "ok": ok,
                    "provider": node.get("provider") if type(node.get("provider")) is str else None,
                    "model": node.get("primary_model") if type(node.get("primary_model")) is str else (node.get("model") if type(node.get("model")) is str else None),
                    "availability7d": _availability_pct(node.get("availability_7d"), node.get("availability")),
                    "dots": [{"status": status, "ok": ok, "latency": _find_latency(node), "rate": rate, "tps": _find_metric(node, TPS_KEYS), **cache}],
                    "successRate24h": _normalize_rate(summary_rate) if summary_rate is not None else None,
                    "recentRates": rounds or None,
                    **cache,
                }
                out.append(own)
    if depth > 0:
        for key, child in node.items():
            if type(child) not in (dict, list):
                continue
            if key.lower() in TIMELINE_KEYS:
                if own is not None:
                    own["dots"].extend(_timeline_dots(child))
                continue
            _collect_channels(child, None if key in FALLBACK_NAME_KEYS else key, depth - 1, out)


def _dedupe_dots(dots: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """同一时间点只保留最早出现的一条。"""
    seen_at: set[float] = set()
    out: list[dict[str, Any]] = []
    for dot in dots:
        at = dot.get("at")
        if at is not None:
            if at in seen_at:
                continue
            seen_at.add(at)
        out.append(dot)
    return out


def normalize_channel_name(name: str) -> str:
    return name.strip().lower()


def build_monitored_sets(
    records: list[dict[str, Any]],
    pool: Iterable[str] = (),
    site_ids: Iterable[str] = (),
) -> dict[str, set[str]]:
    """各站渠道监测集（site_id → 归一渠道名集合）：监控模型列表 ∪ 该站价格行「模型名 ∪ 计价分组名」。

    监控模型列表（管理台「监测模型」配置）是过滤基准——站方状态页里的老模型/杂项渠道
    不在列表内，自然被滤掉；价格行的分组名单独收（分组级状态页对分组名）。site_ids 里
    的站即使没有价格行也建基线（等于只用监控列表过滤其渠道行），与前端同一套规则。

    匹配是严格归一（去空格忽略大小写）：对不上就是不在范围内，不做任何后缀/前缀兼容。"""
    pool_keys = {normalize_channel_name(name) for name in pool}
    sets: dict[str, set[str]] = {site_id: set(pool_keys) for site_id in site_ids}
    for row in records:
        site_id = row.get("site_id")
        if not isinstance(site_id, str):
            continue
        bucket = sets.setdefault(site_id, set(pool_keys))
        model = row.get("model")
        if isinstance(model, str) and model:
            bucket.add(normalize_channel_name(model))
        metadata = row.get("metadata")
        group = metadata.get("group") if isinstance(metadata, dict) else None
        if isinstance(group, str) and group:
            bucket.add(normalize_channel_name(group))
    return sets


def _filter_rows_by_monitored(rows: list[dict[str, Any]], monitored: set[str] | None) -> list[dict[str, Any]]:
    """只留渠道名对得上监测集的行；监测集为空/缺失就对不上任何行，展示为空。

    不回退：零命中、监测集缺失都不放行全量——站方状态页常列全站模型池（含大量非监测
    范围的老模型），回退会把它们全放回来、把站级可用率拉低；对不上就展示为空。"""
    if not monitored:
        return []
    return [row for row in rows if normalize_channel_name(row["name"]) in monitored]


def channel_dots_by_site(records: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """按站点把状态时序合并成「渠道 → 检测点序列」；异常渠道排在前面。

    纯解析、返回全量渠道行——按监测范围过滤是调用方的显式一步（build_site_views 的
    monitored 参数），本函数不猜、也不做任何回退。"""
    maps: dict[str, dict[str, list[dict[str, Any]]]] = {}
    metas: dict[str, dict[str, dict[str, Any]]] = {}
    for record in sorted(records, key=lambda item: item.get("captured_at") or 0):
        site_id = record.get("site_id")
        if not isinstance(site_id, str):
            continue
        raw: list[dict[str, Any]] = []
        _collect_channels(record.get("data"), None, 3, raw)
        by_name: dict[str, list[dict[str, Any]]] = {}
        for channel in raw:
            by_name.setdefault(channel["name"], []).append(channel)
        site_map = maps.setdefault(site_id, {})
        site_meta = metas.setdefault(site_id, {})
        for name, instances in by_name.items():
            dots = site_map.setdefault(name, [])
            embedded = next((c for c in instances if len(c["dots"]) > 1), None)
            if embedded is not None:
                dots.extend(embedded["dots"])
            else:
                first = instances[0]
                d0 = first["dots"][0]
                dots.append({
                    "status": first["status"],
                    "ok": first["ok"],
                    "at": record.get("captured_at"),
                    "latency": d0.get("latency"),
                    "rate": d0.get("rate"),
                    "tps": d0.get("tps"),
                    "cacheRead": d0.get("cacheRead"),
                    "cacheWrite": d0.get("cacheWrite"),
                    "cacheRate": d0.get("cacheRate"),
                })
            site_map[name] = dots
            if name not in site_meta:
                site_meta[name] = instances[0]

    result: dict[str, list[dict[str, Any]]] = {}
    for site, site_map in maps.items():
        rows: list[dict[str, Any]] = []
        for name, dots in site_map.items():
            first = metas[site].get(name)
            ordered = sorted(_dedupe_dots(dots), key=lambda dot: dot.get("at") or 0)[-MAX_DOTS:]
            last = ordered[-1] if ordered else None
            rows.append({
                "name": name,
                "status": (first or {}).get("status") or (last or {}).get("status") or "unknown",
                "ok": bool(last.get("ok")) if last else False,
                "provider": (first or {}).get("provider"),
                "model": (first or {}).get("model"),
                "availability7d": (first or {}).get("availability7d"),
                "cacheRead": (first or {}).get("cacheRead"),
                "cacheWrite": (first or {}).get("cacheWrite"),
                "cacheRate": (first or {}).get("cacheRate"),
                "successRate24h": (first or {}).get("successRate24h"),
                "recentRates": (first or {}).get("recentRates"),
                "dots": ordered,
            })
        rows.sort(key=lambda row: 1 if row["ok"] else 0)
        result[site] = rows
    return result


def _latest_at(cursor: dict[str, Any], at: float) -> dict[str, Any] | None:
    dots = cursor["dots"]
    while cursor["index"] + 1 < len(dots) and dots[cursor["index"] + 1]["at"] <= at:
        cursor["index"] += 1
    dot = dots[cursor["index"]] if dots else None
    return dot if dot is not None and dot["at"] <= at else None


def full_availability_from_dots(by_site: dict[str, list[dict[str, Any]]]) -> dict[str, list[dict[str, Any]]]:
    """全量可用率序列（不抽稀）：某时刻各渠道正常占比与异常名单。"""
    result: dict[str, list[dict[str, Any]]] = {}
    for site, rows in by_site.items():
        cursors = [
            {"name": row["name"], "dots": [dot for dot in row["dots"] if dot.get("at") is not None], "index": 0}
            for row in rows
        ]
        times = sorted({dot["at"] for cursor in cursors for dot in cursor["dots"]})
        full: list[dict[str, Any]] = []
        for at in times:
            ok = 0
            total = 0
            down: list[str] = []
            for cursor in cursors:
                latest = _latest_at(cursor, at)
                if latest is None:
                    continue
                total += 1
                if latest["ok"]:
                    ok += 1
                else:
                    down.append(cursor["name"])
            if total > 0:
                full.append({"at": at, "pct": _js_round(ok / total * 100), "down": down})
        result[site] = full
    return result


def _downsample_worst(
    points: list[dict[str, Any]], max_points: int, worse: Callable[[dict, dict], dict]
) -> list[dict[str, Any]]:
    """最差值降采样：按时间跨度等分桶，每桶保留一个更「坏」的点；始终保留最后一个点。"""
    if len(points) <= max_points:
        return points
    span = points[-1]["at"] - points[0]["at"]
    size = max(span / max_points, 1)
    out: list[dict[str, Any]] = []
    index = 0
    total = len(points)
    while index < total:
        limit = points[index]["at"] + size
        rep = points[index]
        while index < total and points[index]["at"] < limit:
            if worse(points[index], rep) is points[index]:
                rep = points[index]
            index += 1
        out.append(rep)
    if out[-1] is not points[-1]:
        out.append(points[-1])
    return out


def build_uptime_buckets(points: list[dict[str, Any]], target: int = 28) -> list[dict[str, Any] | None]:
    """时段色块分桶：把检测点按时间跨度等分成 ~target 段，聚合平均/最差正常率与异常名单。"""
    if not points:
        return []
    t0 = points[0]["at"]
    t1 = points[-1]["at"]
    size = max((t1 - t0) / target, 1)
    total = min(max(math.ceil((t1 - t0) / size), 1), target)
    slots: list[dict[str, Any] | None] = [None] * total
    for point in points:
        index = min(math.floor((point["at"] - t0) / size), total - 1)
        bucket = slots[index]
        if bucket is not None:
            bucket["end"] = point["at"]
            bucket["count"] += 1
            bucket["avg"] += point["pct"]
            bucket["worst"] = min(bucket["worst"], point["pct"])
            for name in point["down"]:
                if name not in bucket["down"]:
                    bucket["down"].append(name)
        else:
            slots[index] = {
                "start": point["at"], "end": point["at"], "count": 1,
                "avg": point["pct"], "worst": point["pct"], "down": list(point["down"]),
            }
    for bucket in slots:
        if bucket is not None:
            bucket["avg"] = _js_round(bucket["avg"] / bucket["count"])
    return slots


def summarize_site_views(views: dict[str, Any]) -> dict[str, Any]:
    """渠道视图 → 列表页摘要：每站只留渲染与排序要用的数字。

    列表页（首页站点卡、站点墙、模型数据排序）只用到「最新一个可用率点、各渠道近 24h
    成功率均值、时段分桶的 avg/count」；完整视图里的可用率时间序列（每站 800+ 点，
    全量约 1.7MB）与渠道行明细是站点详情页的输入（详情页自己按站拉原始快照解析）。
    字段名与前端 web/lib/types.ts 的 SiteChannelSummary 对齐。"""
    availability = views.get("availability") if isinstance(views, dict) else None
    channels = views.get("channels") if isinstance(views, dict) else None
    buckets_by_site = views.get("uptimeBuckets") if isinstance(views, dict) else None
    sites: dict[str, dict[str, Any]] = {}
    site_ids = set(availability or {}) | set(channels or {}) | set(buckets_by_site or {})
    for site_id in sorted(site_ids):
        points = (availability or {}).get(site_id) or []
        last = points[-1] if isinstance(points, list) and points else None
        rates = [
            row.get("successRate24h")
            for row in ((channels or {}).get(site_id) or [])
            if isinstance(row, dict) and isinstance(row.get("successRate24h"), (int, float))
        ]
        buckets: list[dict[str, Any] | None] = []
        for bucket in (buckets_by_site or {}).get(site_id) or []:
            if isinstance(bucket, dict):
                buckets.append({"avg": bucket.get("avg"), "count": bucket.get("count")})
            else:
                buckets.append(None)
        down = last.get("down") if isinstance(last, dict) else None
        sites[site_id] = {
            "pct": last.get("pct") if isinstance(last, dict) else None,
            "at": last.get("at") if isinstance(last, dict) else None,
            "success": sum(rates) / len(rates) if rates else None,
            "down": len(down) if isinstance(down, list) else 0,
            "checks": len(points) if isinstance(points, list) else 0,
            "buckets": buckets,
        }
    return {"sites": sites}


def build_site_views(records: list[dict[str, Any]], monitored: dict[str, set[str]]) -> dict[str, Any]:
    """列表页用的精简视图：channels（不含 dots）+ availability（抽稀）+ uptimeBuckets。

    monitored（监控模型列表 ∪ 在售模型与分组集合）必传：解析出的渠道行先按监测范围过滤，
    可用率/时段分桶全部只落在过滤后的行上——没有监测范围的站（无键/空集）渠道视图即为空，
    不回退全量。与前端 buildSiteViews 同源同一套规则，但 channels 去掉 dots、不含 latency——
    列表页不渲染点阵与延迟趋势，点阵仍由 /api/channel-dots 与详情页按需拉。"""
    parsed = channel_dots_by_site(records)
    by_site: dict[str, list[dict[str, Any]]] = {
        site: _filter_rows_by_monitored(rows, monitored.get(site)) for site, rows in parsed.items()
    }
    full = full_availability_from_dots(by_site)
    uptime_buckets: dict[str, list[dict[str, Any] | None]] = {}
    for site, points in full.items():
        uptime_buckets[site] = build_uptime_buckets(points)
    availability: dict[str, list[dict[str, Any]]] = {
        site: _downsample_worst(points, MAX_SERIES_POINTS, lambda a, b: a if a["pct"] < b["pct"] else b)
        for site, points in full.items()
    }
    channels: dict[str, list[dict[str, Any]]] = {}
    for site, rows in by_site.items():
        channels[site] = [{key: value for key, value in row.items() if key != "dots"} for row in rows]
    return {"channels": channels, "availability": availability, "uptimeBuckets": uptime_buckets}
