"""站点人气：交流群链接/群人数与公开访问量、全网排名的采集（第八类定时任务）。

只收公开信息、匿名抓取，不碰站点凭证。群链接两个来源：站点 /api/status 的
chat_link（new-api 后台「聊天链接」配置，主源）与首页 HTML 里的群链接（页脚常挂）；
Telegram 公开群/频道的成员数从 t.me 预览页取（真实数字、无需登录），QQ 群没有
公开人数接口，只存群链接与群号。

「月访问量」没有覆盖小站的免费数据源（实测：SimilarWeb 公共端点被 CloudFront 拒、
Cloudflare Radar 只给 >20 万档位、Tranco 只给排名）：能拿到第三方估算（hypestat）
就存数字并标来源，拿不到就退回 Tranco 全网排名当热度信号，页面按来源如实标注。

落 documents.site_popularity（site_id → 载荷），单站两个来源都失败时保留旧数据；
新采集拿不到的数字字段按字段回退旧值，不会因为一次网络抖动把已有数据清掉。
"""
from __future__ import annotations

import base64
import re
import time
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx

from llm_price_monitor import egress, proxy_switch, tasklog
from llm_price_monitor.config import SiteSpec
from llm_price_monitor.http_retry import build_client
from llm_price_monitor.screenshot import site_homepage
from llm_price_monitor.useragent import DEFAULT_BROWSER_USER_AGENT

# 人气数据文档：site_id → {groups, traffic, checked_at}
POPULARITY_DOC = "site_popularity"

# 首页 HTML 扫描上限：群链接都在头部/页脚，整页太长没必要全读
HOMEPAGE_SCAN_LIMIT = 400_000

# 单站群链接上限：正常站最多几个，超出多是页面里的杂链接
MAX_GROUPS_PER_SITE = 8

# Tranco 有速率限制（实测 1.1s 间隔会偶发 429），两次查询之间留的间隔
TRANCO_INTERVAL_SECONDS = 2.0

# 交流群链接识别：站点把群链接放在 /api/status（chat_link / 导航链接）或首页 HTML 里。
# 协议前缀可选：公告里常写裸域名（"加入 t.me/xxx"），命中后统一补 https://。
GROUP_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("telegram", re.compile(r"(?:https?://)?(?:t\.me|telegram\.me)/[^\s\"'<>\\]+", re.I)),
    ("qq", re.compile(r"(?:https?://)?(?:qm\.qq\.com|qun\.qq\.com|jq\.qq\.com)/[^\s\"'<>\\]+", re.I)),
    ("discord", re.compile(r"(?:https?://)?(?:discord\.gg|discord\.com/invite)/[^\s\"'<>\\]+", re.I)),
    ("wechat", re.compile(r"(?:https?://)?(?:work\.weixin\.qq\.com|weixin\.qq\.com)/[^\s\"'<>\\]+", re.I)),
)

# 公告正文里的裸 QQ 群号（"QQ群：123456789"）：QQ 没有公开的加群网页，只存群号供用户搜索
_QQ_NUMBER = re.compile(r"(?:QQ\s*群|Q\s*群|交流群|官方群|用户群|售后群|群号)[^\d\n]{0,8}(\d{6,12})")

# 链接尾部可能粘上引号/括号/转义符，落库前剪掉
_TRAILING_JUNK = "\"'<>\\,);。，、"

# Telegram 公开用户名：私邀链接（+hash / joinchat）拿不到预览数据，只存链接
_TG_USERNAME = re.compile(r"^[A-Za-z0-9_]{4,32}$")
# t.me 的保留路径段不是用户名，当群名去抓预览页只会拿到无关页面
_TG_RESERVED = frozenset({"joinchat", "addstickers", "share", "proxy", "socks", "iv", "s"})

