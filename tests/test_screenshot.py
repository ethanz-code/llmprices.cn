"""站点截图：地址推导、落盘与元数据、失败保留旧图、读取接口与删站清理。

不真启动浏览器：capture_screenshot 全部用 monkeypatch 替身。
"""
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from llm_price_monitor.config import ModelTarget, PriceMonitorError, sites_from_raw
from llm_price_monitor.screenshot import (
    SCREENSHOT_DOC,
    record_screenshot,
    remove_screenshot,
    scan_screenshots,
    screenshot_path,
    site_homepage,
)
from llm_price_monitor.store import Store
from llm_price_monitor.webapi.app import create_app


def _spec(site_id: str, url: str | None, *, enabled: bool = True):
    (spec,) = sites_from_raw(
        [{"id": site_id, "enabled": enabled, "network": {"url": url} if url else {}}],
        models=(ModelTarget("gpt-5.6-luna"),),
    )
    return spec


class _Config:
    def __init__(self, specs):
        self.sites = tuple(specs)


def test_site_homepage_derives_origin_root():
    assert site_homepage(_spec("a", "https://a.test/api/pricing?x=1")) == "https://a.test/"
    assert site_homepage(_spec("a", "http://b.test:8080/v1")) == "http://b.test:8080/"
    # 没有采集地址的站，没有可截的首页
    assert site_homepage(_spec("a", None)) is None


def test_site_homepage_rejects_non_http_url():
    """采集地址不是网页时（配置校验层会拦，这里兜底）不产出截图地址。"""
    from llm_price_monitor.config import SiteSpec

    spec = SiteSpec(id="a", network={"url": "ftp://a.test/x"})
    assert site_homepage(spec) is None


def test_site_homepage_prefers_configured_field():
    """配置了站点首页就用它（4aicode 这类入口在 API 子域的站），没配才按采集地址推导。"""
    configured = _spec_with_homepage("a", "https://api.a.test/api/billing/rates", "https://a.test/")
    assert site_homepage(configured) == "https://a.test/"
    # 只有 homepage、完全没有采集地址也能出图（占位站除外）
    (only_homepage,) = sites_from_raw(
        [{"id": "b", "homepage": "https://b.test/"}], models=(ModelTarget("gpt-5.6-luna"),)
    )
    assert site_homepage(only_homepage) == "https://b.test/"


def _spec_with_homepage(site_id: str, url: str, homepage: str):
    (spec,) = sites_from_raw(
        [{"id": site_id, "homepage": homepage, "network": {"url": url}}],
        models=(ModelTarget("gpt-5.6-luna"),),
    )
    return spec


def test_site_homepage_field_validation():
    """homepage 必须是非空 http(s) URL；空白值、相对地址、非字符串都拒。"""
    for bad in ("notaurl", "", "  ", "/relative", 123):
        with pytest.raises(ValueError, match="homepage"):
            sites_from_raw([{"id": "a", "homepage": bad}], models=())
    # 前后空白自动去掉
    (spec,) = sites_from_raw([{"id": "a", "homepage": " https://a.test/ "}], models=())
    assert spec.homepage == "https://a.test/"


def test_screenshot_path_rejects_unsafe_site_id(tmp_path, monkeypatch):
    monkeypatch.setattr("llm_price_monitor.screenshot.SCREENSHOT_DIR", tmp_path)
    assert screenshot_path("demo-1") == tmp_path / "demo-1.png"
    with pytest.raises(PriceMonitorError):
        screenshot_path("../etc/passwd")


