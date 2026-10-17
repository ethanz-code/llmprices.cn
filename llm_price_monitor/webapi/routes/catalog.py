"""官方价目录端点：目录读取与手动刷新。

定时同步由统一的调度器（webapi.scheduler）负责，到点提交 catalog-refresh 任务；
手动刷新共用同一个任务体（jobs.catalog_refresh_job）。
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from llm_price_monitor.catalog.all_page import DEFAULT_PAGE_SIZE, page_catalog_all
from llm_price_monitor.store import Store
from llm_price_monitor.webapi import tasks


def build_router(store: Store) -> APIRouter:
    router = APIRouter()

    @router.get("/api/catalog")
    def catalog() -> dict[str, Any]:
        report = store.get_document("catalog")
        if not report:
            raise HTTPException(status_code=404, detail="厂商价目录不存在（首次启动会自动同步，也可登录后手动刷新）")
        return report

    @router.get("/api/catalog/all")
    def catalog_all(
        limit: int | None = None,
        offset: int = 0,
        q: str | None = None,
        vendor: str | None = None,
        sort: str | None = None,
        dir: str = "ascend",
    ) -> dict[str, Any]:
        """全量渠道价目录。8000+ 条，整份约 8 MB，浏览页按页取。

        带 limit/q/vendor/sort/offset 任一参数时走分页（只回当前页 + 总数 + 厂商清单）；
        一个参数都不带时仍是整份文档，保持既有调用方的行为不变。limit=0 只回计数。
        sort 只认白名单里的列键（见 catalog.all_page.SORT_KEYS），其余值按目录排序排序。
        """
        report = store.get_document("catalog_all")
        if not report:
            raise HTTPException(status_code=404, detail="全量渠道价目录不存在（登录后在厂商定价页手动刷新即可生成）")
        if limit is None and not q and not vendor and not sort and offset == 0:
            return report
        return page_catalog_all(
            report,
            q=q,
            vendor=vendor,
            limit=DEFAULT_PAGE_SIZE if limit is None else limit,
            offset=offset,
            sort=sort,
            direction=dir,
        )

    @router.post("/api/catalog/refresh")
    def catalog_refresh() -> dict[str, str]:
        try:
            task_id = tasks.submit_remote("catalog-refresh")
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"task_id": task_id}

    return router
