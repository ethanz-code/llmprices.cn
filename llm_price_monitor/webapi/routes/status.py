"""站点附属时序数据端点：渠道状态与站点公告（各自的时间线与变化事件）。"""
from __future__ import annotations

import json
import threading
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Response

from llm_price_monitor.catalog.discount import ABOVE_OFFICIAL_MAX_RATIO, build_discount
from llm_price_monitor.report import summary_row
from llm_price_monitor.status_views import build_monitored_sets, build_site_views
from llm_price_monitor.store import Store
from llm_price_monitor.webapi.deps import catalog_models, require_catalog_rate

# /api/status 的响应缓存：同一查询（站点/条数/窗口）在一分钟内直接回上次序列化好的 JSON 字节。
# 首页与总览每次加载都会逐站各拉一次、整轮 40MB+，缓存后重复加载不再重读 SQLite、也不再重新
# 序列化这 40MB —— 前端那层（lib/statusData.ts）另有结果缓存，两层一起把重复取数的代价压到最低。
_STATUS_CACHE: dict[tuple[Any, ...], tuple[float, bytes]] = {}
_STATUS_CACHE_TTL = 60.0
_STATUS_CACHE_MAX = 512

# 列表页渠道视图：算一次要读 21 站原始快照（约 49MB）+ 解析，冷算 5–6 秒，不能放在请求路径上。
# 改为算好写库、接口只读这份文档；过期（超过 TTL）时后台线程刷一次，请求永远拿现成的。
_VIEWS_DOC = "site_views"
_VIEWS_TTL = 300.0
_VIEWS_PER_SITE = 400
_VIEWS_WINDOW_SECONDS = 7 * 86_400
_EMPTY_VIEWS: dict[str, Any] = {"channels": {}, "availability": {}, "uptimeBuckets": {}}
_views_lock = threading.Lock()
_views_refreshing = False


def _monitored_sets(store: Store) -> dict[str, set[str]]:
    """在售模型与分组集合：从与 /api/overview 同一套规则的最新价格行（已剔除站价高于官价的记录）构建，
    保证列表页的渠道过滤规则与详情页一致——渠道行只留对得上在售模型/分组的行。"""
    report = store.get_document("catalog")
    models, _meta = catalog_models(report)
    rate: float | None = None
    if models:
        try:
            rate, _ = require_catalog_rate(report)
        except Exception:  # 汇率缺失时退化为不过滤（返回全量渠道）
            rate = None
    latest = store.latest_all()
    rows: list[dict[str, Any]] = []
    for row in latest.values():
        if not isinstance(row, dict):
            continue
        if models and rate is not None:
            entry, _reason = build_discount(summary_row(row), models, rate)
            discount = entry.as_dict() if entry is not None else None
            if discount is not None and any(
                isinstance(discount.get(axis), (int, float))
                and discount[axis] > ABOVE_OFFICIAL_MAX_RATIO
                for axis in ("input", "output")
            ):
                continue
        rows.append(row)
    return build_monitored_sets(rows)