def test_scan_records_metadata_and_isolates_failures(tmp_path, monkeypatch):
    """成功的站记元数据；失败的站保留上一张且不改元数据；单站失败不打断整轮。"""
    monkeypatch.setattr("llm_price_monitor.screenshot.SCREENSHOT_DIR", tmp_path)
    store = Store(tmp_path / "monitor.db")
    record_screenshot(store, "bad", url="https://bad.test/", captured_at=1.0, size=3)
    (tmp_path / "bad.png").write_bytes(b"old")

    def fake_capture(url, dest, *, user_agent=None):
        if "bad" in url:
            raise PriceMonitorError("页面打不开")
        dest.write_bytes(b"png-bytes")
        return len(b"png-bytes")

    monkeypatch.setattr("llm_price_monitor.screenshot.capture_screenshot", fake_capture)
    config = _Config([
        _spec("ok", "https://ok.test/api/pricing"),
        _spec("bad", "https://bad.test/v1/models"),
        _spec("nourl", None),
        _spec("off", "https://off.test/api", enabled=False),
    ])
    summary = scan_screenshots(config, store, user_agent="TestUA")

    assert summary == {"captured": 1, "skipped": 1, "failed": 1}
    doc = store.get_document(SCREENSHOT_DOC)
    assert doc["ok"]["url"] == "https://ok.test/" and doc["ok"]["bytes"] == len(b"png-bytes")
    assert doc["ok"]["captured_at"] > 1
    assert doc["bad"] == {"url": "https://bad.test/", "captured_at": 1.0, "bytes": 3}  # 失败不覆盖
    assert (tmp_path / "bad.png").read_bytes() == b"old"
    assert "off" not in doc and "nourl" not in doc


def _config(tmp_path: Path) -> Path:
    """最小种子配置：调度全关，不会真去采集。"""
    config_path = tmp_path / "config.json"
    config_path.write_text(
        '{"settings": {"schedule": {"price": 0, "status": 0, "notice": 0, "catalog": 0, '
        '"rankings": 0, "discovery": 0, "screenshot": 0}, "monitor_models": ["demo-model"]}, '
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


def test_screenshot_api_serves_image_and_404_without(workspace: Path, monkeypatch):
    """有元数据且文件在时返回 PNG；没截过、或文件丢了，都是 404。匿名可读（详情页公开内容）。"""
    import llm_price_monitor.screenshot as shots

    monkeypatch.setattr(shots, "SCREENSHOT_DIR", workspace / "var" / "screenshots")
    app = _app(workspace)
    client = TestClient(app)
    assert client.get("/api/sites/demo/screenshot").status_code == 404
    assert client.get("/api/sites/screenshots").json() == {"screenshots": {}}

    record_screenshot(app.state.store, "demo", url="https://demo.test/", captured_at=time.time(), size=4)
    path = shots.screenshot_path("demo")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\x89PNG")

    listing = client.get("/api/sites/screenshots")
    assert listing.status_code == 200 and listing.json()["screenshots"]["demo"]["bytes"] == 4
    image = client.get("/api/sites/demo/screenshot")
    assert image.status_code == 200 and image.headers["content-type"] == "image/png"
    assert image.content == b"\x89PNG"

    path.unlink()
    assert client.get("/api/sites/demo/screenshot").status_code == 404


def test_screenshot_api_public_under_read_lockdown(workspace: Path, monkeypatch):
    """生产读接口封锁下，截图元数据与图片仍对匿名访客开放（浏览器 img 直链拿不到内网令牌）。"""
    import llm_price_monitor.screenshot as shots

    monkeypatch.setattr(shots, "SCREENSHOT_DIR", workspace / "var" / "screenshots")
    monkeypatch.setenv("PRICE_WEB_INTERNAL_TOKEN", "secret-token")
    app = _app(workspace)
    record_screenshot(app.state.store, "demo", url="https://demo.test/", captured_at=1.0, size=4)
    path = shots.screenshot_path("demo")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\x89PNG")

    client = TestClient(app)
    assert client.get("/api/sites/screenshots").status_code == 200
    assert client.get("/api/sites/demo/screenshot").status_code == 200
    assert client.get("/api/sites/homepages").status_code == 200
    # 同前缀的管理接口照旧封锁：匿名拿不到站点配置
    assert client.get("/api/sites").status_code == 401


def test_screenshot_thumbnail_endpoint(workspace: Path, monkeypatch):
    """?w= 返回缩过的 JPEG（尺寸/类型/体积都对）；缓存按源图 mtime 失效；坏图回落原图。"""
    import io
    import os as os_mod

    import llm_price_monitor.screenshot as shots
    from PIL import Image

    monkeypatch.setattr(shots, "SCREENSHOT_DIR", workspace / "var" / "screenshots")
    app = _app(workspace)
    store = app.state.store
    client = TestClient(app)
    record_screenshot(store, "demo", url="https://demo.test/", captured_at=1.0, size=0)
    path = shots.screenshot_path("demo")
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (1280, 800), (10, 20, 30)).save(path)  # 造一张真 PNG

    full = client.get("/api/sites/demo/screenshot")
    assert full.headers["content-type"] == "image/png"
    thumb = client.get("/api/sites/demo/screenshot", params={"w": "320"})
    assert thumb.status_code == 200 and thumb.headers["content-type"] == "image/jpeg"
    with Image.open(io.BytesIO(thumb.content)) as img:
        assert img.size == (320, 200)
    assert len(thumb.content) < len(full.content)
    thumbs = list((workspace / "var" / "screenshots" / "thumbs").glob("demo-*-w320.jpg"))
    assert len(thumbs) == 1
    # 超上限宽度被夹回允许范围
    wide = client.get("/api/sites/demo/screenshot", params={"w": "99999"})
    with Image.open(io.BytesIO(wide.content)) as img:
        assert img.size[0] == shots.THUMB_WIDTH_MAX
    # 重新截图（mtime 变化）→ 旧缩略图不再命中并顺手清掉，只留新的一份
    os_mod.utime(path, (path.stat().st_atime + 5, path.stat().st_mtime + 5))
    again = client.get("/api/sites/demo/screenshot", params={"w": "320"})
    assert again.status_code == 200 and again.headers["content-type"] == "image/jpeg"
    thumbs = list((workspace / "var" / "screenshots" / "thumbs").glob("demo-*-w320.jpg"))
    assert len(thumbs) == 1
    # 坏图（不是合法图片）→ 缩略图生成失败回落原图，不 500
    path.write_bytes(b"not-an-image")
    fallback = client.get("/api/sites/demo/screenshot", params={"w": "320"})
    assert fallback.status_code == 200 and fallback.headers["content-type"] == "image/png"