# t.me 预览页里的成员数文案："1 183 members, 53 online" / "705 subscribers"
_TG_COUNT = re.compile(r"([\d][\d\s\u00a0,]*?)\s*(members?|subscribers?)\b", re.I)
_TG_ONLINE = re.compile(r"([\d][\d\s\u00a0,]*?)\s*online\b", re.I)

# hypestat 月访问量："Monthly Visits 134.7K"（数字后可能带 K/M/B 量级后缀）
_VISITS = re.compile(r"Monthly Visits[^0-9]{0,160}?([\d.,]+)\s*([KMB]?)", re.I | re.S)
_VISITS_SCALE = {"": 1, "K": 1_000, "M": 1_000_000, "B": 1_000_000_000}

# SimilarWeb 站内 JSON API（免登录）：空 aws-waf-token cookie 免 WAF 质询（omkarcloud/
# similarweb-scraper 验证的规律，本地实测复现），但同一出口 IP 只有约 6 次额度，超了回
# 202（质询）/403（拉黑数小时）。出口用系统设置里配的备用代理（与采集兜底同一条线）；
# 没配代理的直连环境额度打完只能等下一轮（24h 周期天然错开额度窗口，数据月更不敏感）。
SIMILARWEB_API = "https://www.similarweb.com/api/website/{domain}"
_SIMILARWEB_BLOCKED = frozenset({202, 403, 405})


def _origin(url: str) -> str:
    parsed = urlsplit(url or "")
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    return f"{parsed.scheme}://{parsed.netloc}"


def site_host(spec: SiteSpec) -> str:
    """站点主域名（人气查询用）：优先 homepage，其次采集地址；剥 www.、跳过纯 IP。"""
    candidates = [spec.homepage or "", str((spec.network or {}).get("url") or "")]
    for candidate in candidates:
        host = urlsplit(candidate).hostname or ""
        host = host.removeprefix("www.")
        if host and not host.replace(".", "").isdigit():
            return host
    return ""


def _clean_url(url: str) -> str:
    return url.rstrip(_TRAILING_JUNK)


def _telegram_username(url: str) -> str:
    """公开群/频道用户名；私邀链接（t.me/+xxx、joinchat）与保留路径段返回空串。"""
    parsed = urlsplit(url)
    if parsed.hostname not in {"t.me", "telegram.me", "www.t.me"}:
        return ""
    segment = parsed.path.strip("/").split("/", 1)[0]
    if segment.lower() in _TG_RESERVED:
        return ""
    return segment if _TG_USERNAME.match(segment) else ""


def _qq_group_number(url: str) -> str:
    """QQ 群号：universal-share 链接的 busi_data（base64 JSON）里有 groupCode，join.html 走 gc 参数。"""
    query = parse_qs(urlsplit(url).query)
    for key in ("gc", "group_code", "groupCode"):
        values = query.get(key) or []
        if values and values[0].isdigit():
            return values[0]
    for raw in query.get("busi_data") or []:
        try:
            decoded = base64.b64decode(raw + "=" * (-len(raw) % 4)).decode("utf-8", "ignore")
        except Exception:
            continue
        match = re.search(r'"groupCode"\s*:\s*"(\d+)"', decoded)
        if match:
            return match.group(1)
    return ""


def _group_label(kind: str, url: str) -> str:
    if kind == "telegram":
        username = _telegram_username(url)
        return f"@{username}" if username else "Telegram"
    if kind == "qq":
        number = _qq_group_number(url)
        return f"QQ 群 {number}" if number else "QQ 群"
    if kind == "discord":
        return "Discord"
    return "微信"


