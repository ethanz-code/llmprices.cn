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

SimilarWeb 站内 API 按出口 IP 限流（实测单出口连打约 10 次即冻结、约 11 分钟解冻）：
采集从节点切换组读出「出口池」，请求按出口分散，被限流的出口冻结换下一个；两个外部源
各有复查期（有值 7 天、确认无数据 30 天），确认过没数据的站不每轮白烧出口额度。
"""
from __future__ import annotations

import base64
import re
import sqlite3
import time
from dataclasses import dataclass
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

# 链接尾部可能粘上引号/括号/转义符，写库前剪掉
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
# similarweb-scraper 验证的规律，本地实测复现）。WAF 按出口 IP 限流，2026-10-15 实测：
# 单出口连打约 10 次就从第 11 次起回 202、换一个出口立刻放行、被冻出口约 10 分 40 秒解冻；
# 采集出口组里各节点出口 IP 互不相同，所以采集把请求按出口池分散，别把一个出口打穿。
SIMILARWEB_API = "https://www.similarweb.com/api/website/{domain}"
_SIMILARWEB_BLOCKED = frozenset({202, 403, 405, 429})

# 出口池参数：每个出口在滑动窗口内的请求预算（实测单出口上限约 10 次，取 6 留出被共享
# 出口消耗的余量）、命中封锁后的停用时长（实测约 10 分 40 秒解冻，取 15 分钟保余量）、
# 网络失败后的短暂避开时长、单站最多试几个出口。
SW_WINDOW_SECONDS = 600.0
SW_WINDOW_BUDGET = 6
SW_FREEZE_SECONDS = 900.0
SW_ERROR_COOLDOWN_SECONDS = 300.0
SW_MAX_ATTEMPTS = 4

# 外部源复查间隔：拿到值后 7 天复查一次（SimilarWeb 月更、Tranco 日更，周更足够）；
# 确认过「上游没有这个站的数据」的按月复查（小站体量变化慢，别每轮都白烧出口额度）。
VALUE_RECHECK_SECONDS = 7 * 86_400
EMPTY_RECHECK_SECONDS = 30 * 86_400

# 自动补采上限：出口额度按 10 分钟窗口回补，主轮跑完还剩没轮到/被限流的站时，等窗口回补
# 接着补，最多补这么久；到点还没补完的留给下轮定时采集（待补站下轮排最前）。手动全量刷新
# 85 站约需 18 分钟额度，20 分钟能一轮补完；定时轮通常只剩零星几个站，几秒到几分钟收尾。
POPULARITY_TOPUP_SECONDS = 1200.0


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
                    url = f"https://{url}"  # 公告里的裸域名补协议，写库后可直接点
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


@dataclass(frozen=True)
class RankResult:
    """Tranco 一次查询的结局：settled=上游明确给了结论（含「没收录」）；查询失败不算结论。"""

    rank: int | None = None
    settled: bool = False


def fetch_tranco_rank(host: str, client: httpx.Client) -> RankResult:
    """Tranco 每日榜排名（聚合 DNS/流量榜的研究数据，覆盖前 100 万域名）。

    200 且榜单里有值 → 有排名；200 但榜单为空 → 上游明确没收录（settled=True，
    记一个月复查期，别每轮都来问一遍）；其他状态码/网络失败 → 没结论，下轮重试。
    """
    try:
        response = client.get(f"https://tranco-list.eu/api/ranks/domain/{host}")
    except httpx.HTTPError:
        return RankResult()
    if response.status_code != 200:
        return RankResult()
    try:
        payload = response.json()
    except ValueError:
        return RankResult()
    ranks = payload.get("ranks") if isinstance(payload, dict) else None
    if not isinstance(ranks, list):
        return RankResult()
    if not ranks:
        return RankResult(None, True)
    first = ranks[0] if isinstance(ranks[0], dict) else {}
    value = first.get("rank")
    if isinstance(value, (int, float)):
        return RankResult(int(value), True)
    return RankResult()


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


@dataclass(frozen=True)
class TrafficResult:
    """SimilarWeb 一次查询的结局：ok=有数据 / empty=上游没有该域数据（204）/
    blocked=出口被 WAF 限流 / error=网络层失败（后两种换个出口可以再试）。"""

    kind: str
    visits: int | None = None

    @property
    def settled(self) -> bool:
        """上游已经给了结论（有数据或明确没有），换出口重试没有意义。"""
        return self.kind in ("ok", "empty")


class SimilarWebClient:
    """SimilarWeb 站内 JSON API 的轻客户端（独立 httpx、空质询 cookie、按出口池分散请求）。

    WAF 按出口 IP 限流，所以请求要分散、到预算就主动让路：
    ① 配了节点切换（出口池）时轮着用池里各出口，每出口每 SW_WINDOW_SECONDS 最多打
       SW_WINDOW_BUDGET 次；命中封锁的出口停用 SW_FREEZE_SECONDS，单站最多换
       SW_MAX_ATTEMPTS 个出口；
    ② 没配节点切换时按单出口采集：代理优先、直连后备，额度打满本轮不再打，
       缺数据的站靠 24 小时的定时周期自然轮转补上；
    ③ 上游明确没数据（204）不换出口（换多少出口都是没有）。
    """

    def __init__(self, user_agent: str, timeout: float = 25.0) -> None:
        self._timeout = timeout
        self._headers = {
            "User-Agent": user_agent,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://www.similarweb.com/",
        }
        self._proxy: str | None = None
        self._pool: list[str] | None = None  # None=还没读；[]=没有可轮换的出口
        self._selected = ""
        self._used: dict[str, list[float]] = {}  # 出口 -> 窗口内的请求时刻
        self._avoid_until: dict[str, float] = {}  # 出口 -> 停用/避开的截止时刻
        self._switches = 0
        self._exhausted_note = False

    # ---- 出口池 ----

    def _ensure_pool(self) -> None:
        """读一次出口池（节点切换组里的出口）；读不到就退回单出口，留痕不打断。"""
        if self._pool is not None:
            return
        self._pool = []
        self._proxy = egress.effective_proxy()
        if not self._proxy:
            return  # 没配代理出口：没有可切换的链路，直连打 SimilarWeb 必然被拒
        try:
            state = proxy_switch.pool_state()
        except Exception as exc:  # noqa: BLE001 —— 出口池读不到不该拖垮采集
            tasklog.emit(f"SimilarWeb 出口池读取失败，本轮按单出口采集：{exc}", "warn")
            return
        if state is None:
            return
        self._pool, self._selected = state
        window = f"{int(SW_WINDOW_SECONDS / 60)} 分钟" if SW_WINDOW_SECONDS >= 60 else f"{int(SW_WINDOW_SECONDS)} 秒"
        tasklog.emit(
            f"SimilarWeb 出口池：{len(self._pool)} 个出口，每出口每 {window} 最多 {SW_WINDOW_BUDGET} 次请求"
        )

    def _pick_node(self, now: float) -> str | None:
        """挑一个窗口内还有预算、没在停用期的出口（用得少的优先，平手留在当前出口）。"""
        candidates: list[tuple[int, bool, str]] = []
        for node in self._pool or []:
            if self._avoid_until.get(node, 0.0) > now:
                continue
            recent = [at for at in self._used.get(node, []) if now - at < SW_WINDOW_SECONDS]
            self._used[node] = recent
            if len(recent) >= SW_WINDOW_BUDGET:
                continue
            candidates.append((len(recent), node != self._selected, node))
        if not candidates:
            return None
        candidates.sort()
        return candidates[0][2]

    def _retire(self, node: str, result: TrafficResult, host_label: str) -> None:
        """把本轮用不了的出口停用：被限流按冻结时长，连不上按短暂避开。"""
        if result.kind == "blocked":
            self._avoid_until[node] = time.time() + SW_FREEZE_SECONDS
            self._switches += 1
            tasklog.emit(
                f"[{host_label}] SimilarWeb 出口「{node}」额度用完，冻结换下一个出口（本轮第 {self._switches} 次）"
            )
            return
        self._avoid_until[node] = time.time() + SW_ERROR_COOLDOWN_SECONDS
        tasklog.emit(f"[{host_label}] SimilarWeb 出口「{node}」连不上，本轮先避开", "warn")

    # ---- 请求 ----

    def _request(self, domain: str, proxy: str | None) -> TrafficResult:
        """单次请求：200=有数据、202/403/405/429=被 WAF 限流、204=上游明确没这个域的数据。"""
        try:
            response = httpx.get(
                SIMILARWEB_API.format(domain=domain),
                headers=self._headers,
                cookies={"aws-waf-token": ""},
                timeout=self._timeout,
                **(dict(proxy=proxy) if proxy else {}),
            )
        except httpx.HTTPError:
            return TrafficResult("error")
        if response.status_code in _SIMILARWEB_BLOCKED:
            return TrafficResult("blocked")
        if response.status_code != 200:
            return TrafficResult("empty")
        return self._parse(response)

    @staticmethod
    def _parse(response: httpx.Response) -> TrafficResult:
        try:
            payload = response.json()
        except ValueError:
            return TrafficResult("empty")
        overview = payload.get("overview") if isinstance(payload, dict) else None
        visits = overview.get("visitsTotalCount") if isinstance(overview, dict) else None
        if isinstance(visits, (int, float)) and 0 < visits < 1e12:
            return TrafficResult("ok", int(visits))
        return TrafficResult("empty")  # 0 或缺字段：太小站点的占位，不算抓到数据

    def seconds_until_budget(self, *, now: float | None = None) -> float | None:
        """出口池还要等多少秒才有可用额度（0=现在就有；没有池子返回 None）。

        补采循环用它决定「睡多久再试」：取各出口里最早回补的一个——预算用满的等窗口
        里最早那次请求滑出去，被冻结的等停用期结束。
        """
        if not self._pool:
            return None
        now = now if now is not None else time.time()
        waits: list[float] = []
        for node in self._pool:
            avoid = self._avoid_until.get(node, 0.0) - now
            recent = sorted(at for at in self._used.get(node, []) if now - at < SW_WINDOW_SECONDS)
            if len(recent) >= SW_WINDOW_BUDGET:
                waits.append(max(0.0, recent[-SW_WINDOW_BUDGET] + SW_WINDOW_SECONDS - now))
            else:
                waits.append(max(0.0, avoid))
        return min(waits) if waits else None

    def visits_with_retry(self, domain: str, host_label: str) -> TrafficResult:
        """拿月访问量：出口池里被限流的出口冻结换下一个；上游没数据不重试。

        出口池用尽（全部停用或超出窗口预算）返回 blocked，由调用方按「本轮没采到」处理，
        下轮定时采集会再轮到。
        """
        self._ensure_pool()
        if not self._pool:
            result = self._request(domain, self._proxy)
            if result.kind == "blocked" and self._proxy:
                result = self._request(domain, None)  # SimilarWeb 拒本机直连 IP，直连只是兜底
            return result
        for _ in range(SW_MAX_ATTEMPTS):
            now = time.time()
            node = self._pick_node(now)
            if node is None:
                if not self._exhausted_note:
                    self._exhausted_note = True
                    tasklog.emit("SimilarWeb 出口全部停用或超出窗口预算，剩下的站下轮自动补", "warn")
                return TrafficResult("blocked")
            if node != self._selected:
                if not proxy_switch.select_node(node):
                    self._avoid_until[node] = now + SW_ERROR_COOLDOWN_SECONDS
                    continue
                self._selected = node
            result = self._request(domain, self._proxy)
            self._used.setdefault(node, []).append(time.time())
            if result.settled:
                return result
            self._retire(node, result, host_label)
        return TrafficResult("blocked")


# ---- 外部源新鲜度：两个源各自结算，有值 7 天复查、确认无数据 30 天复查 ----


def _within(ts: Any, ttl: float, now: float) -> bool:
    """这个时刻在 ttl 秒之内；缺失/异常值按「不在」处理。"""
    try:
        return now - float(ts) < ttl
    except (TypeError, ValueError):
        return False


def visits_current(traffic: dict[str, Any], *, now: float) -> bool:
    """访问量已有结论且没到复查期（SimilarWeb 给值或确认没数据；hypestat 的估算同样算数）。"""
    if not isinstance(traffic, dict):
        return False
    ttl = VALUE_RECHECK_SECONDS if traffic.get("monthly_visits") else EMPTY_RECHECK_SECONDS
    return _within(traffic.get("visits_checked_at"), ttl, now)


def rank_current(traffic: dict[str, Any], *, now: float) -> bool:
    """Tranco 排名已有结论且没到复查期。"""
    if not isinstance(traffic, dict):
        return False
    ttl = VALUE_RECHECK_SECONDS if traffic.get("rank") else EMPTY_RECHECK_SECONDS
    return _within(traffic.get("rank_checked_at"), ttl, now)


def needs_query(entry: dict[str, Any] | None, *, now: float | None = None) -> bool:
    """这个站还有没有值得打的外部源（SimilarWeb/Tranco）？管理页「待补」与整轮跳过都用它。

    两个外部源各自结算：拿到值、或一个月内确认过上游没有这个站的数据，就算结了；
    有值的按 7 天复查（SimilarWeb 月更、Tranco 日更，周更足够）。任一源没结就得查——
    限流环境里额度优先花在「还没数据」和「数据变旧」的站上，确认过没数据的不白跑。
    """
    if not isinstance(entry, dict):
        return True
    now = now if now is not None else time.time()
    traffic = entry.get("traffic") if isinstance(entry.get("traffic"), dict) else {}
    return not (visits_current(traffic, now=now) and rank_current(traffic, now=now))


def collect_site(
    spec: SiteSpec,
    client: httpx.Client,
    *,
    notice_text: str = "",
    similarweb: "SimilarWebClient | None" = None,
    previous: dict[str, Any] | None = None,
    force: bool = False,
) -> dict[str, Any] | None:
    """采集单站人气；站点接口、首页、已存公告三个来源全空时返回 None（保留旧数据）。

    notice_text 是 store 里该站最近一条公告正文：公告是群号的高产来源（"加入 QQ 群 …"），
    顺带扫描比再打一次公告接口便宜。previous 是该站上一轮的写库数据：两个外部源（Tranco /
    SimilarWeb）各自到复查期才重查（见 visits_current / rank_current），群链接仍照常扫描
    （站点接口与首页本来就是本轮要打的，只省外部源）；force=True 无视复查期全查。
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
        previous_traffic = previous.get("traffic") if isinstance(previous, dict) else None
        old = previous_traffic if isinstance(previous_traffic, dict) else {}
        now = time.time()
        traffic = fetch_traffic(
            host,
            spec.id,
            client,
            similarweb,
            previous_traffic,
            want_visits=force or not visits_current(old, now=now),
            want_rank=force or not rank_current(old, now=now),
        )
    return {"groups": groups, "traffic": traffic, "checked_at": time.time()}