def test_purge_and_rename_move_screenshot(workspace: Path, monkeypatch):
    """普通删除保留截图；站点改名后图片和元数据跟着走；purge 删除两者都清。"""
    import llm_price_monitor.screenshot as shots

    monkeypatch.setattr(shots, "SCREENSHOT_DIR", workspace / "var" / "screenshots")
    client = TestClient(_app(workspace))
    assert client.post("/api/setup", json={"username": "admin", "password": "s3cret"}).status_code == 200
    store = client.app.state.store
    record_screenshot(store, "demo", url="https://demo.test/", captured_at=1.0, size=3)
    shots.screenshot_path("demo").parent.mkdir(parents=True, exist_ok=True)
    shots.screenshot_path("demo").write_bytes(b"img")

    # 普通删除：截图保留
    assert client.delete("/api/sites/demo").status_code == 200
    assert store.get_document(SCREENSHOT_DOC)["demo"]["bytes"] == 3

    # 重建后改名：文件与元数据迁移到新 id
    assert client.post("/api/sites", json={"config": {"id": "demo", "network": {"url": "https://demo.test/api"}}}).status_code == 200
    renamed = client.put("/api/sites/demo", json={"config": {"id": "renamed", "network": {"url": "https://demo.test/api"}}})
    assert renamed.status_code == 200, renamed.text
    assert "demo" not in store.get_document(SCREENSHOT_DOC)
    assert store.get_document(SCREENSHOT_DOC)["renamed"]["url"] == "https://demo.test/"
    assert shots.screenshot_path("renamed").read_bytes() == b"img"
    assert not shots.screenshot_path("demo").exists()

    # purge 删除：元数据与文件都清掉，其他站不受影响
    record_screenshot(store, "other", url="https://other.test/", captured_at=2.0, size=1)
    assert client.delete("/api/sites/renamed", params={"purge": "true"}).status_code == 200
    assert "renamed" not in (store.get_document(SCREENSHOT_DOC) or {})
    assert not shots.screenshot_path("renamed").exists()
    assert store.get_document(SCREENSHOT_DOC)["other"]["bytes"] == 1