def extract_groups(texts: list[str]) -> list[dict[str, Any]]:
    """从若干段文本里提取交流群：链接按平台识别、按 URL 去重、裁剪尾部杂字符；
    另收公告里带上下文词的裸 QQ 群号（"QQ群：123456789"，已有该群链接时不重复收）。"""
    groups: list[dict[str, Any]] = []
    seen: set[str] = set()
    for text in texts:
        for kind, pattern in GROUP_PATTERNS:
            for match in pattern.finditer(text or ""):
                url = _clean_url(match.group(0))
                if not url:
                    continue
                if not url.lower().startswith("http"):
                    url = f"https://{url}"  # 公告里的裸域名补协议，落库后可直接点
                if url in seen:
                    continue
                seen.add(url)
                groups.append({"type": kind, "url": url, "label": _group_label(kind, url)})
                if len(groups) >= MAX_GROUPS_PER_SITE:
                    return groups
    for text in texts:
        for match in _QQ_NUMBER.finditer(text or ""):
            number = match.group(1)
            if any(number in (group.get("url") or "") for group in groups):
                continue
            if any((group.get("label") or "").endswith(number) for group in groups):
                continue
            groups.append({"type": "qq", "url": "", "label": f"QQ 群 {number}"})
            if len(groups) >= MAX_GROUPS_PER_SITE:
                return groups
    return groups


def _walk_strings(value: Any) -> list[str]:
    """递归收集 JSON 载荷里的字符串（群链接可能藏在 chat_link / 导航配置任意位置）。"""
    out: list[str] = []
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, dict):
            stack.extend(item.values())
        elif isinstance(item, list):
            stack.extend(item)
        elif isinstance(item, str):
            out.append(item)
    return out


def _count(text: str) -> int | None:
    digits = re.sub(r"[\s\u00a0,]", "", text)
    return int(digits) if digits.isdigit() else None


def fetch_telegram_stats(url: str, client: httpx.Client) -> dict[str, Any]:
    """t.me 公开预览页 → {members, members_kind, online, title}；私邀链接或抓取失败返回空对象。

    members_kind 区分频道（subscribers）与群（members）：展示文案一个叫「频道」一个叫「群」。
    用户名不存在时 t.me 给的是「Telegram: Contact @xxx」占位页——返回 {"dead": True} 让上层剔除这条死链，
    与"网络失败返回 {}"区分开（后者不剔除，下轮还能补上）。
    """
    username = _telegram_username(url)
    if not username:
        return {}
    try:
        response = client.get(f"https://t.me/{username}", headers={"Accept-Language": "en"})
    except httpx.HTTPError:
        return {}
    if response.status_code != 200:
        return {}
    html = response.text
    stats: dict[str, Any] = {}
    extra = re.search(r'tgme_page_extra">([^<]*)', html)
    if extra:
        members = _TG_COUNT.search(extra.group(1))
        online = _TG_ONLINE.search(extra.group(1))
        if members and (count := _count(members.group(1))) is not None:
            stats["members"] = count
            stats["members_kind"] = "subscribers" if members.group(2).lower().startswith("subscriber") else "members"
        if online and (count := _count(online.group(1))) is not None:
            stats["online"] = count
    title = re.search(r'tgme_page_title[^>]*>\s*<span[^>]*>([^<]*)', html) or re.search(
        r'property="og:title"\s+content="([^"]*)"', html
    )
    if title and title.group(1).strip():
        stats["title"] = title.group(1).strip()[:80]
    if str(stats.get("title") or "").startswith("Telegram: Contact @"):
        return {"dead": True}
    return stats


def fetch_tranco_rank(host: str, client: httpx.Client) -> int | None:
    """Tranco 每日榜排名（聚合 DNS/流量榜的研究数据，覆盖前 100 万域名）；查不到返回 None。"""
    try:
        response = client.get(f"https://tranco-list.eu/api/ranks/domain/{host}")
    except httpx.HTTPError:
        return None
    if response.status_code != 200:
        return None
    try:
        ranks = response.json().get("ranks") or []
    except ValueError:
        return None
    if not ranks or not isinstance(ranks[0].get("rank"), (int, float)):
        return None
    return int(ranks[0]["rank"])


