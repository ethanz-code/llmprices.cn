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


ITEMS = [
    {"name": "GPT Pro", "status": "up"},
    {"name": "gpt-5.5", "status": "down"},
    {"name": "福利gpt", "status": "up"},
    {"name": "科研组", "status": "up"},
]


def test_monitored_filter_keeps_matching_rows():
    monitored = build_monitored_sets([{"site_id": "demo", "model": "gpt-5.5", "metadata": {"group": "gpt pro"}}])
    rows = channel_dots_by_site([record("demo", ITEMS)], monitored)["demo"]
    assert [row["name"] for row in rows] == ["gpt-5.5", "GPT Pro"]


def test_monitored_filter_falls_back_when_no_match():
    monitored = build_monitored_sets([{"site_id": "demo", "model": "aws-gpt", "metadata": {"group": "在售分组"}}])
    rows = channel_dots_by_site([record("demo", ITEMS)], monitored)["demo"]
    assert sorted(row["name"] for row in rows) == sorted(item["name"] for item in ITEMS)


def test_monitored_filter_isolated_per_site():
    monitored = build_monitored_sets([{"site_id": "other", "model": "m1", "metadata": {"group": "g"}}])
    rows = channel_dots_by_site([record("demo", ITEMS)], monitored)["demo"]
    assert sorted(row["name"] for row in rows) == sorted(item["name"] for item in ITEMS)


def test_build_site_views_availability_respects_monitored():
    records = [record("demo", ITEMS)]
    monitored = build_monitored_sets([{"site_id": "demo", "model": "不在售模型", "metadata": {"group": "gpt pro"}}])
    full = build_site_views(records)["availability"]["demo"]
    filtered = build_site_views(records, monitored)["availability"]["demo"]
    assert full[-1]["pct"] == 75
    assert filtered[-1]["pct"] == 100
