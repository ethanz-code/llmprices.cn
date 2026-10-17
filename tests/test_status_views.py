"""status_views 与前端 web/lib/channelStatus.ts 同一套规则的回归钉子。

用例与前端 channelStatus.test.ts 一一对应（同样的输入、同样的期望值），
前端改了启发式规则时这里要同步改——两边不一致就是规则分叉。
"""
from __future__ import annotations

from llm_price_monitor.status_views import (
    build_monitored_sets,
    build_site_views,
    channel_dots_by_site,
)


def record(site_id: str, items: list[dict]) -> dict:
    return {"site_id": site_id, "captured_at": 1760000000, "data": {"items": items}}


def test_non_chat_image_channels_filtered():
    rows = channel_dots_by_site([record("demo", [
        {"name": "claude 满血", "status": "up"},
        {"name": "生图", "status": "up"},
        {"name": "grok生图", "status": "down"},
        {"name": "香蕉4k生图", "status": "up"},
        {"name": "image-4k", "status": "up"},
        {"name": "ImageGen", "status": "up"},
        {"name": "绘图增强", "status": "up"},
    ])])["demo"]
    assert [row["name"] for row in rows] == ["claude 满血"]


def test_non_chat_video_channels_filtered():
    rows = channel_dots_by_site([record("demo", [
        {"name": "gemini视频", "status": "up"},
        {"name": "grok视频", "status": "up"},
        {"name": "veo3.1", "status": "up"},
        {"name": "sora-v3-pro", "status": "down"},
        {"name": "seedence官key", "status": "up"},
        {"name": "专用gemini", "status": "up"},
        {"name": "企业gpt（不降智）", "status": "up"},
    ])])["demo"]
    assert [row["name"] for row in rows] == ["专用gemini", "企业gpt（不降智）"]


def test_broad_roots_do_not_misfire():
    rows = channel_dots_by_site([record("demo", [
        {"name": "doubao-seed-1.6", "status": "up"},
        {"name": "gpt-5", "status": "up"},
    ])])["demo"]
    assert [row["name"] for row in rows] == ["doubao-seed-1.6", "gpt-5"]


def test_metric_type_success_rate_normalized():
    rows = channel_dots_by_site([{
        "site_id": "demo", "captured_at": 1760000000,
        "data": {"items": [
            {"platform": "openai", "model": "gpt-5.6-sol", "metrics": {"success_rate": 1}},
            {"platform": "openai", "model": "gpt-5.6-terra", "metrics": {"success_rate": 0.7527}},
            {"platform": "openai", "model": "__other__", "metrics": {"success_rate": 0.5}},
        ]},
    }])["demo"]
    assert [[row["name"], row["status"]] for row in rows] == [
        ["gpt-5.6-terra", "75.27%"],
        ["gpt-5.6-sol", "100.00%"],
    ]
    assert rows[0]["ok"] is False
    assert rows[1]["ok"] is True


def test_no_sample_rows_skipped_and_latency_from_ttft():
    rows = channel_dots_by_site([{
        "site_id": "demo", "captured_at": 1760000000,
        "data": {"items": [
            {"platform": "openai", "model": "gpt-5.6-sol", "metrics": {"success_rate": 0.87, "error_rate": 0.13, "ttft": {"avg_ms": 16800}}},
            {"platform": "openai", "model": "claude-opus-4-6", "metrics": {"success_rate": 0, "error_rate": 0}},
            {"platform": "openai", "model": "gpt-5.2", "metrics": {}},
        ]},
    }])["demo"]
    assert [[row["name"], row["status"]] for row in rows] == [["gpt-5.6-sol", "87.00%"]]
    assert rows[0]["successRate24h"] == 87
    assert rows[0]["dots"][0]["latency"] == 16800


def test_top_level_percentage_form():
    rows = channel_dots_by_site([{
        "site_id": "demo", "captured_at": 1760000000,
        "data": {"items": [{"name": "claude", "success_rate": 97}]},
    }])["demo"]
    assert [[row["name"], row["status"], row["ok"]] for row in rows] == [["claude", "97.00%", True]]


def test_cache_metrics_metric_type():
    rows = channel_dots_by_site([{
        "site_id": "demo", "captured_at": 1760000000,
        "data": {"items": [{"platform": "openai", "model": "gpt-5.6-sol", "metrics": {
            "success_rate": 0.87, "cache_read_tokens": 1_280_000, "cache_creation_tokens": 48_000, "cache_rate": 0.8366,
        }}]},
    }])["demo"]
    dot = rows[0]["dots"][0]
    assert dot["cacheRead"] == 1_280_000
    assert dot["cacheWrite"] == 48_000
    assert round(dot["cacheRate"], 2) == 83.66
    assert rows[0]["cacheRead"] == 1_280_000


def test_cache_metrics_status_word_type():
    rows = channel_dots_by_site([{
        "site_id": "demo", "captured_at": 1760000000,
        "data": {"items": [
            {"id": 48, "name": "ChatGPT-Plus", "provider": "openai", "primary_status": "degraded", "cache_rate": 68.24},
        ]},
    }])["demo"]
    dot = rows[0]["dots"][0]
    assert round(dot["cacheRate"], 2) == 68.24
    assert dot["cacheRead"] is None
    assert dot["cacheWrite"] is None


def test_cache_metrics_absent_when_not_reported():
    rows = channel_dots_by_site([record("demo", [{"name": "claude", "status": "up"}])])["demo"]
    dot = rows[0]["dots"][0]
    assert dot["cacheRead"] is None
    assert dot["cacheWrite"] is None
    assert dot["cacheRate"] is None


