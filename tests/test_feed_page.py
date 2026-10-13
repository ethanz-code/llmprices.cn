"""事件流下发瘦身口径：公告正文换摘要、价格事件 metadata 走白名单。

背景：/api/feed 原先整份下发，历史页一次 1.3 MB（公告正文 625 KB + metadata 484 KB），
两块都只有详情弹窗用得到。这里把口径钉住，防止以后有人"顺手"把字段加回来。
公告摘要与前端 web/lib/format.ts 的 noticeExcerpt 是同一套规则，两侧都要改才一致。
"""
import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from llm_price_monitor.feed_page import (
    EVENT_METADATA_KEYS,
    notice_excerpt,
    slim_events,
    slim_notice_event,
    slim_price_event,
)
from llm_price_monitor.webapi.app import create_app


@pytest.fixture
def client(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "var").mkdir()
    (tmp_path / "var" / "latest.json").write_text("{}", encoding="utf-8")
    (tmp_path / "var" / "history.jsonl").write_text("", encoding="utf-8")
    (tmp_path / "var" / "catalog.json").write_text(
        json.dumps({"generated_at": time.time(), "models": {}}), encoding="utf-8"
    )
    config = tmp_path / "config.json"
    config.write_text(
        json.dumps({"settings": {}, "sites": [], "vendors": []}),
        encoding="utf-8",
    )
    monkeypatch.setenv("PRICE_MONITOR_CONFIG", str(config))
    return TestClient(create_app(config))


# ---------- 公告摘要口径（与前端 noticeExcerpt 同规则） ----------

EXCERPT_CASES = [
    # (入参, 期望输出)：这批样例前端 web/lib/format.test.ts 里有同样的断言，两边同步改
    ("<div>公告</div>\n<p>第二行</p>", "公告"),
    ("# 标题\n正文", "标题"),
    ("###   带空格的标题\n正文", "带空格的标题"),
    ("\n\n   \n只有一个段落", "只有一个段落"),
    ("", ""),
]


@pytest.mark.parametrize("content,expected", EXCERPT_CASES)
def test_notice_excerpt_matches_frontend_rule(content: str, expected: str):
    assert notice_excerpt(content) == expected


def test_notice_excerpt_truncates_with_ellipsis():
    text = "字" * 200
    assert notice_excerpt(text) == "字" * 120 + "…"


def test_notice_excerpt_keeps_short_text_untouched():
    assert notice_excerpt("短文") == "短文"


def test_notice_excerpt_multiline_cap_grows():
    # 多行模式上限是行数 × 110（总览表公告列用），单行模式固定 120
    assert notice_excerpt("甲" * 300 + "\n乙", max_lines=2) == "甲" * 220 + "…"


# ---------- 事件瘦身 ----------


def _price_event(metadata: dict | None = None) -> dict:
    record = {
        "model": "gpt-5.6-sol",
        "unit": "CNY/1M tokens",
        "input_price": 1.0,
        "output_price": 2.0,
        "captured_at": 1791800000.0,
        "source_url": "https://example.com/api/pricing",
        "fingerprint": "abc",
    }
    if metadata is not None:
        record["metadata"] = metadata
    return {
        "site_id": "site-a",
        "model": "gpt-5.6-sol",
        "kind": "changed",
        "detected_at": 1791800000.0,
        "current": record,
        "previous": dict(record),
    }


def test_slim_price_event_keeps_whitelist_and_drops_trace():
    event = _price_event(
        {
            "group": "默认",
            "pricing_rules": {"groups": []},
            "cache_read_price": 0.1,
            "cache_create_price": 0.2,
            "cache_create_1h_price": 0.3,
            "confidence": 0.9,
            "notes": "备注",
            "error": None,
            # 下面这些是采集溯源自证：只在库里留档，不下发
            "network_evidence": [{"payload_sha256": "x" * 64}],
            "denomination": {"quota_per_unit": 500000.0},
            "enable_groups": ["claude", "max蒸馏"],
            "billing_expr": "p * 0.1 + cr * 0.01",
            "adapter": "browser_network",
        }
    )
    slimmed = slim_price_event(event)
    assert set(slimmed["current"]["metadata"]) == set(EVENT_METADATA_KEYS)
    assert slimmed["current"]["metadata"]["group"] == "默认"
    # 白名单里没有的键一并消失
    assert "enable_groups" not in slimmed["current"]["metadata"]
    # metadata 之外的原样保留（价对、单位、来源地址都是列表要用的）
    assert slimmed["current"]["input_price"] == 1.0
    assert slimmed["current"]["source_url"] == "https://example.com/api/pricing"
    assert slimmed["detected_at"] == event["detected_at"]