def fetch_visits_estimate(host: str, client: httpx.Client) -> int | None:
    """第三方月访问量估算（hypestat）；站点太小没有数据时返回 None。"""
    try:
        response = client.get(f"https://hypestat.com/info/{host}")
    except httpx.HTTPError:
        return None
    if response.status_code != 200:
        return None
    match = _VISITS.search(response.text)
    if not match:
        return None
    try:
        value = float(match.group(1).replace(",", "")) * _VISITS_SCALE.get(match.group(2).upper(), 1)
    except ValueError:
        return None
    return int(value) if 0 < value < 1e12 else None


class SimilarWebClient:
    """SimilarWeb 站内 JSON API 的轻客户端：请求走独立 httpx 客户端（直连 + 空质询 cookie）。

    WAF 对单出口 IP 只放约 6 次请求：碰壁（202/403/405）后经 proxy_switch 换一个对该站
    可达的节点再试（与采集链路同一条切换线）；换不了就放弃本轮，下轮（24h 后）额度已重置。
    SimilarWeb 的 CloudFront 只认数据中心/住宅出口，本机直连 IP 常态被 403（实测），所以
    首选请求就带系统设置的备用代理出口（effective_proxy，与采集兜底同一条线），直连仅作
    代理缺失时的兜底。
    """

    def __init__(self, user_agent: str, timeout: float = 25.0) -> None:
        self._timeout = timeout
        self._headers = {
            "User-Agent": user_agent,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://www.similarweb.com/",
        }

    def fetch(self, domain: str) -> dict[str, Any] | None:
        """域名 → {monthly_visits, global_rank}；无数据/被拦/网络失败返回 None（上游语义不区分）。"""
        # 采集始终「直连优先、被墙兜底」，但 SimilarWeb 恰好相反：本机/数据中心直连 IP 被它
        # 的 CloudFront 常态拒收，住宅出口才放行——所以这里代理优先、直连兜底，与采集链路镜像
        proxies = egress.effective_proxy()
        attempts: tuple[dict | None, ...] = ({"proxy": proxies} if proxies else None, None)
        for kwargs in attempts:
            try:
                response = httpx.get(
                    SIMILARWEB_API.format(domain=domain),
                    headers=self._headers,
                    cookies={"aws-waf-token": ""},
                    timeout=self._timeout,
                    **(kwargs or {}),
                )
            except httpx.HTTPError:
                continue
            if response.status_code in _SIMILARWEB_BLOCKED:
                continue  # 这个出口被拉黑，换下一个出口
            if response.status_code != 200:
                return None  # 204 = SimilarWeb 没有该域数据（本地实测）
            return self._parse(response)
        return None

    @staticmethod
    def _parse(response: httpx.Response) -> dict[str, Any] | None:
        try:
            payload = response.json()
        except ValueError:
            return None
        overview = payload.get("overview") if isinstance(payload, dict) else None
        visits = overview.get("visitsTotalCount") if isinstance(overview, dict) else None
        ranking = payload.get("ranking") if isinstance(payload, dict) else None
        history = ranking.get("globalRankHistory") if isinstance(ranking, dict) else None
        rank = None
        if isinstance(history, list):
            for point in reversed(history):
                if isinstance(point, dict) and point.get("rank"):
                    rank = int(point["rank"])
                    break
        result: dict[str, Any] = {}
        if isinstance(visits, (int, float)) and 0 < visits < 1e12:
            result["monthly_visits"] = int(visits)
        if rank:
            result["global_rank"] = rank
        return result or None

    def visits_with_retry(self, domain: str, host_label: str) -> int | None:
        """拿月访问量：先直连一次，被 WAF 拦下且系统配置了节点切换就换节点再试一次。"""
        result = self.fetch(domain)
        if result is not None and result.get("monthly_visits"):
            return int(result["monthly_visits"])
        if result is not None:
            return None  # 上游明确没数据（204），换出口也不会有
        switched = proxy_switch.auto_switch_for(f"similarweb:{host_label}", SIMILARWEB_API.format(domain=domain))
        if switched is None:
            return None
        tasklog.emit(f"[{host_label}] SimilarWeb 出口被 WAF 拦下，已切换节点 → {switched}，重试访问量查询")
        retried = self.fetch(domain)
        if retried and retried.get("monthly_visits"):
            return int(retried["monthly_visits"])
        return None


