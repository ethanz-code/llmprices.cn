"""任务体注册表：按 kind + 参数现取最新配置构建任务体，HTTP 路由、调度器与子进程执行器共用。

拆进程采集（2026-10-16）：采集类任务体默认在独立子进程里跑（见 webapi/task_runner.py），
主进程只留任务注册表与调度——此前采集与 API 同进程，一轮采集的解析与写库会把接口从毫秒级
拖到秒级（GIL 与 CPU 争用），页面在采集期跟着变慢。kind 与参数在这里定义一次，路由只做
参数校验与转发，避免「路由一套 kind、调度器另一套」的口径分叉。
"""
from __future__ import annotations

from dataclasses import replace
from typing import Any, Callable

from llm_price_monitor.config import MonitorConfig
from llm_price_monitor.store import Store
from llm_price_monitor.webapi import jobs
from llm_price_monitor.webapi.deps import load_config

Job = Callable[[], dict[str, Any]]


class UnknownSite(ValueError):
    """请求里的 site_id/site_ids 在配置中不存在（或都已停用）：路由据此回 400。"""


def resolve_sites(config: MonitorConfig, params: dict[str, Any]) -> MonitorConfig:
    """按参数裁剪站点集：单站请求视作手动测试（强制启用），批量只取启用中的站点。

    参数来自 HTTP 路由或子进程执行器；校验失败抛 UnknownSite，由调用方转成 400 或任务失败。"""
    site_id = params.get("site_id")
    if site_id:
        sites = tuple(site for site in config.sites if site.id == site_id)
        if not sites:
            raise UnknownSite(f"配置中不存在站点: {site_id}")
        # 显式单站请求视作手动测试：扫描会跳过停用站点，这里强制启用
        return replace(config, sites=(replace(sites[0], enabled=True),))
    site_ids = params.get("site_ids")
    if site_ids is not None:
        wanted = {str(value) for value in site_ids if value}
        sites = tuple(site for site in config.sites if site.id in wanted and site.enabled)
        if not sites:
            raise UnknownSite("所选站点不存在或均已停用")
        return replace(config, sites=sites)
    return config


def build_job(kind: str, params: dict[str, Any], store: Store) -> Job:
    """按 kind 构建任务体；kind 取值见 tests/test_job_registry.py 的完整性用例。"""
    vendor = str(params.get("vendor") or "")
    if kind == "vendor-source-refresh":
        if not vendor:
            raise ValueError("vendor-source-refresh 缺少 vendor 参数")
        return jobs.vendor_source_refresh_job(store, vendor)
    if kind == "catalog-refresh":
        return jobs.catalog_refresh_job(store)
    if kind == "rankings-refresh":
        return jobs.rankings_refresh_job(store)
    if kind == "discovery-refresh":
        return jobs.discovery_refresh_job(store)
    config = resolve_sites(load_config(store), params)
    if kind in ("collect", "collect-test"):
        # 延迟导入：完整采集的任务体留在 routes/collect.py（那里持有 run_once 的模块级引用，
        # 测试按 collect_routes.run_once 打桩），模块顶部导入会与 collect.py 形成环
        from llm_price_monitor.webapi.routes.collect import full_collect_job

        return full_collect_job(config, store, bool(params.get("persist")))
    if kind == "collect-price":
        return jobs.price_scan_job(config, store)
    if kind == "collect-status":
        return jobs.status_scan_job(config, store)
    if kind == "collect-notice":
        return jobs.notice_scan_job(config, store)
    if kind == "collect-screenshot":
        return jobs.screenshot_scan_job(config, store)
    if kind == "collect-popularity":
        return jobs.popularity_scan_job(config, store, force=bool(params.get("force")))
    raise ValueError(f"未知任务类型: {kind}")
