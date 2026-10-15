"""站点人气：群链接/群号提取、Telegram 人数与访问量/排名解析、写库合并、接口与清理。

不真发外部请求：httpx 全走 MockTransport，TRANCO_INTERVAL_SECONDS 压到 0 免等。
"""
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from llm_price_monitor import popularity as pop
from llm_price_monitor.config import ModelTarget, SiteSpec, sites_from_raw
from llm_price_monitor.popularity import (
    POPULARITY_DOC,
    collect_site,
    extract_groups,
    fetch_telegram_stats,
    fetch_tranco_rank,
    fetch_visits_estimate,
    record_popularity,
    remove_popularity,
    site_host,
)
from llm_price_monitor.store import Store
from llm_price_monitor.webapi.app import create_app


def _spec(site_id: str = "demo", url: str | None = "https://demo.test/api/pricing", *, homepage: str | None = None) -> SiteSpec:
    raw = {"id": site_id, "network": {"url": url} if url else {}}
    if homepage:
        raw["homepage"] = homepage
    (spec,) = sites_from_raw([raw], models=(ModelTarget("gpt-5.6-luna"),))
    return spec


class _Config:
    def __init__(self, specs):
        self.sites = tuple(specs)


def _client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


# ---------- 群链接/群号提取 ----------


def test_extract_groups_classifies_and_dedupes():
    text = (
        "官方群 https://t.me/cun_ai 与 https://t.me/cun_ai 重复；"
        "Discord https://discord.gg/2WvCA5UcUh ；企业微信 https://work.weixin.qq.com/kfid/abc"
    )
    groups = extract_groups([text])
    assert [(g["type"], g["url"]) for g in groups] == [
        ("telegram", "https://t.me/cun_ai"),
        ("discord", "https://discord.gg/2WvCA5UcUh"),
        ("wechat", "https://work.weixin.qq.com/kfid/abc"),
    ]
    assert groups[0]["label"] == "@cun_ai"


def test_extract_groups_reads_qq_number_from_context_and_skips_duplicates():
    text = "加入交流群：726213516，或点击 https://qm.qq.com/q/uY9HpMhtUA ；无关数字 123456789 不算"
    groups = extract_groups([text])
    labels = [g["label"] for g in groups]
    assert "QQ 群 726213516" in labels
    assert all("123456789" not in label for label in labels)
    # 已有该群链接时不再重复收裸群号（链接里带 groupCode 的同群）
    shared = "https://qun.qq.com/universal-share/share?busi_data=eyJncm91cENvZGUiOiI3MjYyMTM1MTYiLCJ0b2tlbiI6IngifQ==&svctype=4 QQ群：726213516"
    groups = extract_groups([shared])
    assert [g["label"] for g in groups] == ["QQ 群 726213516"]
    assert groups[0]["url"].startswith("https://qun.qq.com/universal-share")


def test_extract_groups_strips_trailing_junk():
    groups = extract_groups(['见 https://t.me/cun_ai"。'])
    assert groups[0]["url"] == "https://t.me/cun_ai"


# ---------- Telegram / Tranco / 访问量解析 ----------


def test_fetch_telegram_stats_parses_members_and_online():
    html = '<div class="tgme_page_extra">1 183 members, 53 online</div>'
    with _client(lambda request: httpx.Response(200, text=html)) as client:
        assert fetch_telegram_stats("https://t.me/cun_ai", client) == {
            "members": 1183,
            "members_kind": "members",
            "online": 53,
        }
    # 频道标准是 subscribers：展示文案要叫「频道」而不是「群」
    channel = '<div class="tgme_page_extra">705 subscribers</div>'
    with _client(lambda request: httpx.Response(200, text=channel)) as client:
        assert fetch_telegram_stats("https://t.me/cun_ai", client) == {
            "members": 705,
            "members_kind": "subscribers",
        }


def test_fetch_telegram_stats_skips_invite_links_and_failures():
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        if request.url.path == "/ghost":
            # 用户名不存在时 t.me 给「Telegram: Contact @ghost」占位页：标成死链交给上层剔除
            return httpx.Response(200, text='<meta property="og:title" content="Telegram: Contact @ghost">')
        return httpx.Response(404)

    with _client(handler) as client:
        # 私邀链接没有公开预览页，直接不请求
        assert fetch_telegram_stats("https://t.me/+abcdef", client) == {}
        assert fetch_telegram_stats("https://t.me/joinchat/abc", client) == {}
        assert calls == []
        assert fetch_telegram_stats("https://t.me/ghost", client) == {"dead": True}
        # 预览页 404（抓取失败，不是死链）返回空对象，不抛异常
        assert fetch_telegram_stats("https://t.me/missing", client) == {}