def fetch_traffic(
    host: str,
    host_label: str,
    client: httpx.Client,
    similarweb: "SimilarWebClient | None",
    previous_traffic: dict[str, Any] | None,
    *,
    want_visits: bool,
    want_rank: bool,
) -> dict[str, Any]:
    """查两个外部源（SimilarWeb/hypestat 访问量、Tranco 排名），查哪几个由调用方指定。

    want_* 由调用方按「复查期 + 本轮是否已结算」算好（整轮采集见 collect_site，补采见
    owed_sources）：这样补采只补还欠的源，不会把已结算的源重复查一遍白烧额度。
    返回 traffic 片段（本轮的新结论）；都没查时返回空 dict。
    """
    traffic: dict[str, Any] = {}
    if want_visits:
        # 月访问量：SimilarWeb 站内 API 是主源（覆盖面广、真实统计；请求按出口池分散，
        # 被限流的出口自动冻结换下一个），SW 没给值再退 hypestat 公开页估算（覆盖面小）；
        # 上游明确没数据时记一次结论（一个月内不重查），查询失败则不记、下轮接着试
        result = similarweb.visits_with_retry(host, host_label) if similarweb is not None else None
        visits: int | None = None
        visits_source = ""
        if result is not None and result.kind == "ok":
            visits, visits_source = result.visits, "similarweb"
        else:
            visits = fetch_visits_estimate(host, client)
            visits_source = "hypestat" if visits else ""
        if visits:
            traffic.update({"monthly_visits": visits, "visits_source": visits_source, "visits_checked_at": time.time()})
        elif result is not None and result.settled:
            traffic["visits_checked_at"] = time.time()
    if want_rank:
        # Tranco 有速率限制：两次查询之间拉开间隔（保证跨站点也生效）
        time.sleep(TRANCO_INTERVAL_SECONDS)
        rank = fetch_tranco_rank(host, client)
        if rank.rank is not None:
            traffic.update({"rank": rank.rank, "rank_source": "tranco", "rank_checked_at": time.time()})
        elif rank.settled:
            traffic["rank_checked_at"] = time.time()
    return traffic


