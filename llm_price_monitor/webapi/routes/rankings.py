"""模型榜单端点：AA 排名读取与手动刷新。

定时同步由统一调度器（webapi.scheduler）按 settings.schedule.rankings 间隔触发；
手动刷新共用同一个任务体（jobs.rankings_refresh_job）。读取是访客功能，路径
在 app.py 的 public_get_paths 白名单里。
"""
from __future__ import annotations

import math
from typing import Any

from fastapi import APIRouter, HTTPException

from llm_price_monitor.store import Store
from llm_price_monitor.text_search import loose_key
from llm_price_monitor.webapi import tasks
from llm_price_monitor.webapi.jobs import rankings_refresh_job

# 可排序字段（前端列 dataIndex）；其余按自然顺序（榜单自带排名）返回
_SORT_KEYS = {"rank", "intelligence_index", "median_output_tokens_per_second", "latency_first_chunk_seconds"}
_PAGE_LIMIT_MAX = 500


def build_router(store: Store) -> APIRouter:
    router = APIRouter()

    @router.get("/api/rankings")
    def rankings(
        limit: int | None = None,
        offset: int = 0,
        q: str | None = None,
        sort: str | None = None,
        dir: str = "ascend",
    ) -> dict[str, Any]:
        """模型榜单单页读取：q 搜索（模型/厂商/slug，与前端同一套规则）、sort/dir 排序、limit/offset 分页。

        total 为全量条数（页面摘要用），filtered_total 为 q 过滤后的条数（分页器用）。"""
        doc = store.get_document("rankings")
        if not doc:
            raise HTTPException(status_code=404, detail="模型榜单不存在（登录后在管理台手动刷新，或等待定时同步）")
        models = list(doc.get("models") or [])
        total = len(models)
        creator_total = len({m.get("creator") for m in models if m.get("creator")})
        if q and q.strip():
            needle = loose_key(q)
            models = [
                m
                for m in models
                if needle in loose_key(str(m.get("name") or ""))
                or needle in loose_key(str(m.get("creator") or ""))
                or needle in loose_key(str(m.get("slug") or ""))
            ]
        if sort in _SORT_KEYS:
            if sort == "latency_first_chunk_seconds":
                key = lambda m: m.get(sort) if isinstance(m.get(sort), (int, float)) else math.inf
            else:
                key = lambda m: m.get(sort) if isinstance(m.get(sort), (int, float)) else -1
            models.sort(key=key, reverse=(dir == "descend"))
        filtered_total = len(models)
        if limit is None:
            page = models
        else:
            limit = max(1, min(limit, _PAGE_LIMIT_MAX))
            offset = max(0, offset)
            page = models[offset : offset + limit]
        return {
            **{key: value for key, value in doc.items() if key != "models"},
            "models": page,
            "total": total,
            "filtered_total": filtered_total,
            "creator_total": creator_total,
        }

    @router.post("/api/rankings/refresh")
    def rankings_refresh() -> dict[str, str]:
        try:
            task_id = tasks.submit("rankings-refresh", rankings_refresh_job(store))
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"task_id": task_id}

    return router