def test_collect_site_drops_dead_telegram_username(monkeypatch):
    """t.me 上不存在的用户名（Contact 占位页）不进群列表；正常抓取失败的保留（下轮还能补）。"""
    monkeypatch.setattr(pop, "TRANCO_INTERVAL_SECONDS", 0)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "t.me":
            if request.url.path == "/dead_group":
                return httpx.Response(200, text='<meta property="og:title" content="Telegram: Contact @dead_group">')
            return httpx.Response(404)
        if request.url.host in {"tranco-list.eu", "hypestat.com"}:
            return httpx.Response(404)
        return httpx.Response(200, text="<footer>t.me/dead_group 与 t.me/flaky_group</footer>")

    with _client(handler) as client:
        payload = collect_site(_spec(), client)
    assert payload is not None
    assert [group["label"] for group in payload["groups"]] == ["@flaky_group"]


def test_fetch_tranco_rank_parses_and_tolerates_failure():
    """200 有值=排名；200 但榜单为空=上游明确没收录（settled）；查询失败不算结论。"""
    payload = {"ranks": [{"date": "2026-10-13", "rank": 461591}]}
    with _client(lambda request: httpx.Response(200, json=payload)) as client:
        assert fetch_tranco_rank("302.ai", client) == pop.RankResult(461591, True)
    with _client(lambda request: httpx.Response(429)) as client:
        assert fetch_tranco_rank("302.ai", client) == pop.RankResult()  # 限流：下轮重试
    with _client(lambda request: httpx.Response(200, json={"ranks": []})) as client:
        assert fetch_tranco_rank("tokenage.ai", client) == pop.RankResult(None, True)


def test_fetch_visits_estimate_parses_scale_and_handles_missing():
    page = "<div>Monthly Visits</div><div>134.7K</div>"
    with _client(lambda request: httpx.Response(200, text=page)) as client:
        assert fetch_visits_estimate("302.ai", client) == 134_700
    empty = "<div>Monthly Visits</div><div>数据不足</div>"
    with _client(lambda request: httpx.Response(200, text=empty)) as client:
        assert fetch_visits_estimate("cun.ai", client) is None


# ---------- SimilarWeb 站内 API 客户端（出口池） ----------


def _use_pool(monkeypatch, nodes=("nodeA", "nodeB"), *, current="nodeA") -> list[str]:
    """把出口池接到假节点上；返回记录选点调用的列表。"""
    import llm_price_monitor.popularity as popularity

    monkeypatch.setattr(popularity.egress, "effective_proxy", lambda: "http://proxy:9090")
    monkeypatch.setattr(popularity.proxy_switch, "pool_state", lambda: (list(nodes), current))
    picked: list[str] = []
    monkeypatch.setattr(popularity.proxy_switch, "select_node", lambda node: picked.append(node) or True)
    return picked


def test_similarweb_client_parses_visits(monkeypatch):
    """200 + visitsTotalCount → ok；请求带空质询 cookie（免 WAF 质询的实测规律）。"""
    import llm_price_monitor.popularity as popularity

    monkeypatch.setattr(popularity.egress, "effective_proxy", lambda: None)
    sw = pop.SimilarWebClient("test/1.0")

    def fake_get(url, **kwargs):
        assert "similarweb.com/api/website/302.ai" in url
        assert kwargs["cookies"] == {"aws-waf-token": ""}
        return httpx.Response(200, json={"overview": {"visitsTotalCount": 66918.0}})

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(popularity.httpx, "get", fake_get)
        result = sw.visits_with_retry("302.ai", "302")
    assert result.kind == "ok" and result.visits == 66918 and result.settled


def test_similarweb_client_maps_status_codes(monkeypatch):
    """状态码语义：202/403/405/429=被限流、204=上游没数据、0 访问量不算数、网络失败=error。"""
    import llm_price_monitor.popularity as popularity

    monkeypatch.setattr(popularity.egress, "effective_proxy", lambda: None)
    sw = pop.SimilarWebClient("test/1.0")
    with pytest.MonkeyPatch.context() as mp:
        for code in (202, 403, 405, 429):
            mp.setattr(popularity.httpx, "get", lambda url, **kw: httpx.Response(code, text=""))
            assert sw.visits_with_retry("a.test", "a").kind == "blocked"
        mp.setattr(popularity.httpx, "get", lambda url, **kw: httpx.Response(204, text=""))
        result = sw.visits_with_retry("a.test", "a")
        assert result.kind == "empty" and result.settled and result.visits is None
        mp.setattr(popularity.httpx, "get", lambda url, **kw: httpx.Response(200, json={"overview": {"visitsTotalCount": 0.0}}))
        assert sw.visits_with_retry("a.test", "a").kind == "empty"

        def boom(url, **kw):
            raise httpx.ConnectError("boom")

        mp.setattr(popularity.httpx, "get", boom)
        assert sw.visits_with_retry("a.test", "a").kind == "error"


