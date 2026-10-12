"""站点附属时序数据端点：渠道状态与站点公告（各自的时间线与变化事件）。"""
from __future__ import annotations

import json
import time
from typing import Any

from fastapi import APIRouter, Response

from llm_price_monitor.store import Store

# /api/status 的响应缓存：同一查询（站点/条数/窗口）在一分钟内直接回上次序列化好的 JSON 字节。
# 首页与总览每次加载都会逐站各拉一次、整轮 40MB+，缓存后重复加载不再重读 SQLite、也不再重新
# 序列化这 40MB —— 前端那层（lib/statusData.ts）另有结果缓存，两层一起把重复取数的代价压到最低。
_STATUS_CACHE: dict[tuple[Any, ...], tuple[float, bytes]] = {}
_STATUS_CACHE_TTL = 60.0
_STATUS_CACHE_MAX = 512


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
        # 简单防膨胀：条目过多时整体清空（键数量本就有界，这里只是兜底）
        if len(_STATUS_CACHE) >= _STATUS_CACHE_MAX:
            _STATUS_CACHE.clear()
        _STATUS_CACHE[key] = (now, payload)
        return Response(content=payload, media_type="application/json")

    @router.get("/api/status/latest")
    def status_latest() -> dict[str, Any]:
        return store.latest_status_all()

    @router.get("/api/status/events")
    def status_event_list(limit: int = 200, site_id: str | None = None, kind: str | None = None) -> dict[str, Any]:
        status_events, total = store.read_status_events(limit=limit, site_id=site_id, kind=kind)
        return {"events": status_events, "total": total}

    @router.get("/api/notice")
    def notice_data(limit: int = 200, site_id: str | None = None) -> dict[str, Any]:
        """站点公告版本时序；content 为公告正文（Markdown/纯文本），仅在内容变化时新增版本。"""
        records, total = store.read_notice(site_id=site_id, limit=limit)
        return {"records": records, "total": total}

    return router