def _merge_traffic(previous: dict[str, Any], fresh: dict[str, Any]) -> dict[str, Any]:
    """字段逐个合并：本轮拿到的覆盖旧的，拿不到的保留旧值（防一次抖动清空）；
    每个源的「结论时间」跟值一起走，updated_at 只在数字真变化时刷新。"""
    merged = dict(previous)
    refreshed = False
    for key in ("monthly_visits", "visits_source", "visits_checked_at", "rank", "rank_source", "rank_checked_at"):
        value = fresh.get(key)
        if value is None:
            continue
        merged[key] = value
        if key in ("monthly_visits", "rank"):
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


def record_traffic(store, site_id: str, traffic: dict[str, Any]) -> None:
    """只把外部源的新结论合并进该站记录（窗口回补后的补采用）。

    不动群链接、也不动 checked_at（那是站点侧取数时间）：补采只补外部源，页面上的
    「上次取数」不该被它改写。
    """
    if not traffic:
        return
    doc = dict(store.get_document(POPULARITY_DOC) or {})
    previous = doc.get(site_id) if isinstance(doc.get(site_id), dict) else {}
    entry = dict(previous)
    entry["traffic"] = _merge_traffic(previous.get("traffic") or {}, traffic)
    doc[site_id] = entry
    store.set_document(POPULARITY_DOC, doc)