def test_similarweb_single_egress_prefers_proxy_then_direct(monkeypatch):
    """没配节点切换时按单出口采集：代理优先、直连后备（SimilarWeb 拒本机直连 IP）。"""
    import llm_price_monitor.popularity as popularity

    monkeypatch.setattr(popularity.egress, "effective_proxy", lambda: "http://proxy:9090")
    monkeypatch.setattr(popularity.proxy_switch, "pool_state", lambda: None)
    sw = pop.SimilarWebClient("test/1.0")
    legs: list[str] = []

    def fake_get(url, **kwargs):
        legs.append(kwargs.get("proxy") or "direct")
        if kwargs.get("proxy"):
            return httpx.Response(403, text="blocked")
        return httpx.Response(200, json={"overview": {"visitsTotalCount": 12.0}})

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(popularity.httpx, "get", fake_get)
        result = sw.visits_with_retry("a.test", "a")
    assert result.kind == "ok" and result.visits == 12
    assert legs == ["http://proxy:9090", "direct"]


def test_similarweb_pool_rotates_only_on_block(monkeypatch):
    """出口池：被限流的出口冻结换下一个；上游没数据（204）不换出口。"""
    import llm_price_monitor.popularity as popularity

    picked = _use_pool(monkeypatch)
    sw = pop.SimilarWebClient("test/1.0")
    calls: list[str] = []

    def blocked_then_ok(url, **kwargs):
        calls.append(url)
        if len(calls) == 1:
            return httpx.Response(403, text="blocked")
        return httpx.Response(200, json={"overview": {"visitsTotalCount": 12.0}})

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(popularity.httpx, "get", blocked_then_ok)
        result = sw.visits_with_retry("a.test", "a")
    assert result.kind == "ok" and result.visits == 12
    assert picked == ["nodeB"] and len(calls) == 2  # 只换了一次出口
    # nodeB 成了当前出口、nodeA 在冻结名单：下一站直接从 nodeB 出，不再切
    picked.clear()
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(popularity.httpx, "get", lambda url, **kw: httpx.Response(200, json={"overview": {"visitsTotalCount": 7.0}}))
        assert sw.visits_with_retry("b.test", "b").visits == 7
    assert picked == []
    # 204（上游明确没数据）：不换出口、不算失败
    picked.clear()
    hits: list[str] = []
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(popularity.httpx, "get", lambda url, **kw: hits.append(url) or httpx.Response(204, text=""))
        result = sw.visits_with_retry("c.test", "c")
    assert result.kind == "empty" and result.settled and picked == [] and len(hits) == 1


def test_similarweb_pool_budget_and_freeze(monkeypatch):
    """窗口预算：用满就换出口；出口被冻/池子用尽时停手交给下轮，不当场硬打。"""
    import llm_price_monitor.popularity as popularity

    _use_pool(monkeypatch, nodes=("nodeA",))
    monkeypatch.setattr(popularity, "SW_WINDOW_BUDGET", 1)
    sw = pop.SimilarWebClient("test/1.0")
    calls: list[str] = []

    def ok_get(url, **kwargs):
        calls.append(url)
        return httpx.Response(200, json={"overview": {"visitsTotalCount": 5.0}})

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(popularity.httpx, "get", ok_get)
        assert sw.visits_with_retry("a.test", "a").visits == 5  # 用掉本窗口唯一预算
        result = sw.visits_with_retry("b.test", "b")  # 预算用尽：直接停手
    assert result.kind == "blocked" and len(calls) == 1

    # 两个出口都撞上封锁：各打一次就停手（不把出口打穿）
    _use_pool(monkeypatch, nodes=("nodeA", "nodeB"), current="nodeA")
    monkeypatch.setattr(popularity, "SW_WINDOW_BUDGET", 6)
    sw2 = pop.SimilarWebClient("test/1.0")
    blocked_calls: list[str] = []

    def blocked_get(url, **kwargs):
        blocked_calls.append(url)
        return httpx.Response(202, text="")

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(popularity.httpx, "get", blocked_get)
        result = sw2.visits_with_retry("a.test", "a")
    assert result.kind == "blocked" and len(blocked_calls) == 2


