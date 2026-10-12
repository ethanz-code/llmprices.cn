"""站点截图：用 headless Chromium 打开站点首页，把页面截成 PNG 落盘。

独立于价格/渠道状态/公告三条采集腿（第七类定时任务）：截图是重活，每站起一次浏览器，
不该拖进高频的轻量采集。截的是站点首页而不是价格接口——接口地址不是给人看的页面。

图片落 var/screenshots/<site_id>.png（原子写入：先写临时文件再替换，写到一半被打断
不会留下半张图），元数据（地址、时间、大小）进 documents.site_screenshots。
单站失败保留上一张成功的图，元数据也不更新；playwright 延迟导入，没装不影响其他采集。
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from urllib.parse import unquote, urlsplit

from llm_price_monitor import egress, tasklog
from llm_price_monitor.config import PriceMonitorError, SiteSpec

# 截图元数据文档：site_id → {url, captured_at, bytes}；图片本体在 var/screenshots 下
SCREENSHOT_DOC = "site_screenshots"

# 截图目录：与 SQLite 同挂在 var/ 下，Docker 部署重启不丢
SCREENSHOT_DIR = Path(os.getenv("PRICE_MONITOR_DB") or "var/monitor.db").parent / "screenshots"

# 单站截图硬上限：页面加载加渲染，慢于普通 HTTP 采集，但单站挂死不能拖住整轮
SITE_SCREENSHOT_TIMEOUT_SECONDS = 60

# 打开页面后额外等一会儿，让首屏异步内容渲染出来再截
RENDER_WAIT_SECONDS = 4

# 视口按常见桌面首屏：截的是首屏而不是整页长图，体积可控、各站可比
VIEWPORT = {"width": 1280, "height": 800}

# 缩略图（总览表一屏几十张，原图平均 400KB+ 直接把页面拖到十几 MB）：
# 按请求宽度生成 JPEG 存 thumbs/ 子目录，文件名带源图 mtime——源图换新自动失效，不用追踪状态
THUMB_WIDTH_MIN = 120
THUMB_WIDTH_MAX = 1200
THUMB_QUALITY = 78

_SAFE_SITE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def screenshot_path(site_id: str) -> Path:
    """站点截图文件路径；site_id 含路径分隔等非法字符时拒绝，避免写出目录外。"""
    if not _SAFE_SITE_ID.match(site_id):
        raise PriceMonitorError(f"站点 id 不能作为截图文件名：{site_id}")
    return SCREENSHOT_DIR / f"{site_id}.png"


def ensure_thumbnail(site_id: str, width: int) -> Path | None:
    """按需生成/取用截图缩略图（JPEG），返回缓存文件路径。

    文件名 `<id>-<源图 mtime>-w<宽>.jpg`：重新截图后 mtime 变化，旧的自动不再命中，
    生成时顺手清掉该站的其它缩略图（每站至多留一份）。Pillow 没装、源图缺失或生成
    失败都返回 None，调用方回落原图，缩略图纯属优化、永远不阻塞展示。
    """
    try:
        from PIL import Image
    except ImportError:
        return None
    try:
        source = screenshot_path(site_id)
    except PriceMonitorError:
        return None
    if not source.is_file():
        return None
    width = max(THUMB_WIDTH_MIN, min(int(width), THUMB_WIDTH_MAX))
    dest = SCREENSHOT_DIR / "thumbs" / f"{site_id}-{int(source.stat().st_mtime)}-w{width}.jpg"
    if not dest.is_file():
        tmp = dest.with_name(dest.name + ".tmp")
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            with Image.open(source) as image:
                rgb = image.convert("RGB")
                height = max(1, round(rgb.height * width / rgb.width))
                rgb.resize((width, height), Image.LANCZOS).save(tmp, format="JPEG", quality=THUMB_QUALITY, optimize=True)
            os.replace(tmp, dest)
        except Exception:
            tmp.unlink(missing_ok=True)
            return None
        # 旧源图版本的缩略图（含失败残留）顺手清掉；只动本站在本目录下的文件
        for stale in dest.parent.glob(f"{site_id}-*-w*.jpg"):
            if stale != dest:
                stale.unlink(missing_ok=True)
    return dest


def remove_thumbnails(site_id: str) -> None:
    """清掉某站的全部缩略图缓存（删站/改名时随图片一起清，避免留孤儿文件）。"""
    try:
        if not _SAFE_SITE_ID.match(site_id):
            return
    except TypeError:
        return
    for stale in (SCREENSHOT_DIR / "thumbs").glob(f"{site_id}-*-w*.jpg"):
        stale.unlink(missing_ok=True)


def site_homepage(spec: SiteSpec) -> str | None:
    """截图目标地址：站点配置了 homepage 就用它，否则从 network.url 推导源站根地址。

    采集入口在 API 子域、本地根路径不是可看页面的站（如 4aicode）靠 homepage 显式指定；
    network.url 缺失或不是 http(s) 地址时返回 None——这类站没有可展示的页面，跳过。
    """
    configured = str(spec.homepage or "").strip()
    if configured:
        parsed_homepage = urlsplit(configured)
        if parsed_homepage.scheme in {"http", "https"} and parsed_homepage.netloc:
            return configured
    network_url = str(spec.network.get("url") or "").strip()
    if not network_url:
        return None
    parsed = urlsplit(network_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return f"{parsed.scheme}://{parsed.netloc}/"


def _chromium_proxy(proxy_url: str) -> dict[str, str]:
    """代理地址 → Playwright proxy 形态：认证拆成独立 username/password（与 browser_fetch 同口径）。"""
    parsed = urlsplit(proxy_url)
    proxy = {"server": f"{parsed.scheme}://{parsed.netloc.rsplit('@', 1)[-1]}"}
    if parsed.username:
        proxy["username"] = unquote(parsed.username)
    if parsed.password:
        proxy["password"] = unquote(parsed.password)
    return proxy


def capture_screenshot(url: str, dest: Path, *, user_agent: str | None = None) -> int:
    """打开 url 截首屏 PNG 写到 dest，返回文件字节数。失败抛 PriceMonitorError，不留半成品文件。"""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise PriceMonitorError(
            "服务器还没装 Headless 组件，请在部署环境执行 pip install playwright && playwright install chromium"
        ) from exc

    host = urlsplit(url).netloc.rsplit("@", 1)[-1].split(":", 1)[0]
    # 出口跟随直连失败记忆（只读不写）：被墙站直接带代理，与 headless 价格采集同一选择
    proxy_server = egress.fallback_proxy() if egress.plan(host).use_proxy else None

    playwright = None
    browser = None
    tmp = dest.with_name(dest.name + ".tmp")
    try:
        playwright = sync_playwright().start()
        browser = playwright.chromium.launch(
            headless=True, proxy=_chromium_proxy(proxy_server) if proxy_server else None
        )
        context = browser.new_context(viewport=VIEWPORT, user_agent=user_agent) if user_agent else browser.new_context(viewport=VIEWPORT)
        page = context.new_page()
        response = page.goto(url, timeout=SITE_SCREENSHOT_TIMEOUT_SECONDS * 1000, wait_until="domcontentloaded")
        # 4xx/5xx 是报错页不是站点样子（如 api.* 子域根路径返回 404）：不当作有效截图，
        # 保留上一张成功图；站点根路径恢复可用后下一轮自然补上
        if response is not None and response.status >= 400:
            raise PriceMonitorError(f"首页 {url} 返回 HTTP {response.status}，本次不更新截图")
        page.wait_for_timeout(int(RENDER_WAIT_SECONDS * 1000))
        dest.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(tmp), type="png")
        os.replace(tmp, dest)  # 原子替换：中途失败时旧图保持原样
        return dest.stat().st_size
    except Exception as exc:
        raise PriceMonitorError(f"站点截图 {url} 失败：{exc}") from exc
    finally:
        tmp.unlink(missing_ok=True)
        if browser is not None:
            browser.close()
        if playwright is not None:
            playwright.stop()


def record_screenshot(store, site_id: str, *, url: str, captured_at: float, size: int) -> None:
    """把单站截图元数据合并进文档；只更新该站，不动其他站的记录。"""
    doc = dict(store.get_document(SCREENSHOT_DOC) or {})
    doc[site_id] = {"url": url, "captured_at": captured_at, "bytes": size}
    store.set_document(SCREENSHOT_DOC, doc)


def remove_screenshot(store, site_id: str) -> None:
    """删站清理：摘掉元数据并删除图片与缩略图缓存；文件不存在不算失败。"""
    doc = dict(store.get_document(SCREENSHOT_DOC) or {})
    if site_id in doc:
        doc.pop(site_id)
        store.set_document(SCREENSHOT_DOC, doc)
    try:
        screenshot_path(site_id).unlink(missing_ok=True)
    except PriceMonitorError:
        return  # id 不合法时根本不会有对应文件
    remove_thumbnails(site_id)


def scan_screenshots(config, store, *, user_agent: str | None = None) -> dict[str, int]:
    """逐站截图一轮：启用中的站点各截一次，单站失败记错误继续下一站。

    返回 {captured, skipped, failed} 计数。失败的站保留上一张成功截图。
    """
    import time

    captured = skipped = failed = 0
    tasklog.emit("开始站点截图")
    for spec in config.sites:
        if not spec.enabled:
            continue
        url = site_homepage(spec)
        if url is None:
            skipped += 1
            tasklog.emit(f"[{spec.id}] 没有可截图的首页地址（缺采集地址），跳过", "warn")
            continue
        tasklog.emit(f"[{spec.id}] 截取首页 {url}")
        try:
            size = capture_screenshot(url, screenshot_path(spec.id), user_agent=user_agent)
        except PriceMonitorError as exc:
            failed += 1
            tasklog.emit(f"[{spec.id}] 截图失败：{exc}", "error")
            continue
        record_screenshot(store, spec.id, url=url, captured_at=time.time(), size=size)
        captured += 1
        tasklog.emit(f"[{spec.id}] 截图完成（{size} 字节）")
    tasklog.emit(f"站点截图结束：成功 {captured}，跳过 {skipped}，失败 {failed}")
    return {"captured": captured, "skipped": skipped, "failed": failed}