def remove_popularity(store, site_id: str) -> None:
    """删站清理：摘掉该站的人气记录。"""
    doc = dict(store.get_document(POPULARITY_DOC) or {})
    if site_id in doc:
        doc.pop(site_id)
        store.set_document(POPULARITY_DOC, doc)


def _entry_traffic(doc: dict[str, Any], site_id: str) -> dict[str, Any]:
    entry = doc.get(site_id) if isinstance(doc.get(site_id), dict) else {}
    traffic = entry.get("traffic")
    return traffic if isinstance(traffic, dict) else {}


def _entry_groups(doc: dict[str, Any], site_id: str) -> list[Any]:
    entry = doc.get(site_id) if isinstance(doc.get(site_id), dict) else {}
    groups = entry.get("groups")
    return groups if isinstance(groups, list) else []


def _write_with_retry(action, *args, attempts: int = 3) -> bool:
    """写库遇到「database is locked」重试几次；仍失败返回 False（调用方留痕、继续下一站）。

    正常只有调度线程一个写者，但并行跑采集（dev 里常见）或别的进程在写大文档时，
    单次写会被占住——整轮人气采集不该被一次写库繁忙搞死。
    """
    for attempt in range(attempts):
        try:
            action(*args)
            return True
        except sqlite3.OperationalError as exc:
            if "locked" not in str(exc) or attempt == attempts - 1:
                if "locked" not in str(exc):
                    raise
                return False
            time.sleep(1.5 * (attempt + 1))
    return False