# ---------- collect_site 来源与容错 ----------


def _status_payload(chat_link: str) -> dict:
    return {"success": True, "data": {"chat_link": chat_link, "system_name": "Demo"}}


def test_collect_site_scans_status_payload_and_homepage(monkeypatch):
    monkeypatch.setattr(pop, "TRANCO_INTERVAL_SECONDS", 0)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/status":
            return httpx.Response(200, json=_status_payload("https://t.me/demo_group"))
        if request.url.host == "t.me":
            return httpx.Response(200, text='<div class="tgme_page_extra">321 members, 12 online</div>')
        if request.url.host == "tranco-list.eu":
            return httpx.Response(200, json={"ranks": [{"rank": 88888}]})
        if request.url.host == "hypestat.com":
            return httpx.Response(200, text="Monthly Visits 12.5K")
        return httpx.Response(200, text="<html><footer>QQ群：12345678</footer></html>")

    with _client(handler) as client:
        payload = collect_site(_spec(), client)
    assert payload is not None
    assert payload["groups"] == [
        {
            "type": "telegram",
            "url": "https://t.me/demo_group",
            "label": "@demo_group",
            "members": 321,
            "members_kind": "members",
            "online": 12,
        },
        {"type": "qq", "url": "", "label": "QQ 群 12345678"},
    ]
    assert {key: payload["traffic"][key] for key in ("rank", "rank_source", "monthly_visits", "visits_source")} == {
        "rank": 88888,
        "rank_source": "tranco",
        "monthly_visits": 12_500,
        "visits_source": "hypestat",
    }
    # 两个外部源都记了结论时间（复盘查期用）
    assert payload["traffic"]["rank_checked_at"] > 0 and payload["traffic"]["visits_checked_at"] > 0
    assert payload["checked_at"] > 0


def test_collect_site_falls_back_to_notice_text(monkeypatch):
    """站点接口与首页都打不开时，已存公告里的群号仍能写库；公告也没有才返回 None。"""
    monkeypatch.setattr(pop, "TRANCO_INTERVAL_SECONDS", 0)

    def dead(request: httpx.Request) -> httpx.Response:
        if request.url.host in {"tranco-list.eu", "hypestat.com"}:
            return httpx.Response(404)
        return httpx.Response(404)

    with _client(dead) as client:
        payload = collect_site(_spec(), client, notice_text="新用户加群领福利 👉QQ群：726213516")
        assert payload is not None and payload["groups"][0]["label"] == "QQ 群 726213516"
        assert payload["traffic"] == {}
        assert collect_site(_spec(), client) is None


def test_site_host_prefers_homepage_and_skips_ip():
    assert site_host(_spec("a", "https://api.demo.test/v1/pricing")) == "api.demo.test"
    assert site_host(_spec("a", "https://api.demo.test/v1", homepage="https://www.demo.test/")) == "demo.test"
    assert site_host(_spec("a", "http://134.175.71.62/api/pricing")) == ""


# ---------- 写库合并与清理 ----------


def test_record_popularity_merges_and_keeps_old_on_partial(tmp_path):
    store = Store(tmp_path / "monitor.db")
    record_popularity(
        store,
        "demo",
        {
            "groups": [
                {"type": "telegram", "url": "https://t.me/demo", "label": "@demo", "members": 100, "online": 3}
            ],
            "traffic": {"rank": 1000, "rank_source": "tranco", "monthly_visits": 5000, "visits_source": "hypestat"},
            "checked_at": 1.0,
        },
    )
    # 第二轮：t.me 没抓到人数、访问量源挂了，旧值按字段保留；排名更新
    record_popularity(
        store,
        "demo",
        {
            "groups": [{"type": "telegram", "url": "https://t.me/demo", "label": "@demo"}],
            "traffic": {"rank": 900, "rank_source": "tranco"},
            "checked_at": 2.0,
        },
    )
    entry = store.get_document(POPULARITY_DOC)["demo"]
    assert entry["groups"][0]["members"] == 100 and entry["groups"][0]["online"] == 3
    assert entry["traffic"]["rank"] == 900
    assert entry["traffic"]["monthly_visits"] == 5000 and entry["traffic"]["visits_source"] == "hypestat"
    assert entry["checked_at"] == 2.0
    # 站方摘了群（来源成功、采到空列表）：群列表被清空而不是保留旧值
    record_popularity(store, "demo", {"groups": [], "traffic": {}, "checked_at": 3.0})
    assert store.get_document(POPULARITY_DOC)["demo"]["groups"] == []
    # 其他站不受影响
    record_popularity(store, "other", {"groups": [], "traffic": {}, "checked_at": 1.0})
    assert set(store.get_document(POPULARITY_DOC)) == {"demo", "other"}
    remove_popularity(store, "demo")
    assert set(store.get_document(POPULARITY_DOC)) == {"other"}