def _compute_site_views(store: Store) -> dict[str, Any]:
    """算一份全站列表视图：读近 7 天每站最近 400 条快照，解析成渠道行/可用率/时段分桶。"""
    since = int((time.time() - _VIEWS_WINDOW_SECONDS) // 60 * 60)
    records, _total = store.read_status(per_site=_VIEWS_PER_SITE, since=since)
    return build_site_views(records, _monitored_sets(store))


def _refresh_site_views(store: Store) -> None:
    """后台线程用：算好并写库，再放掉刷新中标志。"""
    global _views_refreshing
    try:
        store.set_document(_VIEWS_DOC, {"at": time.time(), "views": _compute_site_views(store)})
    except Exception:  # 刷新失败保留旧文档，下次访问再试
        pass
    finally:
        with _views_lock:
            _views_refreshing = False


def build_router(store: Store) -> APIRouter:
    router = APIRouter()

    @router.get("/api/status")
    def status_data(
        limit: int = 200,
        site_id: str | None = None,
        per_site: int | None = None,
        since: float | None = None,
        max_records: int | None = None,
    ) -> Response:
        """渠道状态时序（自由结构 JSON）；per_site 按站点分组各取最近 N 条，since 只取该 Unix 时间之后的快照。
        max_records 限制返回行数：窗口内记录更多时由存储层按 id 均匀抽样（total 仍返回全量行数）。"""
        key = (site_id, limit, per_site, since, max_records)
        now = time.monotonic()
        hit = _STATUS_CACHE.get(key)
        if hit is not None and now - hit[0] < _STATUS_CACHE_TTL:
            return Response(content=hit[1], media_type="application/json")

        records, total = store.read_status(
            site_id=site_id, limit=limit, per_site=per_site, since=since, max_records=max_records
        )
        payload = json.dumps({"records": records, "total": total}, ensure_ascii=False).encode("utf-8")
        # 简单防膨胀：条目过多时整体清空（键数量本就有界，这里只是回退）
        if len(_STATUS_CACHE) >= _STATUS_CACHE_MAX:
            _STATUS_CACHE.clear()
        _STATUS_CACHE[key] = (now, payload)
        return Response(content=payload, media_type="application/json")

    @router.get("/api/status/latest")
    def status_latest() -> dict[str, Any]:
        return store.latest_status_all()

    @router.get("/api/status/views")
    def status_views() -> dict[str, Any]:
        """列表页渠道视图：读写库的算好结果，请求路径上不现算。

        原先首页/总览要逐站拉最近 400 条原始快照（21 站合计约 49MB，内含站点上游整包 JSON）
        再在 Node 里解析；这里把同样的解析搬到后端并写库缓存（标准见 llm_price_monitor/status_views.py），
        原始 JSON 不出后端、解析也不在请求路径上。首次（库还没这份文档）同步算一次，之后只读；
        超过 TTL 由后台线程刷新，请求永远拿现成结果。"""
        global _views_refreshing
        doc = store.get_document(_VIEWS_DOC)
        views = doc.get("views") if isinstance(doc, dict) else None
        if not isinstance(views, dict):
            # 从未算过（首次部署/清库）：同步算一次填坑，慢这一次
            store.set_document(_VIEWS_DOC, {"at": time.time(), "views": _compute_site_views(store)})
            refreshed = store.get_document(_VIEWS_DOC)
            return refreshed.get("views") if isinstance(refreshed, dict) else _EMPTY_VIEWS
        if time.time() - float(doc.get("at") or 0) >= _VIEWS_TTL:
            with _views_lock:
                start = not _views_refreshing
                if start:
                    _views_refreshing = True
            if start:
                threading.Thread(target=_refresh_site_views, args=(store,), daemon=True).start()
        return views

    @router.get("/api/status/events")
    def status_event_list(limit: int = 200, site_id: str | None = None, kind: str | None = None) -> dict[str, Any]:
        status_events, total = store.read_status_events(limit=limit, site_id=site_id, kind=kind)
        return {"events": status_events, "total": total}

    @router.get("/api/notice")
    def notice_data(limit: int = 200, site_id: str | None = None) -> dict[str, Any]:
        """站点公告版本时序；content 为公告正文（Markdown/纯文本），仅在内容变化时新增版本。"""
        records, total = store.read_notice(site_id=site_id, limit=limit)
        return {"records": records, "total": total}

    @router.get("/api/notice/event")
    def notice_event_body(site_id: str, detected_at: float) -> dict[str, Any]:
        """单条公告事件的正文：事件流为省体积只下发摘要，详情弹窗打开时按需来这里取全文。"""
        content = store.notice_event_content(site_id=site_id, detected_at=detected_at)
        if content is None:
            raise HTTPException(status_code=404, detail="公告事件不存在")
        return {"site_id": site_id, "detected_at": detected_at, "content": content}

    return router