def _settled_since(ts: Any, since: float) -> bool:
    """这个源的结论是在 since 之后（含）拿到的吗？补采用它区分「本轮查过」与「旧值还在」。"""
    try:
        return float(ts) >= since
    except (TypeError, ValueError):
        return False


def owed_sources(
    traffic: dict[str, Any],
    due: tuple[bool, bool] | None,
    *,
    since: float,
    now: float | None = None,
) -> tuple[bool, bool]:
    """这个站本轮还欠哪些源（访问量, 排名）。

    due 是轮次开始时「该查哪些源」的快照（force 轮全 True），since 是本轮开始时刻：
    该查、但结论时间早于 since（还是旧值或压根没有）→ 欠着。不传 due 按复查期现算。
    """
    now = now if now is not None else time.time()
    want_visits, want_rank = due if due is not None else (
        not visits_current(traffic, now=now),
        not rank_current(traffic, now=now),
    )
    return (
        want_visits and not _settled_since(traffic.get("visits_checked_at"), since),
        want_rank and not _settled_since(traffic.get("rank_checked_at"), since),
    )


def pending_traffic(
    store,
    config,
    *,
    since: float = 0.0,
    due: dict[str, tuple[bool, bool]] | None = None,
) -> list[tuple[Any, dict[str, Any]]]:
    """还没拿到外部结论的站（有可查域名，且该查的源没在本轮结算）。

    due 是「本轮该查哪些源」的快照（site_id → (查访问量, 查排名)）：force 全量刷新时
    所有源都算该查，靠 `since`（本轮开始时刻）区分「本轮查过了」与「旧值还在复查期内」——
    只看新鲜度会把「本轮没轮到」误判成「不缺数据」。不传 due 就按复查期现算。
    主轮跑完与补采每一轮结束后都用它重算：拿到本轮结论的站自动出列。
    """
    doc = store.get_document(POPULARITY_DOC) or {}
    now = time.time()
    pending: list[tuple[Any, dict[str, Any]]] = []
    for spec in config.sites:
        if not site_host(spec):
            continue  # 没有可查域名（纯 IP 站等）：补采无从下手
        traffic = _entry_traffic(doc, spec.id)
        want_visits, want_rank = owed_sources(traffic, (due or {}).get(spec.id), since=since, now=now)
        if want_visits or want_rank:
            pending.append((spec, traffic))
    return pending