def test_slim_price_event_leaves_missing_metadata_alone():
    event = _price_event(None)
    assert slim_price_event(event) == event


def test_slim_notice_event_replaces_content_with_excerpt():
    event = {"site_id": "site-a", "kind": "notice_changed", "detected_at": 1791800000.0, "content": "<p>涨价公告</p>\n细则"}
    slimmed = slim_notice_event(event)
    assert "content" not in slimmed
    assert slimmed["excerpt"] == "涨价公告"
    assert slimmed["site_id"] == "site-a"


def test_slim_events_merges_newest_first():
    price = _price_event({"group": "默认"})
    price["detected_at"] = 100.0
    notice = {"site_id": "site-b", "kind": "notice_init", "detected_at": 200.0, "content": "公告"}
    merged = slim_events([price], [notice])
    assert [event["detected_at"] for event in merged] == [200.0, 100.0]


# ---------- 接口契约 ----------


def _seed(client: TestClient) -> None:
    store = client.app.state.store
    # append_events 把整条事件存进 payload 列，取出的就是这条 dict 本身（不是嵌套的 payload 字段）
    price = _price_event({"group": "默认", "enable_groups": ["claude"], "network_evidence": [{"x": 1}]})
    price["detected_at"] = 100.0
    store.append_events([price])
    store.append_notice_events(
        [
            {"site_id": "site-a", "kind": "notice_changed", "detected_at": 300.0, "content": "<div>大公告</div>"},
            {"site_id": "site-b", "kind": "notice_init", "detected_at": 200.0, "content": "首次公告"},
        ]
    )


def test_feed_endpoint_ships_excerpt_not_full_content(client: TestClient):
    _seed(client)
    body = client.get("/api/feed").json()
    notices = [event for event in body["events"] if event["kind"].startswith("notice_")]
    assert len(notices) == 2 and body["notice_total"] == 2
    for event in notices:
        assert "content" not in event, "公告正文不该随列表下发"
        assert event["excerpt"]
    assert body["price_total"] == 1
    price = next(event for event in body["events"] if event["kind"] == "changed")
    assert set(price["current"]["metadata"]) == {"group"}
    assert price["current"]["input_price"] == 1.0


def test_notice_event_content_endpoint_returns_full_body(client: TestClient):
    _seed(client)
    body = client.get("/api/notice/event", params={"site_id": "site-a", "detected_at": 300.0}).json()
    assert body["content"] == "<div>大公告</div>"


def test_notice_event_content_endpoint_tolerates_float_roundtrip(client: TestClient):
    """时间戳要经 Python→JSON→JS→URL 一趟往返，末位误差不该取不到正文。"""
    store = client.app.state.store
    store.append_notice_events(
        [{"site_id": "site-a", "kind": "notice_init", "detected_at": 1791865805.262589, "content": "浮点公告"}]
    )
    # 模拟 JS 侧 Number→字符串→float 的往返（该字符串是原始浮点的精确短表示）
    roundtripped = float(json.loads(json.dumps(1791865805.262589)))
    body = client.get("/api/notice/event", params={"site_id": "site-a", "detected_at": roundtripped}).json()
    assert body["content"] == "浮点公告"


def test_notice_event_content_endpoint_404_when_missing(client: TestClient):
    _seed(client)
    assert client.get("/api/notice/event", params={"site_id": "site-a", "detected_at": 12345.0}).status_code == 404
