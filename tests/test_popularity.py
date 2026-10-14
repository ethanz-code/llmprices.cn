"""站点人气：群链接/群号提取、Telegram 人数与访问量/排名解析、落库合并、接口与清理。

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
    # 频道口径是 subscribers：展示文案要叫「频道」而不是「群」
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
    payload = {"ranks": [{"date": "2026-10-13", "rank": 461591}]}
    with _client(lambda request: httpx.Response(200, json=payload)) as client:
        assert fetch_tranco_rank("302.ai", client) == 461591
    with _client(lambda request: httpx.Response(429)) as client:
        assert fetch_tranco_rank("302.ai", client) is None
    with _client(lambda request: httpx.Response(200, json={"ranks": []})) as client:
        assert fetch_tranco_rank("tokenage.ai", client) is None


def test_fetch_visits_estimate_parses_scale_and_handles_missing():
    page = "<div>Monthly Visits</div><div>134.7K</div>"
    with _client(lambda request: httpx.Response(200, text=page)) as client:
        assert fetch_visits_estimate("302.ai", client) == 134_700
    empty = "<div>Monthly Visits</div><div>数据不足</div>"
    with _client(lambda request: httpx.Response(200, text=empty)) as client:
        assert fetch_visits_estimate("cun.ai", client) is None


# ---------- SimilarWeb 站内 API 客户端 ----------


def test_similarweb_client_parses_visits_and_rank(monkeypatch):
    payload = {
        "overview": {"visitsTotalCount": 66918.0},
        "ranking": {"globalRankHistory": [
            {"date": "2026-07-01T00:00:00+00:00", "rank": 0},
            {"date": "2026-09-01T00:00:00+00:00", "rank": 760479},
        ]},
    }
    sw = pop.SimilarWebClient("test/1.0")
    import llm_price_monitor.popularity as popularity

    monkeypatch.setattr(popularity.egress, "effective_proxy", lambda: None)

    def fake_get(url, **kwargs):
        assert "similarweb.com/api/website/302.ai" in url
        assert kwargs["cookies"] == {"aws-waf-token": ""}
        return httpx.Response(200, json=payload)

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(popularity.httpx, "get", fake_get)
        result = sw.fetch("302.ai")
    assert result == {"monthly_visits": 66918, "global_rank": 760479}


def test_similarweb_client_maps_blocked_and_nodata_to_none(monkeypatch):
    """出口状态码语义：202/403=被拦（试下一个出口）、204=上游没数据、0 访问量不算数。"""
    import llm_price_monitor.popularity as popularity

    # 测试环境没有代理配置：代理腿被跳过，只有直连腿
    monkeypatch.setattr(popularity.egress, "effective_proxy", lambda: None)
    sw = pop.SimilarWebClient("test/1.0")
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(popularity.httpx, "get", lambda url, **kw: httpx.Response(202, text=""))
        assert sw.fetch("a.test") is None  # WAF 质询 → None（可换出口重试）
        mp.setattr(popularity.httpx, "get", lambda url, **kw: httpx.Response(403, text="blocked"))
        assert sw.fetch("a.test") is None
        mp.setattr(popularity.httpx, "get", lambda url, **kw: httpx.Response(204, text=""))
        assert sw.fetch("a.test") is None  # 上游明确没数据
        # visits=0 或缺失：返回 None 而不是把 0 当数据
        mp.setattr(popularity.httpx, "get", lambda url, **kw: httpx.Response(200, json={"overview": {"visitsTotalCount": 0.0}}))
        assert sw.fetch("a.test") is None


def test_similarweb_client_prefers_proxy_then_direct(monkeypatch):
    """出口顺序：SimilarWeb 拒数据中心/本机 IP，代理腿优先、直连兜底（与采集链路镜像）。"""
    import llm_price_monitor.popularity as popularity

    monkeypatch.setattr(popularity.egress, "effective_proxy", lambda: "http://proxy:9090")
    sw = pop.SimilarWebClient("test/1.0")
    legs: list[str] = []

    def fake_get(url, **kwargs):
        legs.append(kwargs.get("proxy") or "direct")
        if kwargs.get("proxy"):
            return httpx.Response(403, text="blocked")  # 代理腿被拉黑
        return httpx.Response(200, json={"overview": {"visitsTotalCount": 12.0}})

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(popularity.httpx, "get", fake_get)
        assert sw.fetch("a.test") == {"monthly_visits": 12}
    assert legs == ["http://proxy:9090", "direct"]


def test_similarweb_visits_with_retry_switches_node(monkeypatch):
    """首击被 WAF 拦下：配了节点切换就换节点重试一次；明确无数据不重试。"""
    import llm_price_monitor.popularity as popularity

    sw = pop.SimilarWebClient("test/1.0")
    calls: list[str] = []

    def fake_fetch(domain):
        calls.append(domain)
        return None if len(calls) == 1 else {"monthly_visits": 137980}

    monkeypatch.setattr(sw, "fetch", fake_fetch)
    monkeypatch.setattr(popularity.proxy_switch, "auto_switch_for", lambda host, url: "🇭🇰香港高速03")
    assert sw.visits_with_retry("cun.ai", "cun") == 137980
    assert len(calls) == 2

    # 无数据（fetch 返回 {}）不换节点
    calls.clear()
    monkeypatch.setattr(sw, "fetch", lambda domain: calls.append(domain) or {})
    assert sw.visits_with_retry("tokenage.ai", "tokenage") is None
    assert len(calls) == 1

    # 没配节点切换：一次失败即放弃
    calls.clear()
    monkeypatch.setattr(popularity.proxy_switch, "auto_switch_for", lambda host, url: None)
    monkeypatch.setattr(sw, "fetch", lambda domain: calls.append(domain) or None)
    assert sw.visits_with_retry("cun.ai", "cun") is None
    assert len(calls) == 1


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
    assert payload["traffic"] == {
        "rank": 88888,
        "rank_source": "tranco",
        "monthly_visits": 12_500,
        "visits_source": "hypestat",
    }
    assert payload["checked_at"] > 0


def test_collect_site_falls_back_to_notice_text(monkeypatch):
    """站点接口与首页都打不开时，已存公告里的群号仍能落库；公告也没有才返回 None。"""
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


# ---------- 落库合并与清理 ----------


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


# ---------- 新鲜跳过策略 ----------


def test_needs_query_and_fresh_skip(monkeypatch):
    """访问量+排名齐全且 7 天内采过 → 跳过外部查询（省额度）；缺任一就照查；force 无视新鲜。"""
    fresh = time.time() - 86_400  # 1 天前
    stale = time.time() - 8 * 86_400  # 8 天前
    complete = {"groups": [], "traffic": {"monthly_visits": 100, "visits_source": "similarweb", "rank": 500_000}, "checked_at": fresh}
    missing_rank = {"groups": [], "traffic": {"monthly_visits": 100}, "checked_at": fresh}
    assert pop.needs_query(None) is True
    assert pop.needs_query(complete) is False  # 齐全且新鲜：跳过
    assert pop.needs_query(missing_rank) is True  # 缺排名：照查（自动补齐）
    assert pop.needs_query({**complete, "checked_at": stale}) is True  # 数据变旧：照查刷新
    # collect_site 层：skip 时沿用旧 traffic、不 sleep 不查外部
    monkeypatch.setattr(pop, "TRANCO_INTERVAL_SECONDS", 99)
    called = {"external": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        called["external"] += 1
        return httpx.Response(200, text="<footer>t.me/again</footer>")

    with _client(handler) as client:
        payload = collect_site(_spec(), client, previous=complete)
        assert payload is not None
        assert payload["traffic"]["monthly_visits"] == 100 and payload["traffic"]["rank"] == 500_000
        # skip 分支只打站点自身三处（/api/status、首页、t.me），Tranco/SimilarWeb/hypestat 都没打
        assert called["external"] == 3
        before = called["external"]
        payload = collect_site(_spec(), client, previous=complete, force=True)
        assert called["external"] > before  # force：外部源照查（Tranco/hypestat）


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
    """整轮采集：成功的站落库，失败的站保留旧数据并计数，单站异常不打断。"""
    monkeypatch.setattr(pop, "TRANCO_INTERVAL_SECONDS", 0)
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
    assert summary == {"sites": 2, "groups": 1, "visits": 0, "ranked": 0, "failed": 1, "skipped": 0}
    doc = store.get_document(POPULARITY_DOC)
    assert doc["ok"]["groups"][0]["members"] == 12
    assert doc["bad"]["traffic"]["rank"] == 1 and doc["bad"]["checked_at"] == 1.0  # 失败保留旧数据


def test_scheduler_registers_popularity_key():
    """调度表接线：popularity 键 → collect-popularity 任务体。"""
    from llm_price_monitor.config import DEFAULT_SCHEDULE_MINUTES, SCHEDULE_KEYS
    from llm_price_monitor.webapi.scheduler import _KIND_BY_KEY

    assert "popularity" in SCHEDULE_KEYS
    assert DEFAULT_SCHEDULE_MINUTES["popularity"] == 1440
    assert _KIND_BY_KEY["popularity"] == "collect-popularity"