def topup_pending(
    store,
    config,
    similarweb: SimilarWebClient,
    client: httpx.Client,
    stats: dict[str, int],
    *,
    since: float = 0.0,
    due: dict[str, tuple[bool, bool]] | None = None,
) -> None:
    """窗口回补后的自动补采：把本轮没拿到外部结论的站接着补，直到都有结论或超出上限。

    SimilarWeb 的出口额度按窗口回补，主轮跑完往往还剩几个站没轮到（手动全量刷新时尤其
    明显）。这里按出口池给出的「还有多久有额度」等窗口回补，再补一轮，最多补
    POPULARITY_TOPUP_SECONDS；到点还没补完的留给下轮定时采集（待补站下轮排最前）。
    补采只动外部源：群链接不重扫，页面的「上次取数」也不改写。
    """
    pending = pending_traffic(store, config, since=since, due=due)
    if not pending:
        return
    deadline = time.time() + POPULARITY_TOPUP_SECONDS
    tasklog.emit(
        f"主轮结束仍有 {len(pending)} 站缺外部数据，等出口额度回补后自动补采（最多 {int(POPULARITY_TOPUP_SECONDS / 60)} 分钟）"
    )
    stalls = 0
    while pending and time.time() < deadline:
        wait = similarweb.seconds_until_budget()
        if wait is None:
            tasklog.emit(f"没有可轮换的出口，剩余 {len(pending)} 站留给下轮定时采集", "warn")
            return
        if wait > 0:
            if time.time() + wait > deadline:
                tasklog.emit(f"出口额度回补还要 {int(wait)} 秒、超出本轮补采上限，剩余 {len(pending)} 站下轮自动补", "warn")
                return
            time.sleep(min(wait + 1.0, 300.0))
        progressed = 0
        for spec, traffic in pending:
            host = site_host(spec)
            # 只补还欠的源：已在本轮结算的源不重复查（否则额度全耗在无意义的重试上）
            want_visits, want_rank = owed_sources(traffic, (due or {}).get(spec.id), since=since)
            try:
                fresh = fetch_traffic(host, spec.id, client, similarweb, traffic, want_visits=want_visits, want_rank=want_rank)
            except Exception as exc:  # noqa: BLE001 —— 补采单站异常不打断循环，留痕后继续
                tasklog.emit(f"[{spec.id}] 补采异常：{exc}", "warn")
                continue
            if not fresh:
                continue
            if not _write_with_retry(record_traffic, store, spec.id, fresh):
                tasklog.emit(f"[{spec.id}] 补采写库失败（数据库繁忙），下轮自动补", "warn")
                continue
            stats["topped_up"] += 1
            progressed += 1
            # 日志只说本轮补到了什么（旧值不重复报）
            parts = []
            if fresh.get("monthly_visits"):
                parts.append(f"月访问量约 {fresh['monthly_visits']}")
            elif fresh.get("visits_checked_at"):
                parts.append("上游确认没有访问量数据")
            if fresh.get("rank"):
                parts.append(f"全网排名 {fresh['rank']}")
            elif fresh.get("rank_checked_at"):
                parts.append("Tranco 未收录")
            tasklog.emit(f"[{spec.id}] 补采：{'，'.join(parts)}")
        pending = pending_traffic(store, config, since=since, due=due)
        if progressed == 0:
            stalls += 1
            if stalls >= 2:
                tasklog.emit(f"补采连续 {stalls} 轮没有新结论，剩余 {len(pending)} 站下轮自动补", "warn")
                return
        else:
            stalls = 0
    if pending:
        tasklog.emit(f"补采到时间上限，剩余 {len(pending)} 站下轮自动补", "warn")
    else:
        tasklog.emit("补采完成：本轮所有站的外部数据都拿到了结论")