# ---------- 外部源复查策略 ----------


def test_needs_query_settles_sources_separately():
    """两个外部源各自结算：有值 7 天复查、确认没数据 30 天复查；任一没结算就值得查。"""
    now = time.time()
    fresh = now - 86_400  # 1 天前
    stale = now - 8 * 86_400  # 8 天前（超过有值复查期）
    expired = now - 40 * 86_400  # 40 天前（超过无数据复查期）
    complete = {
        "traffic": {
            "monthly_visits": 100,
            "visits_source": "similarweb",
            "visits_checked_at": fresh,
            "rank": 500_000,
            "rank_source": "tranco",
            "rank_checked_at": fresh,
        },
        "checked_at": fresh,
    }
    assert pop.needs_query(None) is True
    assert pop.needs_query(complete) is False  # 两个源都有值且没到复查期：跳过
    aged = {**complete, "traffic": {**complete["traffic"], "visits_checked_at": stale}}
    assert pop.needs_query(aged) is True  # 访问量到复查期：只补这一源
    # 上游确认过没数据（没有值但记了结论时间）：一个月内不白跑
    settled_empty = {"traffic": {"visits_checked_at": fresh, "rank_checked_at": fresh}, "checked_at": fresh}
    assert pop.needs_query(settled_empty) is False
    expired_empty = {"traffic": {"visits_checked_at": expired, "rank_checked_at": expired}, "checked_at": expired}
    assert pop.needs_query(expired_empty) is True  # 复查期过了：再确认一次
    # 缺一个源的结论（比如只有访问量、排名还没查过）：照查
    assert pop.needs_query({"traffic": {"monthly_visits": 100, "visits_checked_at": fresh}, "checked_at": fresh}) is True


def test_collect_site_rechecks_each_source_on_its_own_schedule(monkeypatch):
    """collect_site：两个源都新鲜时不打外部；某一源到复查期只打那一源；force 全打。"""
    monkeypatch.setattr(pop, "TRANCO_INTERVAL_SECONDS", 0)
    now = time.time()
    counts = {"tranco": 0, "hypestat": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "tranco-list.eu":
            counts["tranco"] += 1
            return httpx.Response(200, json={"ranks": [{"rank": 12345}]})
        if request.url.host == "hypestat.com":
            counts["hypestat"] += 1
            return httpx.Response(404)
        return httpx.Response(200, text="<footer>t.me/again</footer>")

    current = {
        "traffic": {
            "monthly_visits": 100,
            "visits_source": "similarweb",
            "visits_checked_at": now,
            "rank": 500_000,
            "rank_source": "tranco",
            "rank_checked_at": now,
        },
        "checked_at": now,
    }
    with _client(handler) as client:
        # 两个源都在复查期内：一个外部请求都不打（payload 不带 traffic，合并时保留旧值）
        payload = collect_site(_spec(), client, previous=current)
        assert payload is not None and payload["traffic"] == {}
        assert counts == {"tranco": 0, "hypestat": 0}
        # 访问量到复查期：只打访问量源（SimilarWeb 没接 → hypestat），Tranco 不动
        aged = {**current, "traffic": {**current["traffic"], "visits_checked_at": now - 8 * 86_400}}
        payload = collect_site(_spec(), client, previous=aged)
        assert counts == {"tranco": 0, "hypestat": 1}
        # force：两个源都重查
        payload = collect_site(_spec(), client, previous=current, force=True)
        assert counts == {"tranco": 1, "hypestat": 2}
        assert payload is not None and payload["traffic"]["rank"] == 12345


def test_scan_order_pending_first():
    """采集顺序：待补站在前（与管理页一致），其余按上次取数新→旧。"""
    now = time.time()
    specs = [
        _spec("old", "https://old.test/api"),
        _spec("new", "https://new.test/api"),
        _spec("pending", "https://p.test/api"),
    ]
    settled = {"monthly_visits": 10, "visits_checked_at": now, "rank": 1, "rank_checked_at": now}
    doc = {
        "old": {"traffic": dict(settled), "checked_at": now - 3 * 86_400},
        "new": {"traffic": dict(settled), "checked_at": now - 86_400},
        "pending": {"traffic": {}, "checked_at": now},
    }
    assert [spec.id for spec in pop.scan_order(specs, doc)] == ["pending", "new", "old"]


# ---------- 接口与调度接线 ----------


def _config(tmp_path: Path) -> Path:
    """最小种子配置：调度全关，不会真去采集。"""
    config_path = tmp_path / "config.json"
    config_path.write_text(
        '{"settings": {"schedule": {"price": 0, "status": 0, "notice": 0, "catalog": 0, '
        '"rankings": 0, "discovery": 0, "screenshot": 0, "popularity": 0}, "monitor_models": ["demo-model"]}, '
        '"ai": {}, "sites": [{"id": "demo", "network": {"url": "https://demo.test/api/pricing"}}]}',
        encoding="utf-8",
    )
    return config_path


@pytest.fixture
def workspace(tmp_path: Path, monkeypatch) -> Path:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "var").mkdir()
    return tmp_path