def collect_site(
    spec: SiteSpec,
    client: httpx.Client,
    *,
    notice_text: str = "",
    similarweb: "SimilarWebClient | None" = None,
) -> dict[str, Any] | None:
    """采集单站人气；站点接口、首页、已存公告三个来源全空时返回 None（保留旧数据）。

    notice_text 是 store 里该站最近一条公告正文：公告是群号的高产来源（"加入 QQ 群 …"），
    顺带扫描比再打一次公告接口便宜。
    """
    page_url = site_homepage(spec) or ""
    origin = _origin(str((spec.network or {}).get("url") or "")) or _origin(page_url)
    texts: list[str] = [notice_text] if notice_text else []
    network_ok = 0
    if origin:
        try:
            response = client.get(f"{origin}/api/status")
            if response.status_code == 200:
                network_ok += 1
                try:
                    texts.extend(_walk_strings(response.json()))
                except ValueError:
                    pass
        except httpx.HTTPError:
            pass
    if page_url:
        try:
            response = client.get(page_url)
            if response.status_code == 200:
                network_ok += 1
                texts.append(response.text[:HOMEPAGE_SCAN_LIMIT])
        except httpx.HTTPError:
            pass
    if network_ok == 0 and not notice_text:
        return None
    groups: list[dict[str, Any]] = []
    for group in extract_groups(texts):
        if group["type"] == "telegram" and group["url"]:
            stats = fetch_telegram_stats(group["url"], client)
            if stats.get("dead"):
                continue  # t.me 上用户名不存在的死链，不收
            group.update(stats)
        groups.append(group)
    traffic: dict[str, Any] = {}
    host = site_host(spec)
    if host:
        # Tranco 有速率限制：两次查询之间拉开间隔（放在查排名前，保证跨站点也生效）
        time.sleep(TRANCO_INTERVAL_SECONDS)
        rank = fetch_tranco_rank(host, client)
        if rank is not None:
            traffic.update({"rank": rank, "rank_source": "tranco"})
        # 月访问量：SimilarWeb 站内 API 是主源（覆盖面广、真实统计），WAF 拦下自动换节点；
        # 拿不到再退 hypestat 公开页估算（覆盖面小）
        visits: int | None = None
        visits_source = ""
        if similarweb is not None:
            visits = similarweb.visits_with_retry(host, spec.id)
            visits_source = "similarweb" if visits else ""
        if visits is None:
            visits = fetch_visits_estimate(host, client)
            visits_source = "hypestat" if visits else ""
        if visits:
            traffic.update({"monthly_visits": visits, "visits_source": visits_source})
    return {"groups": groups, "traffic": traffic, "checked_at": time.time()}


def _merge_traffic(previous: dict[str, Any], fresh: dict[str, Any]) -> dict[str, Any]:
    """数字字段逐个合并：本轮拿到的覆盖旧的，拿不到的保留旧值（防一次抖动清空）。"""
    merged = dict(previous)
    refreshed = False
    for key in ("monthly_visits", "visits_source", "rank", "rank_source"):
        value = fresh.get(key)
        if value is not None:
            merged[key] = value
            refreshed = True
    if refreshed:
        merged["updated_at"] = time.time()
    return merged


