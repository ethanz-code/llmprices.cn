"""采集与后台任务端点：全量采集 + 价格/渠道状态/站点公告拆分采集 + 任务状态查询。

任务体统一登记在 webapi/job_registry.py，默认由独立子进程执行（tasks.submit_remote）：
采集的解析与写库不再与 API 争 CPU，页面在采集期保持毫秒级响应（2026-10-16 拆进程）。
"""
from __future__ import annotations

from dataclasses import asdict
from typing import Any, Callable

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from llm_price_monitor.config import MonitorConfig
from llm_price_monitor.report import attach_catalog_discounts, run_once, summary_row
from llm_price_monitor.store import Store
from llm_price_monitor.webapi import tasks
from llm_price_monitor.webapi.deps import load_config
from llm_price_monitor.webapi.job_registry import UnknownSite, resolve_sites


class CollectBody(BaseModel):
    persist: bool = False
    site_id: str | None = None
    site_ids: list[str] | None = None
    # 人气采集专用：true = 手动全量刷新，无视「7 天内已有数据就跳过外部查询」的新鲜策略
    force: bool = False





def full_collect_job(config: MonitorConfig, store: Store, persist: bool) -> Callable[[], dict[str, Any]]:
    """全量采集任务体：价格+渠道状态+站点公告一次跑完，结果附加官方折扣供预览。

    由 webapi/job_registry.py 延迟导入（模块顶部导入会形成环）；任务体在本模块持有
    run_once 的模块级引用，测试按 collect_routes.run_once 打桩即生效。"""
    def _run() -> dict[str, Any]:
        report = run_once(config, store=store, persist=persist)
        output = attach_catalog_discounts(asdict(report), store.get_document("catalog"))
        return {
            "records": [summary_row(row) for row in output["records"]],
            "events": [event["kind"] for event in report.events],
            "errors": report.errors,
            "persisted": persist,
            "catalog": output["catalog"],
            # 逐站价格采集状态：401/需认证这类"整站无价但不算错误"的情况靠它报给用户
            "site_price_status": [
                {"site_id": site_id, "status": value.get("status"), "error": value.get("error")}
                for site_id, value in report.site_status.items()
            ],
            # 公告只在内容新增/更新时产生记录；渠道状态只回传有变化的事件，无变化不展示
            "notices": [
                {"site_id": item["site_id"], "kind": item["kind"], "content": item["content"]}
                for item in report.notice_records
            ],
            # 逐站公告结果（含无变化/无接口等常态），测试弹窗据此给每站一条公告反馈
            "notice_results": [
                {"site_id": item["site_id"], "outcome": item["outcome"], "content": item["content"]}
                for item in report.notice_results
            ],
            "statuses": [
                {"site_id": event["site_id"], "kind": event["kind"], "changes": event["changes"]}
                for event in report.status_events
            ],
        }

    return _run


def build_router(store: Store) -> APIRouter:
    router = APIRouter()

    def _submit(kind: str, body: CollectBody) -> dict[str, str]:
        """校验站点参数后转交任务注册表：默认独立子进程执行（见 tasks.submit_remote）。"""
        params = body.model_dump()
        try:
            resolve_sites(load_config(store), params)
        except UnknownSite as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        try:
            task_id = tasks.submit_remote(kind, params)
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"task_id": task_id}

    @router.post("/api/collect")
    def collect(body: CollectBody) -> dict[str, str]:
        # 单站请求是测试采集，任务列表单独标记，不与正式全量采集混在同一类型里
        kind = "collect-test" if body.site_id else "collect"
        return _submit(kind, body)

    @router.post("/api/collect/price")
    def collect_price(body: CollectBody) -> dict[str, str]:
        return _submit("collect-price", body)

    @router.post("/api/collect/status")
    def collect_status(body: CollectBody) -> dict[str, str]:
        return _submit("collect-status", body)

    @router.post("/api/collect/notice")
    def collect_notice(body: CollectBody) -> dict[str, str]:
        return _submit("collect-notice", body)

    @router.post("/api/collect/screenshot")
    def collect_screenshot(body: CollectBody) -> dict[str, str]:
        """手动触发站点截图：与定时任务同一任务体，可指定站点。"""
        return _submit("collect-screenshot", body)

    @router.post("/api/collect/popularity")
    def collect_popularity(body: CollectBody) -> dict[str, str]:
        """手动触发站点人气采集：与定时任务同一任务体，可指定站点；force=全量刷新（无视数据新鲜度）。"""
        return _submit("collect-popularity", body)

    @router.get("/api/tasks")
    def list_tasks() -> dict[str, Any]:
        return {"tasks": tasks.recent()}

    # 概览页“采集异常”卡片：跨任务汇总警告/错误日志，支持逐条移除与一键清空；
    # 需声明在 /api/tasks/{task_id} 之前，否则 "errors" 会被当成 task_id 吞掉
    @router.get("/api/tasks/errors")
    def task_error_stream() -> dict[str, Any]:
        return {"entries": tasks.error_stream()}

    @router.delete("/api/tasks/errors")
    def clear_task_errors() -> dict[str, int]:
        return {"remaining": tasks.clear_errors()}

    @router.delete("/api/tasks/errors/{key}")
    def dismiss_task_error(key: str) -> dict[str, bool]:
        return {"ok": tasks.dismiss_error(key)}

    @router.get("/api/tasks/{task_id}")
    def task_status(task_id: str) -> dict[str, Any]:
        task = tasks.get(task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="任务不存在")
        return task

    return router
