"""只读数据端点：首页总览、最新快照、历史、事件、meta、健康检查与内嵌文档。"""
from __future__ import annotations

from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from llm_price_monitor.catalog import fx
from llm_price_monitor.catalog.discount import ABOVE_OFFICIAL_MAX_RATIO, build_discount
from llm_price_monitor.feed_page import notice_excerpt
from llm_price_monitor.feed_page import slim_events
from llm_price_monitor.report import summary_row
from llm_price_monitor.store import Store
from llm_price_monitor.webapi import auth
from llm_price_monitor.webapi.deps import catalog_models, is_admin, load_config, require_catalog_rate


# 采集异常状态：只有这两种会让页面上的价格"停在上一轮"，需要主动告诉访客；
# 其余状态（ok/rule_only/candidate/unavailable/disabled）不构成"价格没更新"，不进提示清单
ALERT_STATUSES = ("error", "auth_required")


def collect_alerts(store: Store, site_ids: set[str]) -> list[dict[str, Any]]:
    """本轮价格采集异常的站点清单，只保留当前展示中的站点。

    公开接口下发，所以**只带站点 id、状态与检查时间**：原始 error 文案里有内网地址、
    认证细节甚至 token 提示，只留给管理台的「采集异常」卡片，不随公开响应外泄。
    站点只挑「表里有价可看、但这轮没更新」的——没上表的站点没有可对照的价格，
    挂出来只会刷屏成噪音。顺序按严重度（先采集失败、后需认证）再按站点 id，保证渲染稳定。
    """
    status_doc = store.get_document("collect_status")
    if not isinstance(status_doc, dict):
        return []
    alerts = [
        {
            "site_id": site_id,
            "status": str(entry.get("status")),
            "checked_at": entry.get("checked_at"),
        }
        for site_id, entry in status_doc.items()
        if site_id in site_ids
        and isinstance(entry, dict)
        and entry.get("status") in ALERT_STATUSES
    ]
    alerts.sort(key=lambda alert: (ALERT_STATUSES.index(alert["status"]), alert["site_id"]))
    return alerts


def site_config_flags(sites: Iterable[Any]) -> dict[str, dict[str, bool]]:
    """各站采集配置的布尔标志：前端「站点综合分·配置完整」一项的输入，逐项表示是否已配置。

    与 /api/overview 里的 site_completeness（只剩兼容用途）是两套规则，新增项以这份为准。
    """
    return {
        site.id: {
            "network": bool(site.network),
            "status": bool(site.status),
            "notice": bool(site.notice),
            "networks": bool(site.networks),
            "token_refresh": bool(site.token_refresh),
            "homepage": bool(site.homepage),
            "enabled": bool(site.enabled),
        }
        for site in sites
    }


# /api/overview 下发瘦身：这些键只在库里留档（采集溯源、审计回查），web/ 全量检索确认
# 没有任何页面读取（2026-10-16 普查；与 feed_page.EVENT_METADATA_KEYS 同一口径——
# 「不渲染就不下发」）。整包 5.5MB 里证据/倍率/对照字段约占三分之一，剥掉后列表页的
# 内联载荷同步变小。新增前端读取处要同步从清单移除，否则字段会被裁掉。
_OVERVIEW_ARCHIVE_ONLY_KEYS = frozenset({
    # 采集溯源与审计证据：只在库里留档，页面上从不渲染
    "network_evidence", "page_evidence", "denomination", "billing_expr",
    "billing_mode", "billing_multiplier", "pricing_version", "request_rules",
    "adapter", "observed_model", "aliases", "pricing_cny_rate",
    # newapi 原始倍率与开关：站点价一律以 input/output_price 为准，前端不自行换算
    "newapi", "model_ratio", "completion_ratio", "cache_ratio",
    "create_cache_ratio", "group_ratio", "ratio_base_price", "currency",
    "enable_groups",
})

# discount 同理：前端只读 input/output 两个折扣值（折扣列、排序、中位数），其余是留档
_DISCOUNT_ARCHIVE_ONLY_KEYS = frozenset({
    "source_url", "region", "input_price_cny", "output_price_cny",
    "official_input_cny", "official_output_cny",
})


def _slim_overview_record(row: dict[str, Any]) -> dict[str, Any]:
    """records 行瘦身：剥离「只在库里留档」的字段（含顶层 fingerprint 指纹）。"""
    record = {key: value for key, value in row.items() if key != "fingerprint"}
    metadata = record.get("metadata")
    if isinstance(metadata, dict):
        record["metadata"] = {
            key: value for key, value in metadata.items() if key not in _OVERVIEW_ARCHIVE_ONLY_KEYS
        }
    discount = record.get("discount")
    if isinstance(discount, dict):
        record["discount"] = {
            key: value for key, value in discount.items() if key not in _DISCOUNT_ARCHIVE_ONLY_KEYS
        }
    return record