def test_homepages_endpoint_lists_configured_sites(workspace: Path):
    """首页覆盖表：只含配过 homepage 的站；公开可读；改配置后即时生效。"""
    client = TestClient(_app(workspace))
    assert client.get("/api/sites/homepages").json() == {"homepages": {}}
    assert client.post("/api/setup", json={"username": "admin", "password": "s3cret"}).status_code == 200
    assert client.post(
        "/api/sites",
        json={"config": {"id": "h", "homepage": "https://h.test/", "network": {"url": "https://api.h.test/v1"}}},
    ).status_code == 200
    # 未配 homepage 的站（seed 的 demo）不进表
    assert client.get("/api/sites/homepages").json() == {"homepages": {"h": "https://h.test/"}}


def test_site_homepage_roundtrip_through_api(workspace: Path):
    """新增/编辑站点带 homepage：保存后可读回、截图地址用它；非法值 400。"""
    client = TestClient(_app(workspace))
    assert client.post("/api/setup", json={"username": "admin", "password": "s3cret"}).status_code == 200
    created = client.post(
        "/api/sites",
        json={"config": {"id": "h", "homepage": "https://h.test/", "network": {"url": "https://api.h.test/v1"}}},
    )
    assert created.status_code == 200, created.text
    site = next(item for item in client.get("/api/sites").json()["sites"] if item["id"] == "h")
    assert site["homepage"] == "https://h.test/"

    for bad_value in ("nope", "", "  "):
        bad = client.put(
            "/api/sites/h",
            json={"config": {"id": "h", "homepage": bad_value, "network": {"url": "https://api.h.test/v1"}}},
        )
        assert bad.status_code == 400 and "homepage" in bad.text
    # 清空 homepage = 不带该键再保存（与 status.url/notice.url 同惯例：键在就必须非空）
    cleared = client.put(
        "/api/sites/h",
        json={"config": {"id": "h", "network": {"url": "https://api.h.test/v1"}}},
    )
    assert cleared.status_code == 200, cleared.text
    site = next(item for item in client.get("/api/sites").json()["sites"] if item["id"] == "h")
    assert "homepage" not in site


def test_remove_screenshot_tolerates_missing(tmp_path, monkeypatch):
    """没有截图记录时清理是空操作，不报错。"""
    monkeypatch.setattr("llm_price_monitor.screenshot.SCREENSHOT_DIR", tmp_path)
    store = Store(tmp_path / "monitor.db")
    remove_screenshot(store, "never-shot")
    assert store.get_document(SCREENSHOT_DOC) is None


def test_manual_collect_endpoint_uses_screenshot_job(workspace: Path, monkeypatch):
    """手动触发走截图任务体，结果进任务记录。"""
    import llm_price_monitor.webapi.routes.collect as collect_routes

    monkeypatch.setattr(
        collect_routes, "screenshot_scan_job", lambda config, store: (lambda: {"captured": 1, "skipped": 0, "failed": 0})
    )
    client = TestClient(_app(workspace))
    assert client.post("/api/setup", json={"username": "admin", "password": "s3cret"}).status_code == 200
    submitted = client.post("/api/collect/screenshot", json={})
    assert submitted.status_code == 200, submitted.text
    task_id = submitted.json()["task_id"]
    for _ in range(50):
        task = client.get(f"/api/tasks/{task_id}").json()
        if task["status"] != "running":
            break
        time.sleep(0.05)
    assert task["kind"] == "collect-screenshot" and task["status"] == "done"
    assert task["result"] == {"captured": 1, "skipped": 0, "failed": 0}