def _merge_payload(previous: dict[str, Any], fresh: dict[str, Any]) -> dict[str, Any]:
    """合并新旧载荷：群列表整体替换（来源成功才采到空列表，视为站方摘了群），
    Telegram 人数按 URL 回退旧值（t.me 偶发抓不到不该丢已有数字）。"""
    old_groups = {
        group.get("url"): group
        for group in previous.get("groups") or []
        if isinstance(group, dict) and group.get("url")
    }
    groups: list[dict[str, Any]] = []
    for group in fresh.get("groups") or []:
        item = dict(group)
        old = old_groups.get(item.get("url"))
        if old:
            for key in ("members", "online", "title"):
                if item.get(key) is None and old.get(key) is not None:
                    item[key] = old[key]
        groups.append(item)
    return {
        "groups": groups,
        "traffic": _merge_traffic(previous.get("traffic") or {}, fresh.get("traffic") or {}),
        "checked_at": fresh.get("checked_at") or time.time(),
    }


def record_popularity(store, site_id: str, payload: dict[str, Any]) -> None:
    """把单站人气合并进文档；只更新该站，不动其他站的记录。"""
    doc = dict(store.get_document(POPULARITY_DOC) or {})
    previous = doc.get(site_id) if isinstance(doc.get(site_id), dict) else {}
    doc[site_id] = _merge_payload(previous, payload)
    store.set_document(POPULARITY_DOC, doc)


def remove_popularity(store, site_id: str) -> None:
    """删站清理：摘掉该站的人气记录。"""
    doc = dict(store.get_document(POPULARITY_DOC) or {})
    if site_id in doc:
        doc.pop(site_id)
        store.set_document(POPULARITY_DOC, doc)


def scan_popularity(config, store, *, client: httpx.Client | None = None, user_agent: str | None = None) -> dict[str, int]:
    """逐站采集一轮人气：全部站点（含未启用，选站要用），单站失败记日志继续下一站。

    返回 {sites, groups, visits, ranked, failed} 计数。
    """
    owns_client = client is None
    if client is None:
        client = build_client(
            timeout=15, headers={"User-Agent": user_agent or DEFAULT_BROWSER_USER_AGENT}
        )
    stats = {"sites": 0, "groups": 0, "visits": 0, "ranked": 0, "failed": 0}
    tasklog.emit("开始站点人气采集")
    # SimilarWeb 站内 API 的 WAF 按出口 IP 计额度：整轮共用一个轻客户端（独立于采集 client，
    # 不走退避重试——它没有"换出口"逻辑），碰壁时经 proxy_switch 换节点续命
    similarweb = SimilarWebClient(user_agent or DEFAULT_BROWSER_USER_AGENT)
    try:
        for spec in config.sites:
            stats["sites"] += 1
            notice = store.latest_notice(spec.id) or {}
            notice_text = str(notice.get("content") or "")
            try:
                payload = collect_site(spec, client, notice_text=notice_text, similarweb=similarweb)
            except Exception as exc:  # noqa: BLE001 —— 单站异常不拖垮整轮，但必须留痕
                stats["failed"] += 1
                tasklog.emit(f"[{spec.id}] 人气采集失败：{exc}", "warn")
                continue
            if payload is None:
                stats["failed"] += 1
                tasklog.emit(f"[{spec.id}] 人气采集失败：站点接口、首页都打不开且没有已存公告，保留旧数据", "warn")
                continue
            record_popularity(store, spec.id, payload)
            groups = payload.get("groups") or []
            traffic = payload.get("traffic") or {}
            stats["groups"] += len(groups)
            stats["visits"] += 1 if traffic.get("monthly_visits") else 0
            stats["ranked"] += 1 if traffic.get("rank") else 0
            detail = "，".join(group["label"] for group in groups) or "未发现交流群"
            tasklog.emit(
                f"[{spec.id}] 人气：{detail}"
                + (f"，月访问量约 {traffic['monthly_visits']}" if traffic.get("monthly_visits") else "")
                + (f"，全网排名 {traffic['rank']}" if traffic.get("rank") else "")
            )
        tasklog.emit(
            f"站点人气采集结束：{stats['sites']} 站，发现交流群 {stats['groups']} 个，"
            f"月访问量 {stats['visits']} 站，排名 {stats['ranked']} 站，失败 {stats['failed']} 站"
        )
    finally:
        if owns_client:
            client.close()
    return stats