def _app(workspace: Path):
    return create_app(_config(workspace))


def test_popularity_endpoint_public_and_under_read_lockdown(workspace: Path, monkeypatch):
    """人气数据是详情页公开内容：匿名可读，生产读接口封锁下也不 401。"""
    monkeypatch.setenv("PRICE_WEB_INTERNAL_TOKEN", "secret-token")
    app = _app(workspace)
    client = TestClient(app)
    assert client.get("/api/sites/popularity").json() == {"popularity": {}}

    record_popularity(app.state.store, "demo", {"groups": [], "traffic": {"rank": 5}, "checked_at": 1.0})
    response = client.get("/api/sites/popularity")
    assert response.status_code == 200
    assert response.json()["popularity"]["demo"]["traffic"]["rank"] == 5
    # 同前缀的管理接口照旧封锁
    assert client.get("/api/sites").status_code == 401


def test_popularity_admin_orders_pending_first_and_flags_no_data(workspace: Path):
    """管理页：待补在前（与采集顺序一致）；上游确认没数据的站标 no_data、不再算待补。"""
    client = TestClient(_app(workspace))
    assert client.post("/api/setup", json={"username": "admin", "password": "s3cret"}).status_code == 200
    assert client.post("/api/sites", json={"config": {"id": "second", "network": {"url": "https://second.test/api"}}}).status_code == 200
    store = client.app.state.store
    now = time.time()
    # demo：两个源都确认过没数据（结论新鲜）→ 无数据、不待补
    record_popularity(store, "demo", {"groups": [], "traffic": {"visits_checked_at": now, "rank_checked_at": now}, "checked_at": now})
    # second：有数据但访问量到复查期 → 待补
    record_popularity(
        store,
        "second",
        {
            "groups": [],
            "traffic": {
                "monthly_visits": 9,
                "visits_source": "similarweb",
                "visits_checked_at": now - 8 * 86_400,
                "rank": 5,
                "rank_source": "tranco",
                "rank_checked_at": now,
            },
            "checked_at": now,
        },
    )
    data = client.get("/api/sites/popularity/admin").json()
    assert [row["site_id"] for row in data["rows"]] == ["second", "demo"]
    assert [row["needs_query"] for row in data["rows"]] == [True, False]
    assert [row["no_data"] for row in data["rows"]] == [False, True]
    assert data["pending"] == 1


def test_manual_collect_endpoint_uses_popularity_job(workspace: Path, monkeypatch):
    """手动触发走人气任务体，结果进任务记录；force=全量刷新透传给任务体。"""
    import llm_price_monitor.webapi.routes.collect as collect_routes

    captured: dict[str, bool] = {}

    def fake_job(config, store, *, force=False):
        captured["force"] = force
        return lambda: {"sites": 1, "groups": 2, "visits": 1, "ranked": 1, "failed": 0, "skipped": 0}

    monkeypatch.setattr(collect_routes, "popularity_scan_job", fake_job)
    client = TestClient(_app(workspace))
    assert client.post("/api/setup", json={"username": "admin", "password": "s3cret"}).status_code == 200
    submitted = client.post("/api/collect/popularity", json={})
    assert submitted.status_code == 200, submitted.text
    task_id = submitted.json()["task_id"]
    for _ in range(50):
        task = client.get(f"/api/tasks/{task_id}").json()
        if task["status"] != "running":
            break
        time.sleep(0.05)
    assert task["kind"] == "collect-popularity" and task["status"] == "done"
    assert task["result"]["groups"] == 2
    assert captured["force"] is False
    # force=true 全量刷新
    submitted = client.post("/api/collect/popularity", json={"force": True})
    task_id = submitted.json()["task_id"]
    for _ in range(50):
        task = client.get(f"/api/tasks/{task_id}").json()
        if task["status"] != "running":
            break
        time.sleep(0.05)
    assert captured["force"] is True