def build_router(store: Store) -> APIRouter:
    router = APIRouter()

    @router.get("/api/overview")
    def overview(site_id: str | None = None) -> dict[str, Any]:
        """首页数据：最新快照逐条附加官方价折扣；采集异常站点清单对访客同样公开。

        site_id 可选：只保留该站的记录（站点检测详情页用它取本站在售模型与分组集合，省全量序列化）。"""
        report = store.get_document("catalog")
        models, meta = catalog_models(report)
        discount_of: Callable[[dict[str, Any]], dict[str, Any] | None] | None = None
        live_rate: dict[str, Any] = {}
        if models:
            rate, rate_source = require_catalog_rate(report)
            live_rate = {"usd_cny_rate": round(rate, 2), "rate_source": rate_source}

            def discount_of(row: dict[str, Any]) -> dict[str, Any] | None:
                entry, _reason = build_discount(summary_row(row), models, rate)
                return entry.as_dict() if entry is not None else None

        latest = store.latest_all()
        if site_id:
            latest = {
                key: row
                for key, row in latest.items()
                if isinstance(row, dict) and str(row.get("site_id")) == site_id
            }
        records: list[dict[str, Any]] = []
        for row in latest.values():
            if not isinstance(row, dict):
                continue
            discount = discount_of(row) if discount_of else None
            # 站价高于官方价（折扣 > 100%）不展示：中转站比官价还贵，没有选择价值。
            # 采集侧已不入快照，这里再兜一层，兼顾改造前入库的旧行。
            if discount is not None and any(
                isinstance(discount.get(axis), (int, float)) and discount[axis] > ABOVE_OFFICIAL_MAX_RATIO
                for axis in ("input", "output")
            ):
                continue
            records.append(_slim_overview_record({**row, "discount": discount}))
        # 本轮表里真正展示的站点：公告与采集异常清单都只认这一批
        shown_sites = {str(row.get("site_id")) for row in records if isinstance(row, dict)}
        # 各站点最新公告（每站一条，原样带给前端做单行摘要；没采集到公告的站点无键）
        notices: dict[str, dict[str, Any]] = {}
        for site_id in shown_sites:
            notice = store.latest_notice(site_id)
            if isinstance(notice, dict) and notice.get("content"):
                # 列表只渲染一行摘要（悬停最多 6 行）：正文在库里留档，全文走 /api/notice/event
                notices[site_id] = {
                    "excerpt": notice_excerpt(str(notice["content"]), 6),
                    "captured_at": notice.get("captured_at"),
                }
        # 站点信息完整度：认证凭证、附加采集地址各 1 分（0–2），给前端智能排序用；
        # network.ratio_url（倍率接口）与价格接口同地址、token_refresh（续签）均不计分
        config = load_config(store)
        site_completeness = {
            site.id: sum(
                (
                    bool(site.auth_token),
                    bool(site.networks),
                )
            )
            for site in config.sites
        }
        # 站点配置标志（结构化）：站点综合分里「配置完整」一项的输入，逐项布尔、前端定清单与权重。
        # 与上面的 site_completeness 是两套规则（那一套只剩兼容用途），新增项以这份为准
        site_flags = site_config_flags(config.sites)
        return {
            "records": records,
            "notices": notices,
            # 监控模型列表（管理台配置）：站点详情页渠道行的过滤基准（见 lib/channelStatus.ts）
            "monitor_models": list(config.settings.monitor_models),
            "site_completeness": site_completeness,
            "site_flags": site_flags,
            # 汇率标准与折扣页一致：优先实时值（拉取失败回落官方价目录缓存并标注）
            "catalog": {
                **meta,
                **live_rate,
                "enabled": bool(models),
            },
            # 本轮采集异常的站点（脱敏，公开）：前端在价格表上方提示「这些站的价格可能不是最新的」
            "collect_alerts": collect_alerts(store, shown_sites),
        }

    @router.get("/api/latest")
    def latest() -> dict[str, Any]:
        return store.latest_all()

    def display_rate() -> dict[str, Any]:
        """事件/历史端点附带的展示汇率：快照优先、实时后备；拿不到就不附，前端回落原币展示。"""
        report = store.get_document("catalog")
        snapshot_rate = report.get("usd_cny_rate") if isinstance(report, dict) else None
        rate, source = fx.resolve_rate(snapshot_rate)
        return {"rate": round(rate, 2), "rate_source": source} if rate else {}

    @router.get("/api/history")
    def history(limit: int = 500, site_id: str | None = None, model: str | None = None) -> dict[str, Any]:
        records, total = store.read_history(limit=limit, site_id=site_id, model=model)
        return {"records": records, "total": total, **display_rate()}

    @router.get("/api/feed")
    def feed(events_limit: int = 200, notice_limit: int = 200) -> dict[str, Any]:
        """统一事件流：价格事件与站点公告事件按时间合并排序，各自的全量总数单独给出。

        分组下线事件只在库里留档（排查模型消失时查 price_events），不在任何页面展示：
        首页、历史页、管理台共用本接口，在这里拦掉即全端隐藏。

        下发前瘦身（见 llm_price_monitor/feed_page.py）：公告正文换摘要（全文走
        /api/notice/event 按需取）、价格事件 metadata 走白名单；两者列表侧都用不到，
        整份 1.3 MB 降到约三分之一。
        """
        price_events, price_total = store.read_events(limit=events_limit, exclude_kind="group_removed")
        notice_events, notice_total = store.read_notice_events(limit=notice_limit)
        return {
            "events": slim_events(price_events, notice_events),
            "price_total": price_total,
            "notice_total": notice_total,
        }

    @router.get("/api/meta")
    def meta(request: Request) -> dict[str, Any]:
        config = load_config(store)
        return {
            "sites": [
                {
                    "id": site.id,
                    "models": [target.name for target in site.models],
                    "url": site.network.get("url"),
                    "enabled": site.enabled,
                }
                for site in config.sites
            ],
            "is_admin": is_admin(store, request),
            "needs_setup": auth.get_admin(store) is None,
        }

    @router.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @router.get("/api/docs/readme")
    def readme() -> dict[str, str]:
        """管理面板文档页用：读仓库根 README.md 原文，找不到时报 404。"""
        # data.py 位于 llm_price_monitor/webapi/routes/ 下，三层向上到包、四层到仓库根
        for candidate in (Path(__file__).resolve().parents[3] / "README.md", Path.cwd() / "README.md"):
            if candidate.is_file():
                return {"markdown": candidate.read_text(encoding="utf-8")}
        raise HTTPException(status_code=404, detail="未找到 README.md")

    return router