def popularity_order_key(*, needs_query: bool, checked_at: float | None, site_id: str) -> tuple[bool, float, str]:
    """人气管理页展示序与整轮采集序共用的排序键：待补在前，然后按上次取数新→旧。"""
    return (not needs_query, -(checked_at or 0), site_id)


def scan_order(sites, popularity_doc: dict[str, Any], *, now: float | None = None) -> list:
    """采集顺序：待补的站排前面（与管理页默认列表一致），其余按上次取数新→旧。

    额度有限时先照顾缺数据/数据变旧的站；这个顺序写进任务日志，页面列表能直接对照。
    """
    now = now if now is not None else time.time()

    def key(spec):
        entry = popularity_doc.get(spec.id)
        checked_at = entry.get("checked_at") if isinstance(entry, dict) else None
        return popularity_order_key(needs_query=needs_query(entry, now=now), checked_at=checked_at, site_id=spec.id)

    return sorted(sites, key=key)


def scan_popularity(
    config,
    store,
    *,
    client: httpx.Client | None = None,
    user_agent: str | None = None,
    force: bool = False,
) -> dict[str, int]:
    """逐站采集一轮人气：全部站点（含未启用，选站要用），按管理页的「待补在前」顺序，
    单站失败记日志继续下一站。

    每个外部源（Tranco / SimilarWeb）各自按复查期决定重查：有值 7 天、确认上游没数据 30 天；
    force=True（手动全量刷新）无视复查期逐站全查。SimilarWeb 请求按采集出口池分散
    （见 SimilarWebClient）：被限流的出口冻结换下一个；主轮跑完还剩没拿到结论的站，
    等出口额度回补自动补采（topup_pending，上限 POPULARITY_TOPUP_SECONDS），补不完的
    留给下轮定时采集（待补站下轮排最前）。

    返回 {sites, groups, visits, ranked, failed, skipped, topped_up} 计数；
    visits/ranked/groups 是「本轮结束时库内的站数/群数」，补采的成果也算进去。
    """
    owns_client = client is None
    if client is None:
        client = build_client(
            timeout=15, headers={"User-Agent": user_agent or DEFAULT_BROWSER_USER_AGENT}
        )
    stats = {"sites": 0, "groups": 0, "visits": 0, "ranked": 0, "failed": 0, "skipped": 0, "topped_up": 0}
    popularity_doc = dict(store.get_document(POPULARITY_DOC) or {})
    pending = sum(1 for spec in config.sites if needs_query(popularity_doc.get(spec.id)))
    tasklog.emit(
        "开始站点人气采集"
        + (f"（手动全量刷新）" if force else f"（{pending} 个站有数据要补，其余站按复查期跳过外部查询）")
    )
    # 本轮该查哪些源（补采用）：force 全量刷新时所有源都算该查，靠轮次开始时刻区分
    # 「本轮查过了」与「旧值还在复查期内」
    round_start = time.time()
    due = {
        spec.id: (
            force or not visits_current(_entry_traffic(popularity_doc, spec.id), now=round_start),
            force or not rank_current(_entry_traffic(popularity_doc, spec.id), now=round_start),
        )
        for spec in config.sites
    }
    # SimilarWeb 站内 API 的 WAF 按出口 IP 计额度：整轮共用一个轻客户端（独立于采集 client，
    # 不走退避重试），由它按出口池轮换节点、冻结被限流的出口
    similarweb = SimilarWebClient(user_agent or DEFAULT_BROWSER_USER_AGENT)
    try:
        for spec in scan_order(config.sites, popularity_doc):
            stats["sites"] += 1
            notice = store.latest_notice(spec.id) or {}
            notice_text = str(notice.get("content") or "")
            previous = popularity_doc.get(spec.id) if isinstance(popularity_doc.get(spec.id), dict) else None
            try:
                payload = collect_site(spec, client, notice_text=notice_text, similarweb=similarweb, previous=previous, force=force)
            except Exception as exc:  # noqa: BLE001 —— 单站异常不拖垮整轮，但必须留痕
                stats["failed"] += 1
                tasklog.emit(f"[{spec.id}] 人气采集失败：{exc}", "warn")
                continue
            if payload is None:
                stats["failed"] += 1
                tasklog.emit(f"[{spec.id}] 人气采集失败：站点接口、首页都打不开且没有已存公告，保留旧数据", "warn")
                continue
            if not _write_with_retry(record_popularity, store, spec.id, payload):
                stats["failed"] += 1
                tasklog.emit(f"[{spec.id}] 人气写库失败（数据库繁忙），保留旧数据、下轮重来", "warn")
                continue
            groups = payload.get("groups") or []
            traffic = payload.get("traffic") or {}
            # 跳过复查的站沿用上轮数字：日志按合并后的实际值打印（本轮新值优先）
            old_traffic = (previous or {}).get("traffic") if isinstance(previous, dict) else {}
            shown = _merge_traffic(old_traffic if isinstance(old_traffic, dict) else {}, traffic)
            if not force and previous is not None and not needs_query(previous):
                stats["skipped"] += 1
            detail = "，".join(group["label"] for group in groups) or "未发现交流群"
            tasklog.emit(
                f"[{spec.id}] 人气：{detail}"
                + (f"，月访问量约 {shown['monthly_visits']}" if shown.get("monthly_visits") else "")
                + (f"，全网排名 {shown['rank']}" if shown.get("rank") else "")
            )
        topup_pending(store, config, similarweb, client, stats, since=round_start, due=due)
        final_doc = store.get_document(POPULARITY_DOC) or {}
        stats["visits"] = sum(1 for spec in config.sites if _entry_traffic(final_doc, spec.id).get("monthly_visits"))
        stats["ranked"] = sum(1 for spec in config.sites if _entry_traffic(final_doc, spec.id).get("rank"))
        stats["groups"] = sum(len(_entry_groups(final_doc, spec.id)) for spec in config.sites)
        tasklog.emit(
            f"站点人气采集结束：{stats['sites']} 站（跳过外部复查 {stats['skipped']} 站，"
            f"窗口回补后补采 {stats['topped_up']} 站），交流群 {stats['groups']} 个，"
            f"月访问量 {stats['visits']} 站，排名 {stats['ranked']} 站，失败 {stats['failed']} 站"
        )
    finally:
        if owns_client:
            client.close()
    return stats