def test_purge_and_rename_move_popularity(workspace: Path):
    """普通删除保留人气记录；站点改名跟着走；purge 清掉。"""
    client = TestClient(_app(workspace))
    assert client.post("/api/setup", json={"username": "admin", "password": "s3cret"}).status_code == 200
    store = client.app.state.store
    record_popularity(store, "demo", {"groups": [], "traffic": {"rank": 7}, "checked_at": 1.0})

    assert client.delete("/api/sites/demo").status_code == 200
    assert store.get_document(POPULARITY_DOC)["demo"]["traffic"]["rank"] == 7

    assert client.post("/api/sites", json={"config": {"id": "demo", "network": {"url": "https://demo.test/api"}}}).status_code == 200
    renamed = client.put("/api/sites/demo", json={"config": {"id": "renamed", "network": {"url": "https://demo.test/api"}}})
    assert renamed.status_code == 200, renamed.text
    doc = store.get_document(POPULARITY_DOC)
    assert "demo" not in doc and doc["renamed"]["traffic"]["rank"] == 7

    record_popularity(store, "other", {"groups": [], "traffic": {}, "checked_at": 1.0})
    assert client.delete("/api/sites/renamed", params={"purge": "true"}).status_code == 200
    doc = store.get_document(POPULARITY_DOC)
    assert "renamed" not in doc and "other" in doc


def test_scan_popularity_records_and_isolates_failures(tmp_path, monkeypatch):
    """整轮采集：成功的站写库，失败的站保留旧数据并计数，单站异常不打断。"""
    import llm_price_monitor.popularity as popularity

    monkeypatch.setattr(pop, "TRANCO_INTERVAL_SECONDS", 0)
    # 不真发外部请求：SimilarWeb 轻客户端直连一律当作被拒（测试环境没有出口池）
    monkeypatch.setattr(popularity.egress, "effective_proxy", lambda: None)
    monkeypatch.setattr(popularity.httpx, "get", lambda url, **kw: httpx.Response(403, text="blocked"))
    store = Store(tmp_path / "monitor.db")
    record_popularity(store, "bad", {"groups": [], "traffic": {"rank": 1}, "checked_at": 1.0})

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "ok.test":
            return httpx.Response(200, text="<footer>t.me/ok_group</footer>")
        if request.url.host == "t.me":
            return httpx.Response(200, text='<div class="tgme_page_extra">12 members</div>')
        if request.url.host in {"tranco-list.eu", "hypestat.com"}:
            return httpx.Response(404)
        return httpx.Response(500)

    config = _Config([_spec("ok", "https://ok.test/api/pricing"), _spec("bad", "https://bad.test/api/pricing")])
    with _client(handler) as client:
        summary = pop.scan_popularity(config, store, client=client)
    # ranked 按「本轮结束时库里有排名的站」统计（bad 保留的旧排名算数）；没有出口池就不补采
    assert summary == {"sites": 2, "groups": 1, "visits": 0, "ranked": 1, "failed": 1, "skipped": 0, "topped_up": 0}
    doc = store.get_document(POPULARITY_DOC)
    assert doc["ok"]["groups"][0]["members"] == 12
    assert doc["bad"]["traffic"]["rank"] == 1 and doc["bad"]["checked_at"] == 1.0  # 失败保留旧数据