def test_build_monitored_sets_union_of_model_and_group():
    sets = build_monitored_sets([
        {"site_id": "demo", "model": "Claude-Opus-5", "metadata": {"group": "满血CC Max分组"}},
        {"site_id": "demo", "model": "gpt-5.5", "metadata": {"group": None}},
        {"site_id": "other", "model": "m1"},
    ])
    assert sorted(sets["demo"]) == ["claude-opus-5", "gpt-5.5", "满血cc max分组"]
    assert sets["other"] == {"m1"}


def test_build_monitored_sets_merges_pool_and_site_baseline():
    """监控模型列表收进每站集合；site_ids 里的站即使没有价格行也建基线（只用监控列表过滤）。"""
    sets = build_monitored_sets(
        [{"site_id": "demo", "model": "gpt-5.5", "metadata": {"group": "gpt pro"}}],
        pool=["claude-opus-5-5", "GPT-6-Sol"],
        site_ids=["demo", "no-price"],
    )
    assert sorted(sets["demo"]) == ["claude-opus-5-5", "gpt pro", "gpt-5.5", "gpt-6-sol"]
    assert sorted(sets["no-price"]) == ["claude-opus-5-5", "gpt-6-sol"]


ITEMS = [
    {"name": "GPT Pro", "status": "up"},
    {"name": "gpt-5.5", "status": "down"},
    {"name": "福利gpt", "status": "up"},
    {"name": "科研组", "status": "up"},
]


def filtered_names(records: list[dict], monitored, site: str = "demo") -> list[str]:
    """过滤后的渠道行名：解析/过滤分离后，过滤入口是 build_site_views 的 monitored 参数。"""
    return [row["name"] for row in build_site_views(records, monitored)["channels"].get(site, [])]


def test_monitored_filter_keeps_matching_rows():
    monitored = build_monitored_sets([{"site_id": "demo", "model": "gpt-5.5", "metadata": {"group": "gpt pro"}}])
    assert filtered_names([record("demo", ITEMS)], monitored) == ["gpt-5.5", "GPT Pro"]


def test_monitored_filter_zero_match_returns_empty():
    """零命中不回退全量：站方状态页全是非监测范围的名字时清空，而不是全放回来拉低可用率。"""
    monitored = build_monitored_sets([{"site_id": "demo", "model": "aws-gpt", "metadata": {"group": "在售分组"}}])
    assert filtered_names([record("demo", ITEMS)], monitored) == []


def test_monitored_filter_drops_non_pool_old_models():
    """站方状态页列全站模型池：非监控列表的老模型滤掉，监控列表内精确同名保留（routekey 场景）。"""
    items = [
        {"name": "gemini-2.5-flash", "status": "down"},
        {"name": "gpt-4o", "status": "down"},
        {"name": "gpt-5.6-luna", "status": "up"},
    ]
    monitored = build_monitored_sets([], pool=["gpt-5.6-luna"], site_ids=["demo"])
    assert filtered_names([record("demo", items)], monitored) == ["gpt-5.6-luna"]


def test_monitored_filter_strict_no_suffix_compat():
    """严格归一匹配：站方变体名（日期版本尾、thinking 后缀）不认——不做后缀兼容，对不上就是空。"""
    items = [
        {"name": "gpt-5.6-luna-2026-07-09", "status": "up"},
        {"name": "claude-opus-5-5-thinking", "status": "up"},
    ]
    monitored = build_monitored_sets([], pool=["gpt-5.6-luna", "claude-opus-5-5"], site_ids=["demo"])
    assert filtered_names([record("demo", items)], monitored) == []


def test_monitored_filter_no_baseline_returns_empty():
    """站无监测集（没有任何过滤依据）也展示为空：不因缺依据回退全量。"""
    monitored = build_monitored_sets([{"site_id": "other", "model": "m1", "metadata": {"group": "g"}}])
    assert filtered_names([record("demo", ITEMS)], monitored) == []


def test_build_site_views_availability_respects_monitored():
    records = [record("demo", ITEMS)]
    monitored = build_monitored_sets([{"site_id": "demo", "model": "不在售模型", "metadata": {"group": "gpt pro"}}])
    filtered = build_site_views(records, monitored)["availability"]["demo"]
    assert filtered[-1]["pct"] == 100


def test_summarize_site_views_keeps_only_list_fields():
    """摘要只留列表页要用的数字：最新可用率点、渠道成功率均值、分桶 avg/count 与 down/checks。

    完整可用率序列（每站几百点、全量约 1.7MB）与渠道行明细不随列表下发——这是 2026-10-16
    列表页载荷瘦身的口径；前端站点卡与排序只读这里的字段（web/lib/types.ts 的 SiteChannelSummary）。"""
    from llm_price_monitor.status_views import summarize_site_views

    views = {
        "availability": {"s": [{"at": 1, "pct": 90, "down": []}, {"at": 2, "pct": 82, "down": ["a", "b"]}]},
        "channels": {"s": [{"successRate24h": 80.0}, {"successRate24h": 90.0}, {"no_rate": 1}]},
        "uptimeBuckets": {"s": [{"start": 0, "end": 60, "count": 5, "avg": 88, "worst": 60, "down": ["a"]}, None]},
    }
    assert summarize_site_views(views) == {
        "sites": {
            "s": {"pct": 82, "at": 2, "success": 85.0, "down": 2, "checks": 2, "buckets": [{"avg": 88, "count": 5}, None]},
        }
    }


def test_summarize_site_views_tolerates_missing_sections():
    """缺段/空视图不炸：没算过的库、老文档结构都按空摘要处理。"""
    from llm_price_monitor.status_views import summarize_site_views

    assert summarize_site_views({}) == {"sites": {}}
    assert summarize_site_views({"availability": {}, "channels": {}, "uptimeBuckets": {}}) == {"sites": {}}