def test_topup_pending_waits_for_budget_then_fills(tmp_path, monkeypatch):
    """补采：等出口额度回补（sleep 到回补点）把没结论的站补完，拿到结论的站出列。"""
    import llm_price_monitor.popularity as popularity

    monkeypatch.setattr(pop, "TRANCO_INTERVAL_SECONDS", 0)
    # 只换掉 popularity 模块里的 time（别动全局 time 模块，免得影响其他测试的线程）
    import types

    slept: list[float] = []
    monkeypatch.setattr(popularity, "time", types.SimpleNamespace(time=time.time, sleep=slept.append))
    # Tranco 直接给结论（明确没收录），让排名先结算，只剩访问量待补
    monkeypatch.setattr(popularity, "fetch_tranco_rank", lambda host, client: popularity.RankResult(None, True))

    class FakeClient:
        """假出口池客户端：第一次没额度要等 30 秒，之后先被限流一次再成功。"""

        def __init__(self) -> None:
            self.waits = [30.0, 0.0]
            self.calls = 0

        def seconds_until_budget(self, **kwargs):
            return self.waits.pop(0) if self.waits else 0.0

        def visits_with_retry(self, domain, host_label):
            self.calls += 1
            if self.calls == 1:
                return popularity.TrafficResult("blocked")
            return popularity.TrafficResult("ok", 1234)

    store = Store(tmp_path / "monitor.db")
    record_popularity(store, "demo", {"groups": [{"type": "qq", "url": "", "label": "QQ 群 1"}], "traffic": {}, "checked_at": 1.0})
    config = _Config([_spec("demo", "https://demo.test/api/pricing")])
    stats = {"sites": 1, "groups": 0, "visits": 0, "ranked": 0, "failed": 0, "skipped": 0, "topped_up": 0}
    with _client(lambda request: httpx.Response(404)) as client:
        popularity.topup_pending(store, config, FakeClient(), client, stats)
    entry = store.get_document(POPULARITY_DOC)["demo"]
    assert entry["traffic"]["monthly_visits"] == 1234
    assert entry["traffic"]["rank_checked_at"] > 0  # Tranco 明确没收录也算结论
    assert entry["traffic"]["visits_source"] == "similarweb"
    assert entry["checked_at"] == 1.0  # 补采不动站点侧取数时间
    assert entry["groups"][0]["label"] == "QQ 群 1"  # 也不动群链接
    assert stats["topped_up"] == 2  # 两轮各写入一条新结论（先排名、后访问量）
    assert slept[0] == 31.0  # 第一次等窗口回补（+1 秒余量）
    assert all(seconds == 0 for seconds in slept[1:])  # 其余是 Tranco 的间隔 sleep（测试压到 0）


def test_pending_traffic_counts_unfinished_force_round(tmp_path):
    """全量刷新轮里旧值还在复查期、但本轮没轮到：也算欠着（补采要接手）。"""
    now = time.time()
    store = Store(tmp_path / "monitor.db")
    record_popularity(
        store,
        "demo",
        {
            "groups": [],
            "traffic": {
                "monthly_visits": 100,
                "visits_source": "similarweb",
                "visits_checked_at": now,
                "rank": 5,
                "rank_source": "tranco",
                "rank_checked_at": now,
            },
            "checked_at": now,
        },
    )
    config = _Config([_spec("demo", "https://demo.test/api/pricing")])
    assert pop.pending_traffic(store, config) == []  # 按复查期现算：都新鲜，不欠
    due = {"demo": (True, True)}  # force 轮：两个源都该查
    pending = pop.pending_traffic(store, config, since=now + 1, due=due)  # 本轮啥都没结算
    assert [spec.id for spec, _traffic in pending] == ["demo"]
    # 本轮结算过（结论时间晚于轮次开始）就不欠
    assert pop.pending_traffic(store, config, since=now - 1, due=due) == []
    # 没有可查域名的站不进补采
    ip_spec = _spec("iponly", "http://134.175.71.62/api/pricing")
    assert pop.pending_traffic(store, _Config([ip_spec]), since=now + 1, due={"iponly": (True, True)}) == []


def test_write_with_retry_tolerates_locked_db(monkeypatch):
    """写库被别的进程占住（database is locked）重试几次；别的数据库错误照抛。"""
    import sqlite3
    import types

    import llm_price_monitor.popularity as popularity

    slept: list[float] = []
    monkeypatch.setattr(popularity, "time", types.SimpleNamespace(time=time.time, sleep=slept.append))
    calls = {"n": 0}

    def flaky() -> None:
        calls["n"] += 1
        if calls["n"] < 3:
            raise sqlite3.OperationalError("database is locked")

    assert popularity._write_with_retry(flaky) is True
    assert calls["n"] == 3 and slept == [1.5, 3.0]

    def always_locked() -> None:
        raise sqlite3.OperationalError("database is locked")

    assert popularity._write_with_retry(always_locked, attempts=2) is False

    def broken_schema() -> None:
        raise sqlite3.OperationalError("no such table: documents")

    with pytest.raises(sqlite3.OperationalError):
        popularity._write_with_retry(broken_schema)


def test_scheduler_registers_popularity_key():
    """调度表接线：popularity 键 → collect-popularity 任务体。"""
    from llm_price_monitor.config import DEFAULT_SCHEDULE_MINUTES, SCHEDULE_KEYS
    from llm_price_monitor.webapi.scheduler import _KIND_BY_KEY

    assert "popularity" in SCHEDULE_KEYS
    assert DEFAULT_SCHEDULE_MINUTES["popularity"] == 1440
    assert _KIND_BY_KEY["popularity"] == "collect-popularity"
