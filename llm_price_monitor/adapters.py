"""价格采集适配器：直接请求配置的价格接口并计算价格记录。

不启动浏览器、不读 DOM；New API/One API 响应走确定性计价，
HTML 页面内嵌价格表按结构特征识别，命中目标模型即确定性计价，
其余响应在配置了 AI 时交给 AIPriceExtractor。
"""
from __future__ import annotations

import json
import re
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol
from urllib.parse import urljoin

import httpx

from llm_price_monitor import tasklog
from llm_price_monitor.ai import AIExtractionError, AIPriceExtractor
from llm_price_monitor.config import (
    ACCESS_TOKEN_VAR,
    AIConfig,
    REFRESH_TOKEN_VAR,
    PriceMonitorError,
    SiteSpec,
)
from llm_price_monitor.evidence import is_preferred_response_url, payload_hash, redact_url
from llm_price_monitor.matching import resolve_site_names, version_omitted_match
from llm_price_monitor.tracker import (
    GroupRatioUnavailableError,
    PriceRecord,
    looks_like_newapi_pricing,
    looks_like_platform_pricing,
    newapi_denomination_from_status,
    newapi_price_record,
)

class Adapter(Protocol):
    def collect(
        self,
        spec: SiteSpec,
        client: httpx.Client,
        timeout: float,
        user_agent: str,
        ai: AIConfig | None = None,
    ) -> list[PriceRecord]: ...


def headers(spec: SiteSpec, user_agent: str) -> dict[str, str]:
    """站点级静态请求头（request_headers + UA）。

    凭证与 Cookie 都不在这里：凭证由 auth_inject_headers 按采集目标注入，
    Cookie 属于普通静态头，直接写进 request_headers。
    """
    return {**spec.request_headers, "user-agent": user_agent}


def auth_inject_headers(spec: SiteSpec, target: str) -> dict[str, str]:
    """按「认证与续签」里配的规则，把凭证展开成该采集目标的请求头（target 见 AUTH_INJECT_TARGETS）。

    没配 auth_inject 的老配置按老行为注入 Authorization: Bearer <token>，
    存量站点不改配置就能继续跑。值里的 ${access_token}/${refresh_token} 展开成当前凭证，
    其余文本原样保留（不认环境变量，占位符只有这两个）。

    还没拿到 Access Token 的站点（新站点或刚清空）不注入：请求照常发出、由 401 触发续签补上，
    否则这条"空凭证 → 采集 → 续签"的引导链会被自己拦死。
    """
    rules = spec.auth_inject or {}
    if not rules:
        legacy = _legacy_auth_rule(spec)
        rules = {target: legacy} if legacy else {}
    rule = rules.get(target)
    if not isinstance(rule, dict):
        return {}
    header = str(rule.get("header") or "").strip()
    if not header:
        return {}
    value = str(rule.get("value") or "")
    if ACCESS_TOKEN_VAR in value and not spec.auth_token:
        return {}
    return {header: _expand_credential_vars(spec, value)}


def _legacy_auth_rule(spec: SiteSpec) -> dict[str, str] | None:
    """auth_inject 出现之前的行为：站点有 auth_token 就注入 Authorization: Bearer <token>。"""
    if not spec.auth_token:
        return None
    return {"header": "Authorization", "value": f"Bearer {ACCESS_TOKEN_VAR}"}


def _expand_credential_vars(spec: SiteSpec, value: str) -> str:
    """${access_token}/${refresh_token} → 当前凭证值；引用不到的凭证明确报错，不静默发空值。"""
    if ACCESS_TOKEN_VAR in value:
        value = value.replace(ACCESS_TOKEN_VAR, spec.auth_token or "")
    if REFRESH_TOKEN_VAR in value:
        refresh_token = str((spec.token_refresh or {}).get("refresh_token") or "")
        if not refresh_token:
            raise PriceMonitorError(
                f"站点 {spec.id} 的凭证注入引用了 {REFRESH_TOKEN_VAR}，但当前认证方式没有 Refresh Token（只有「登录会话自动续签」才有）"
            )
        value = value.replace(REFRESH_TOKEN_VAR, refresh_token)
    return value


def response_error_detail(response: httpx.Response, limit: int = 120) -> str:
    """HTTP 失败时从响应体提取可读原因：优先 new-api 系 JSON 的 message/error 字段，否则截取正文开头。"""
    try:
        payload = response.json()
    except ValueError:
        payload = None
    text = ""
    if isinstance(payload, dict):
        for key in ("message", "error", "detail", "msg"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                text = value.strip()
                break
    if not text:
        text = (response.text or "").strip()
    text = " ".join(text.split())
    if text.startswith("<"):
        # HTML 响应（常见为 Cloudflare 拦截页）：正文片段只是标签噪音，取标题即可看出是谁在拦
        title = re.search(r"<title[^>]*>(.*?)</title>", text, re.IGNORECASE | re.DOTALL)
        return f"HTML 页面：{title.group(1).strip()[:80]}" if title else "HTML 页面（可能是防护拦截或错误页）"
    return text[:limit]


def http_error_message(label: str, response: httpx.Response, *, auth_hint: bool = False) -> str:
    """HTTP 失败的可读报错：状态码 + 响应体真实原因 + 脱敏请求地址，替代笼统的"可能需要认证"。"""
    detail = response_error_detail(response)
    msg = f"{label}返回 HTTP {response.status_code}"
    if detail:
        msg += f"：{detail}"
    if auth_hint and response.status_code in {401, 403}:
        msg += "，可能需要认证"
    msg += f"（请求 {redact_url(str(response.url))}）"
    return msg


@dataclass(frozen=True)
class EndpointRequest:
    """单个价格数据入口的请求参数（standard 的 network 与附加 networks 共用）。"""

    url: str
    params: dict[str, Any] = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)


def resolve_endpoint(value: Any, *, spec: SiteSpec, label: str) -> EndpointRequest:
    """入口配置（URL 字符串或请求配置对象）→ GET 请求参数；label 形如 "network.url"，用于报错定位。"""
    if isinstance(value, str):
        if not value.strip():
            raise PriceMonitorError(f"站点 {spec.id} 的 {label} 必须是非空 URL")
        return EndpointRequest(url=value.strip())
    if not isinstance(value, dict):
        raise PriceMonitorError(f"站点 {spec.id} 的 {label} 必须是 URL 字符串或请求配置对象")
    url = value.get("url")
    if not isinstance(url, str) or not url.strip():
        raise PriceMonitorError(f"站点 {spec.id} 的 {label}.url 必须是非空 URL")
    params = value.get("params", {})
    extra_headers = value.get("headers", {})
    if not isinstance(params, dict) or not isinstance(extra_headers, dict):
        raise PriceMonitorError(f"站点 {spec.id} 的 {label}.params 和 {label}.headers 必须是对象")
    return EndpointRequest(
        url=url.strip(),
        params=params,
        headers=extra_headers,
    )


def build_request_kwargs(
    entry: EndpointRequest, spec: SiteSpec, user_agent: str, timeout: float, *, target: str
) -> dict[str, Any]:
    """站点级认证/Cookie 头与入口级 headers 合成 httpx 请求参数。

    凭证注入的头（见 auth_inject_headers）最后落地，且入口级 headers 里的同名头一律让位：
    接口里写死的旧 token 会盖回旧值、续签换新也追不上，认证只走「认证与续签」一处。
    """
    injected = auth_inject_headers(spec, target)
    shadowed = {name.casefold() for name in injected} | ({"authorization"} if spec.auth_token else set())
    request_headers = headers(spec, user_agent)
    request_headers.update({
        str(key): str(value)
        for key, value in entry.headers.items()
        if str(key).casefold() not in shadowed
    })
    request_headers.update(injected)
    # 空 params 不能传给 httpx：0.28 起 params={} 会整体替换 URL 查询串，
    # 把写在 URL 里的 page_size/过滤参数悄悄清掉（httpx.Request 实测）
    kwargs: dict[str, Any] = {"headers": request_headers, "timeout": timeout}
    if entry.params:
        kwargs["params"] = entry.params
    return kwargs


def auth_required_records(spec: SiteSpec, message: str, source_url: str | None = None) -> list[PriceRecord]:
    targets = list(spec.models)
    source_url = source_url or str(spec.network.get("url") or "")
    metadata = {"pricing_kind": "auth_required", "currency": "CNY", "error": message}
    return [
        PriceRecord(
            target.name,
            None,
            None,
            "CNY/1M tokens",
            source_url,
            time.time(),
            metadata,
            "unavailable",
            True,
        )
        for target in targets
    ]


def _newapi_item(data: list[dict[str, Any]], model_name: str | None) -> dict[str, Any] | None:
    """data[] 里按 model_name 取条目（大小写不敏感）；model_name 为空表示没匹配到。"""
    if not model_name:
        return None
    folded = model_name.casefold()
    return next(
        (value for value in data if str(value.get("model_name", "")).casefold() == folded),
        None,
    )


def _newapi_denomination(client: httpx.Client, pricing_url: str, timeout: float) -> dict[str, Any] | None:
    """读站点 /api/status 的充值口径声明（price × quota_per_unit）；任何失败都回落 None。

    v1 的 /api/pricing 载荷自身不带计价声明，而各站充值汇率差 7 倍
    （AIHub365 price=6.8，多数中文站 price=1），不读就会把美元站价格整体低算。
    status 是 new-api 启动必有的公开接口，拿不到字段说明不是 new-api 或站方未声明，
    维持默认基准价并留痕。采集地址不一定是 /api/pricing（subrouter 是 marketplace
    路径），所以优先剥 /api/pricing 后缀，剥不出就退回 URL 起源。
    """
    url = str(pricing_url)
    base = url.split("/api/pricing", 1)[0] if "/api/pricing" in url else ""
    if not base.startswith(("http://", "https://")):
        match = re.match(r"^(https?://[^/]+)", url)
        base = match.group(1) if match else ""
    if not base:
        return None
    try:
        response = client.get(f"{base}/api/status", timeout=timeout)
        if not response.is_success:
            return None
        return newapi_denomination_from_status(response.json())
    except Exception:
        return None


def network_pricing_records(
    spec: SiteSpec,
    captured: list[dict[str, Any]],
    resolved_aliases: dict[str, tuple[str, ...]] | None = None,
    denomination: dict[str, Any] | None = None,
) -> list[PriceRecord]:
    """只用 HTTP JSON 响应计算价格；支持 New API 和字段映射响应。

    `denomination` 是站点 /api/status 的充值口径声明（见 _newapi_denomination），
    传进来用于修正 v1 载荷的倍率基准价；None 时按默认基准计价。
    metadata.adapter 标签只描述「价格怎么解析出来的」，与采集是否走了浏览器无关
    （"browser" 是历史命名：证据结构沿用了浏览器捕获事件的格式，实际可能纯 HTTP）：
    - browser_network：直采解析成功（new-api JSON，或 HTML 里内嵌的价格表）
    - network：拿到了 new-api JSON 但没解析出目标价格
    - browser_ai：AI 从页面文本提取成功（见 ai.py AIPriceExtractor）
    """
    response_source_url = str(captured[0].get("url") or "") if captured else str(spec.network.get("url") or "")
    ordered = sorted(
        captured,
        key=lambda item: (
            not is_preferred_response_url(str(item.get("url", ""))),
        ),
    )
    records: dict[str, PriceRecord] = {}
    attempted_groups: dict[str, set[str | None]] = {}
    failures: dict[str, list[str]] = {}
    for response in ordered:
        payload = response.get("payload")
        if not isinstance(payload, dict):
            continue
        data = [value for value in payload.get("data", []) if isinstance(value, dict)]
        targets = list(spec.models)
        for target in targets:
            attempted_groups.setdefault(target.name, set())
            failures.setdefault(target.name, [])
        # 目标名 → 该目标可接受的名字（标准名 + AI 别名）；站点侧名字按精确优先、
        # 版本号省略兜底分配到目标，歧义时不给匹配，避免把别的版本的价格挂上来
        accepted = {
            target.name: (target.name, *(resolved_aliases or {}).get(target.name, ()))
            for target in targets
        }
        matched = resolve_site_names(
            [str(value.get("model_name", "")) for value in data if str(value.get("model_name", ""))],
            accepted,
        )
        for target in targets:
            site_name = matched.get(target.name)
            if site_name is None:
                # 宁缺勿猜被触发的要留痕：管理台看到的失败原因不能是笼统的"未捕获响应"。
                # 两种歧义都写明站点上撞名的是谁：AI 别名多命中 / 站点同时挂同族多版本。
                accepted_keys = {name.casefold() for name in accepted[target.name]}
                hits = sorted({
                    str(value.get("model_name", "")) for value in data
                    if str(value.get("model_name", "")).casefold() in accepted_keys
                })
                if len(hits) > 1:
                    failures[target.name].append(
                        f"候选名同时命中站点 {len(hits)} 个模型（{'、'.join(hits)}），宁缺勿猜不采信"
                    )
                else:
                    same_family = sorted({
                        str(value.get("model_name", "")) for value in data
                        if version_omitted_match(str(value.get("model_name", "")).casefold(), target.name)
                    })
                    if len(same_family) > 1:
                        failures[target.name].append(
                            f"站点同时挂着同族 {len(same_family)} 个版本（{'、'.join(same_family)}），"
                            f"无法确定哪个对应 {target.name}，宁缺勿猜不采信"
                        )
                continue
            item = _newapi_item(data, site_name)
            if item is None:
                continue
            enabled = [name for name in item.get("enable_groups", []) if isinstance(name, str) and name]
            groups = enabled or ["default"]
            aliases = tuple(dict.fromkeys((*accepted[target.name], *([site_name] if site_name else []))))
            for selected_group in dict.fromkeys(groups):
                record_key = f"{target.name}:{selected_group or ''}"
                if record_key in records:
                    continue
                try:
                    record = newapi_price_record(
                        payload,
                        target.name,
                        str(response.get("url") or ""),
                        group=selected_group,
                        aliases=aliases,
                        denomination=denomination,
                    )
                except GroupRatioUnavailableError:
                    # 站点未公开该分组倍率，无法计价，直接不输出该分组。
                    continue
                except ValueError as exc:
                    attempted_groups[target.name].add(selected_group)
                    failures[target.name].append(str(exc))
                    continue
                attempted_groups[target.name].add(selected_group)
                metadata = dict(record.metadata or {})
                metadata.update({
                    "adapter": "browser_network",
                    "network_evidence": [{
                        "source": "model_list",
                        "url": redact_url(str(response.get("url", ""))),
                        "resource_type": response.get("resource_type"),
                        "status": response.get("status"),
                        "payload_sha256": payload_hash(payload),
                    }],
                    "page_evidence": [],
                })
                if site_name and site_name.casefold() != target.name.casefold():
                    metadata["matched_model_name"] = site_name
                record.metadata = metadata
                records[record_key] = record
    for target in list(spec.models):
        groups = attempted_groups.get(target.name) or {"default"}
        for selected_group in groups:
            record_key = f"{target.name}:{selected_group or ''}"
            if record_key in records:
                continue
            reason = "; ".join(dict.fromkeys(failures.get(target.name, []))) or "未捕获可识别的 one-api/new-api 定价 JSON 响应"
            records[record_key] = PriceRecord(
                target.name,
                None,
                None,
                "CNY/1M tokens",
                response_source_url,
                time.time(),
                {
                    "adapter": "network",
                    "pricing_kind": "unavailable",
                    "group": selected_group,
                    "currency": "CNY",
                    "network_evidence": [],
                    "page_evidence": [],
                    "notes": reason,
                },
                "unavailable",
            )
    return list(records.values())

def _plain_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def platform_pricing_records(spec: SiteSpec, captured: list[dict[str, Any]]) -> list[PriceRecord]:
    """确定性解析 platforms/supported_models 结构，两种同族形态：

    - totokens 型：pricing.final_prices 按分组展开的每 token 单价，×1,000,000 换算 CNY/1M tokens，
      接口不标币种按系统约定回落人民币；input/output 齐全为 confirmed，缺一为 candidate。
    - sub2api channels/available 型：pricing 直接带每 token 的 input_price/output_price，
      sub2api 系证据格式为美元，组倍率是否已计入未标明，一律标 candidate 待复核。
    """
    response_source_url = str(captured[0].get("url") or "") if captured else str(spec.network.get("url") or "")
    payload = captured[0].get("payload") if captured else None
    if isinstance(payload, dict):
        payload = payload.get("data")
    buckets = payload if isinstance(payload, list) else []
    records: dict[tuple[str, str], PriceRecord] = {}

    def evidence(notes: str, currency: str) -> dict[str, Any]:
        return {
            "adapter": "network",
            "pricing_kind": "explicit_price",
            "currency": currency,
            "network_evidence": [{
                "source": "model_list",
                "url": redact_url(str(captured[0].get("url", ""))),
                "resource_type": captured[0].get("resource_type"),
                "status": captured[0].get("status"),
                "payload_sha256": payload_hash(payload),
            }],
            "page_evidence": [],
            "notes": notes,
        }

    for item in buckets:
        platforms = item.get("platforms") if isinstance(item, dict) else None
        if not isinstance(platforms, list):
            continue
        for platform in platforms:
            if not isinstance(platform, dict):
                continue
            models = platform.get("supported_models")
            if not isinstance(models, list):
                continue
            platform_groups = [
                str(group.get("name"))
                for group in platform.get("groups", [])
                if isinstance(group, dict) and isinstance(group.get("name"), str) and group.get("name")
            ]
            for model in models:
                if not isinstance(model, dict):
                    continue
                target = next(
                    (t for t in spec.models if t.name.casefold() == str(model.get("name", "")).casefold()),
                    None,
                )
                if target is None:
                    continue
                pricing = model.get("pricing") or {}
                final_prices = pricing.get("final_prices")
                if isinstance(final_prices, list):
                    for entry in final_prices:
                        if not isinstance(entry, dict):
                            continue
                        group = str(entry.get("group_name") or "default")

                        def scaled(field: str, entry: dict[str, Any] = entry) -> float | None:
                            value = entry.get(field)
                            return value * 1_000_000 if _plain_number(value) else None

                        input_price = scaled("input_price")
                        output_price = scaled("output_price")
                        if input_price is None and output_price is None:
                            continue
                        key = (target.name, group)
                        if key in records:
                            continue
                        metadata = evidence(
                            "platforms 定价接口直读：final_prices 每 token 单价 ×1,000,000 换算为 CNY/1M tokens；证据未标明币种，按人民币回退。",
                            "CNY",
                        )
                        metadata["group"] = group
                        metadata["group_ratio"] = entry.get("rate_multiplier")
                        # 缓存读/写价与 input/output 同源同换算（final_prices 内按分组实价）
                        metadata["cache_read_price"] = scaled("cache_read_price")
                        metadata["cache_create_price"] = scaled("cache_write_price")
                        status = "confirmed" if input_price is not None and output_price is not None else "candidate"
                        records[key] = PriceRecord(
                            target.name,
                            input_price,
                            output_price,
                            "CNY/1M tokens",
                            response_source_url,
                            time.time(),
                            metadata,
                            status,
                        )
                    continue
                input_raw = pricing.get("input_price")
                output_raw = pricing.get("output_price")
                if not (_plain_number(input_raw) and _plain_number(output_raw)):
                    continue
                for group in platform_groups or ["default"]:
                    key = (target.name, group)
                    if key in records:
                        continue
                    metadata = evidence(
                        "channels/available 直读：每 token 单价 ×1,000,000 换算；sub2api 系证据格式为美元，组倍率是否已计入接口未标明，标待复核。",
                        "USD",
                    )
                    metadata["group"] = group
                    records[key] = PriceRecord(
                        target.name,
                        input_raw * 1_000_000,
                        output_raw * 1_000_000,
                        "USD/1M tokens",
                        response_source_url,
                        time.time(),
                        metadata,
                        "candidate",
                    )
    return list(records.values())


def looks_like_product_library_prices(payload: Any) -> bool:
    """302.ai 产品库价目（dash-api /products/list）：data.products[].price_info[] 带 input/output_price。"""
    if not isinstance(payload, dict):
        return False
    data = payload.get("data")
    if not isinstance(data, dict):
        return False
    products = data.get("products")
    if not isinstance(products, list):
        return False
    return any(
        isinstance(product, dict) and isinstance(product.get("price_info"), list)
        for product in products
    )


def _product_library_standard_tier(price_info: list[Any]) -> dict[str, Any] | None:
    """标准档：优先 description 与 special_pricing 双空的档（上下文/闲高峰等多档产品取基准价），否则第一档。"""
    for entry in price_info:
        if (
            isinstance(entry, dict)
            and not str(entry.get("description") or "").strip()
            and not str(entry.get("special_pricing") or "").strip()
        ):
            return entry
    return next((entry for entry in price_info if isinstance(entry, dict)), None)


def product_library_price_records(spec: SiteSpec, captured: list[dict[str, Any]]) -> list[PriceRecord]:
    """确定性解析 302.ai 产品库价目：按折后实付价（platform_*）直读，美元每百万 token。

    price_info 多档取标准档；按次计费档（suffix 非 "1M tokens"）不按 token 价采；
    实付价缺失回落标价；缓存读/写价随实付口径一并采集（实测 61/100 条带缓存价）；
    折扣 SKU（is_discount 或 sale/ 名称前缀）归「折扣」分组，与标准价并列不互相覆盖。
    """
    response_source_url = str(captured[0].get("url") or "") if captured else str(spec.network.get("url") or "")
    payload = captured[0].get("payload") if captured else None
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        return []
    products = data.get("products") or []
    records: dict[tuple[str, str], PriceRecord] = {}
    for product in products:
        if not isinstance(product, dict):
            continue
        name = str(product.get("name") or "")
        tier = _product_library_standard_tier(product.get("price_info") or [])
        if tier is None or str(tier.get("suffix") or "").strip() != "1M tokens":
            continue
        model_name = name.removeprefix("sale/")
        target = next(
            (t for t in spec.models if t.name.casefold() == model_name.casefold()),
            None,
        )
        if target is None:
            continue

        def effective(platform_key: str, list_key: str) -> float | None:
            value = tier.get(platform_key)
            if not _plain_number(value):
                value = tier.get(list_key)
            return value if _plain_number(value) else None

        input_price = effective("platform_input_price", "input_price")
        output_price = effective("platform_output_price", "output_price")
        if input_price is None and output_price is None:
            continue
        discounted = (
            (_plain_number(tier.get("rate")) and tier["rate"] < 1)
            or bool(product.get("is_discount"))
            or name.startswith("sale/")
        )
        group = "折扣" if discounted else "default"
        key = (target.name, group)
        if key in records:
            continue
        tier_note = str(tier.get("description") or "").strip()
        metadata = {
            "adapter": "network",
            "pricing_kind": "explicit_price",
            "group": group,
            "group_ratio": tier.get("rate") if _plain_number(tier.get("rate")) else None,
            "cache_read_price": effective("platform_cache_read_price", "cache_read_price"),
            "cache_create_price": effective("platform_cache_creation_price", "cache_write_price"),
            "currency": "USD",
            "network_evidence": [{
                "source": "model_list",
                "url": redact_url(str(captured[0].get("url", ""))),
                "resource_type": captured[0].get("resource_type"),
                "status": captured[0].get("status"),
                "payload_sha256": payload_hash(payload),
            }],
            "page_evidence": [],
            "notes": "302.ai 产品库直读：美元每百万 token，按折后实付价（缺折后价回落标价）。"
            + (f"档位：{tier_note}。" if tier_note else ""),
        }
        status = "confirmed" if input_price is not None and output_price is not None else "candidate"
        records[key] = PriceRecord(
            target.name,
            input_price,
            output_price,
            "USD/1M tokens",
            response_source_url,
            time.time(),
            metadata,
            status,
        )
    return list(records.values())


def looks_like_sub2api_model_prices(payload: Any) -> bool:
    """sub2api /api/v1/model-prices 结构：data.groups[].models[].tiers[]，分组实付价直读。"""
    if not isinstance(payload, dict):
        return False
    data = payload.get("data")
    if not isinstance(data, dict):
        return False
    groups = data.get("groups")
    if not isinstance(groups, list):
        return False
    return any(
        isinstance(group, dict)
        and isinstance(group.get("models"), list)
        and any(isinstance(model, dict) and isinstance(model.get("tiers"), list) for model in group["models"])
        for group in groups
    )


def sub2api_model_price_records(spec: SiteSpec, captured: list[dict[str, Any]]) -> list[PriceRecord]:
    """确定性解析 sub2api model-prices：分组实付价已含倍率，币种与单位随接口声明。

    同一模型在多个分组售卖时逐分组出价；tiers 取 min_tokens=0 的标准档（缺失回落第一档），
    非标准档不混入。input/output 齐全为 confirmed，缺一为 candidate；
    缓存读/写（含 1h 档）与 input/output 同源同倍率换算。
    """
    response_source_url = str(captured[0].get("url") or "") if captured else str(spec.network.get("url") or "")
    payload = captured[0].get("payload") if captured else None
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        return []
    unit = data.get("unit_tokens")
    scale = 1_000_000 / unit if _plain_number(unit) and unit > 0 else 1.0
    currency = str(data.get("currency") or "CNY")
    records: dict[tuple[str, str], PriceRecord] = {}
    for group in data.get("groups") or []:
        if not isinstance(group, dict):
            continue
        group_name = str(group.get("name") or "default")
        rate = group.get("effective_rate")
        if not _plain_number(rate):
            rate = group.get("default_rate") if _plain_number(group.get("default_rate")) else None
        for model in group.get("models") or []:
            if not isinstance(model, dict):
                continue
            if str(model.get("status") or "available") not in ("", "available"):
                continue
            target = next(
                (t for t in spec.models if t.name.casefold() == str(model.get("name", "")).casefold()),
                None,
            )
            if target is None:
                continue
            tiers = model.get("tiers") or []
            tier = next((t for t in tiers if isinstance(t, dict) and t.get("min_tokens") == 0), None)
            if tier is None:
                tier = next((t for t in tiers if isinstance(t, dict)), None)
            if tier is None:
                continue

            def scaled(field: str, tier: dict[str, Any] = tier) -> float | None:
                value = tier.get(field)
                return value * scale if _plain_number(value) else None

            input_price = scaled("input")
            output_price = scaled("output")
            if input_price is None and output_price is None:
                continue
            key = (target.name, group_name)
            if key in records:
                continue
            metadata = {
                "adapter": "network",
                "pricing_kind": "explicit_price",
                "group": group_name,
                "group_ratio": rate,
                # 缓存读/写价与 input/output 同源同倍率换算（tiers 内按档实价，2000lab 实测三键）
                "cache_read_price": scaled("cache_read"),
                "cache_create_price": scaled("cache_write"),
                "cache_create_1h_price": scaled("cache_write_1h"),
                "currency": currency,
                "network_evidence": [{
                    "source": "model_list",
                    "url": redact_url(str(captured[0].get("url", ""))),
                    "resource_type": captured[0].get("resource_type"),
                    "status": captured[0].get("status"),
                    "payload_sha256": payload_hash(payload),
                }],
                "page_evidence": [],
                "notes": "sub2api model-prices 直读：分组实付价已含倍率，按接口声明的币种与 unit_tokens 归一。",
            }
            if tier.get("min_tokens"):
                metadata["notes"] += f"档位 label={tier.get('label') or '未标注'}（min_tokens={tier.get('min_tokens')}）。"
            status = "confirmed" if input_price is not None and output_price is not None else "candidate"
            records[key] = PriceRecord(
                target.name,
                input_price,
                output_price,
                f"{currency}/1M tokens",
                response_source_url,
                time.time(),
                metadata,
                status,
            )
    return list(records.values())


def looks_like_marketplace_pricing(payload: Any) -> bool:
    """模型广场牌价结构（sub2api marketplace/plaza 各代形态，按响应结构分派非按站）：

    - items 型：data.items[].model_name + pricing.input_price/output_price（unit 声明 per_1m_tokens 或 per_token）
    - models 型：data.models[].name + input_cost_per_token 等每 token 单价
    - groups 型：data.groups[].models[].pricing（plaza 实收口径，按 token 单价；模型名可带 "global:" 之类通道前缀）
    """
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), dict):
        return False
    data = payload["data"]
    items = data.get("items")
    if isinstance(items, list) and any(
        isinstance(item, dict) and isinstance(item.get("pricing"), dict)
        for item in items
    ):
        return True
    models = data.get("models")
    if isinstance(models, list) and any(
        isinstance(model, dict) and _plain_number(model.get("input_cost_per_token"))
        for model in models
    ):
        return True
    groups = data.get("groups")
    return isinstance(groups, list) and any(
        isinstance(group, dict)
        and any(
            isinstance(model, dict) and isinstance(model.get("pricing"), dict)
            for model in group.get("models") or []
        )
        for group in groups
    )


def marketplace_price_records(spec: SiteSpec, captured: list[dict[str, Any]]) -> list[PriceRecord]:
    """确定性解析模型广场牌价：站方对外的每模型售价，美元口径随接口/站点声明。

    items 型直读 pricing（优先 effective_* 实付价，回落标价；unit=per_token 时 ×1e6）；
    models 型按每 token 单价 ×1e6 归一为 USD/1M tokens；缓存读/写价同步采集。
    匿名广场视图即默认分组牌价，input/output 齐全为 confirmed。
    """
    response_source_url = str(captured[0].get("url") or "") if captured else str(spec.network.get("url") or "")
    payload = captured[0].get("payload") if captured else None
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        return []
    records: dict[tuple[str, str], PriceRecord] = {}
    for item in data.get("items") or []:
        if not isinstance(item, dict):
            continue
        model_name = str(item.get("model_name") or "")
        pricing = item.get("pricing")
        if not isinstance(pricing, dict):
            continue
        target = next(
            (t for t in spec.models if t.name.casefold() == model_name.casefold()),
            None,
        )
        if target is None:
            continue

        def priced(field: str, pricing: dict[str, Any] = pricing) -> float | None:
            value = pricing.get(f"effective_{field}")
            if not _plain_number(value):
                value = pricing.get(field)
            if not _plain_number(value):
                return None
            unit = str(pricing.get("unit") or "")
            return value * 1_000_000 if unit == "per_token" else value

        input_price = priced("input_price")
        output_price = priced("output_price")
        if input_price is None and output_price is None:
            continue
        currency = str(pricing.get("currency") or "USD")
        metadata = {
            "adapter": "network",
            "pricing_kind": "explicit_price",
            "group": "default",
            "group_ratio": None,
            "cache_read_price": priced("cache_read_price"),
            "cache_create_price": priced("cache_write_price"),
            "currency": currency,
            "network_evidence": [{
                "source": "model_list",
                "url": redact_url(str(captured[0].get("url", ""))),
                "resource_type": captured[0].get("resource_type"),
                "status": captured[0].get("status"),
                "payload_sha256": payload_hash(payload),
            }],
            "page_evidence": [],
            "notes": "模型广场牌价直读：items[].pricing 按接口声明的 unit 与币种归一（实付价优先）。",
        }
        status = "confirmed" if input_price is not None and output_price is not None else "candidate"
        records[(target.name, "default")] = PriceRecord(
            target.name,
            input_price,
            output_price,
            f"{currency}/1M tokens",
            response_source_url,
            time.time(),
            metadata,
            status,
        )
    for model in data.get("models") or []:
        if not isinstance(model, dict):
            continue
        target = next(
            (t for t in spec.models if t.name.casefold() == str(model.get("name", "")).casefold()),
            None,
        )
        if target is None:
            continue

        def per_million(field: str, model: dict[str, Any] = model) -> float | None:
            value = model.get(field)
            return value * 1_000_000 if _plain_number(value) else None

        input_price = per_million("input_cost_per_token")
        output_price = per_million("output_cost_per_token")
        if input_price is None and output_price is None:
            continue
        metadata = {
            "adapter": "network",
            "pricing_kind": "explicit_price",
            "group": "default",
            "group_ratio": None,
            "cache_read_price": per_million("cache_read_cost_per_token"),
            "cache_create_price": per_million("cache_creation_cost_per_token"),
            "currency": "USD",
            "network_evidence": [{
                "source": "model_list",
                "url": redact_url(str(captured[0].get("url", ""))),
                "resource_type": captured[0].get("resource_type"),
                "status": captured[0].get("status"),
                "payload_sha256": payload_hash(payload),
            }],
            "page_evidence": [],
            "notes": "模型广场牌价直读：models[].cost_per_token 每 token 单价 ×1e6 归一为 USD/1M tokens。",
        }
        status = "confirmed" if input_price is not None and output_price is not None else "candidate"
        records[(target.name, "default")] = PriceRecord(
            target.name,
            input_price,
            output_price,
            "USD/1M tokens",
            response_source_url,
            time.time(),
            metadata,
            status,
        )
    for group in data.get("groups") or []:
        if not isinstance(group, dict):
            continue
        group_name = str(group.get("name") or "default")
        for model in group.get("models") or []:
            if not isinstance(model, dict):
                continue
            model_name = str(model.get("name") or "")
            # 通道范围前缀（如 "global:"）不是模型名的一部分
            if ":" in model_name:
                model_name = model_name.rsplit(":", 1)[-1]
            pricing = model.get("pricing")
            if not isinstance(pricing, dict):
                continue
            target = next(
                (t for t in spec.models if t.name.casefold() == model_name.casefold()),
                None,
            )
            if target is None:
                continue

            def per_million(field: str, pricing: dict[str, Any] = pricing) -> float | None:
                value = pricing.get(field)
                return value * 1_000_000 if _plain_number(value) else None

            input_price = per_million("input_price")
            output_price = per_million("output_price")
            if input_price is None and output_price is None:
                continue
            key = (target.name, group_name)
            if key in records:
                continue
            rate = group.get("rate_multiplier")
            metadata = {
                "adapter": "network",
                "pricing_kind": "explicit_price",
                "group": group_name,
                "group_ratio": rate if _plain_number(rate) else None,
                "cache_read_price": per_million("cache_read_price"),
                "cache_create_price": per_million("cache_write_price"),
                "cache_create_1h_price": per_million("cache_write_1h_price"),
                "currency": "USD",
                "network_evidence": [{
                    "source": "model_list",
                    "url": redact_url(str(captured[0].get("url", ""))),
                    "resource_type": captured[0].get("resource_type"),
                    "status": captured[0].get("status"),
                    "payload_sha256": payload_hash(payload),
                }],
                "page_evidence": [],
                "notes": "模型广场牌价直读：groups[].models[].pricing 每 token 单价 ×1e6 归一为 USD/1M tokens；接口为实收口径（倍率已计入），不再乘分组倍率。",
            }
            status = "confirmed" if input_price is not None and output_price is not None else "candidate"
            records[key] = PriceRecord(
                target.name,
                input_price,
                output_price,
                "USD/1M tokens",
                response_source_url,
                time.time(),
                metadata,
                status,
            )
    return list(records.values())


def looks_like_rate_pair_pricing(payload: Any) -> bool:
    """模型价目 + 分组倍率表结构：价目清单与倍率映射成对出现。

    两种同形态写法都认：data = [模型价目清单, {分组: 倍率}]（二元组），或
    data = {list: [模型价目], group_ratios: {分组: 倍率}}（字典键名形式）。
    模型带 name/id + input_price/output_price（+ 可选 price_tiers/groups 成员表）。
    """
    if not isinstance(payload, dict):
        return False
    data = payload.get("data")

    def _has_priced_model(models: Any) -> bool:
        return isinstance(models, list) and any(
            isinstance(model, dict)
            and _plain_number(model.get("input_price"))
            and _plain_number(model.get("output_price"))
            for model in models
        )

    if isinstance(data, list) and len(data) == 2:
        return isinstance(data[0], list) and isinstance(data[1], dict) and _has_priced_model(data[0])
    if isinstance(data, dict):
        return _has_priced_model(data.get("list")) and isinstance(data.get("group_ratios"), dict)
    return False


def _rate_pair_parts(data: Any) -> tuple[list[Any], dict[str, Any]] | None:
    """归一两种写法为 (模型价目清单, 倍率映射)；不匹配返回 None。"""
    if isinstance(data, list) and len(data) == 2 and isinstance(data[0], list) and isinstance(data[1], dict):
        return data[0], data[1]
    if isinstance(data, dict) and isinstance(data.get("list"), list) and isinstance(data.get("group_ratios"), dict):
        return data["list"], data["group_ratios"]
    return None


def rate_pair_price_records(spec: SiteSpec, captured: list[dict[str, Any]]) -> list[PriceRecord]:
    """确定性解析「价目 + 分组倍率」：实付 = 基准档价 × 分组倍率。

    币种按站点页面口径（¥ 计价直显）；倍率是站方明确的分组定价语义（点选分组
    前后对照实测），合成实付价标 candidate 留复核；每次计费模型（input/output
    双零）不按 token 价采；price_tiers 取 base/standard 标准档，长上下文档不混入。
    """
    response_source_url = str(captured[0].get("url") or "") if captured else str(spec.network.get("url") or "")
    payload = captured[0].get("payload") if captured else None
    data = payload.get("data") if isinstance(payload, dict) else None
    parts = _rate_pair_parts(data)
    if parts is None:
        return []
    models, rates = parts
    records: dict[tuple[str, str], PriceRecord] = {}
    for model in models:
        if not isinstance(model, dict):
            continue
        site_name = str(model.get("name") or model.get("id") or "")
        target = next(
            (t for t in spec.models if t.name.casefold() == site_name.casefold()),
            None,
        )
        if target is None:
            continue
        tiers = model.get("price_tiers") or []
        tier = next(
            (t for t in tiers if isinstance(t, dict) and str(t.get("name") or "").casefold() in ("base", "standard")),
            None,
        ) or next((t for t in tiers if isinstance(t, dict)), None)

        def base_price(field: str, model: dict[str, Any] = model, tier: dict[str, Any] | None = tier) -> float | None:
            value = tier.get(field) if isinstance(tier, dict) else None
            if not _plain_number(value):
                value = model.get(field)
            return value if _plain_number(value) else None

        base_input = base_price("input_price")
        base_output = base_price("output_price")
        if not base_input and not base_output:
            continue
        cache_read = base_price("cache_read_price")
        cache_write = base_price("cache_write_price")
        membership = [str(g) for g in model.get("groups") or [] if str(g)]
        groups = [g for g in membership if isinstance(rates.get(g), (int, float)) and not isinstance(rates.get(g), bool)]
        for group in groups or ["default"]:
            rate = rates.get(group) if group != "default" else 1
            if not _plain_number(rate):
                continue
            key = (target.name, group)
            if key in records:
                continue
            metadata = {
                "adapter": "network",
                "pricing_kind": "explicit_price",
                "group": group,
                "group_ratio": rate,
                "cache_read_price": cache_read * rate if _plain_number(cache_read) else None,
                "cache_create_price": cache_write * rate if _plain_number(cache_write) else None,
                "currency": "CNY",
                "network_evidence": [{
                    "source": "model_list",
                    "url": redact_url(str(captured[0].get("url", ""))),
                    "resource_type": captured[0].get("resource_type"),
                    "status": captured[0].get("status"),
                    "payload_sha256": payload_hash(payload),
                }],
                "page_evidence": [],
                "notes": "价目+倍率二元组直读：基准档价 × 分组倍率合成实付价（站点页面 ¥ 计价口径），倍率语义经页面点选分组对照验证。",
            }
            records[key] = PriceRecord(
                target.name,
                base_input * rate,
                base_output * rate,
                "CNY/1M tokens",
                response_source_url,
                time.time(),
                metadata,
                "candidate",
            )
    return list(records.values())


def looks_like_billing_rate_items(payload: Any) -> bool:
    """计费费率清单结构：items[].model + input_per_1m/output_per_1m（微美元每百万 token）。"""
    if not isinstance(payload, dict):
        return False
    items = payload.get("items")
    return isinstance(items, list) and any(
        isinstance(item, dict)
        and isinstance(item.get("model"), str)
        and _plain_number(item.get("input_per_1m"))
        for item in items
    )


def billing_rate_item_records(spec: SiteSpec, captured: list[dict[str, Any]]) -> list[PriceRecord]:
    """确定性解析 billing model-rates 清单：per_1m 字段为微美元/百万 token（÷1e6 归一 USD）。

    billing_mode=token 的行才按 token 价采（unit 按次计费的生图行 input/output 双零跳过）；
    官方对照价（official_*_usd）与通道来源（provider）落 metadata 留核对线索。
    """
    response_source_url = str(captured[0].get("url") or "") if captured else str(spec.network.get("url") or "")
    payload = captured[0].get("payload") if captured else None
    items = payload.get("items") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        return []
    records: dict[tuple[str, str], PriceRecord] = {}
    for item in items:
        if not isinstance(item, dict) or str(item.get("billing_mode") or "token") != "token":
            continue
        target = next(
            (t for t in spec.models if t.name.casefold() == str(item.get("model", "")).casefold()),
            None,
        )
        if target is None:
            continue

        def usd_per_million(field: str, item: dict[str, Any] = item) -> float | None:
            value = item.get(field)
            return value / 1_000_000 if _plain_number(value) else None

        input_price = usd_per_million("input_per_1m")
        output_price = usd_per_million("output_per_1m")
        if input_price is None and output_price is None:
            continue
        provider = str(item.get("provider") or "")
        official_input = usd_per_million("official_input_usd")
        official_output = usd_per_million("official_output_usd")
        metadata = {
            "adapter": "network",
            "pricing_kind": "explicit_price",
            "group": "default",
            "group_ratio": None,
            "cache_read_price": usd_per_million("cache_read_per_1m"),
            "cache_create_price": usd_per_million("cache_write_per_1m"),
            "currency": "USD",
            "network_evidence": [{
                "source": "model_list",
                "url": redact_url(str(captured[0].get("url", ""))),
                "resource_type": captured[0].get("resource_type"),
                "status": captured[0].get("status"),
                "payload_sha256": payload_hash(payload),
            }],
            "page_evidence": [],
            "notes": "billing 费率清单直读：per_1m 微美元 ÷1e6 归一 USD/1M tokens。"
            + (f"通道 {provider}。" if provider else "")
            + (f"站方标注官方价 in {official_input}/out {official_output} USD/1M。" if official_input or official_output else ""),
        }
        status = "confirmed" if input_price is not None and output_price is not None else "candidate"
        records[(target.name, "default")] = PriceRecord(
            target.name,
            input_price,
            output_price,
            "USD/1M tokens",
            response_source_url,
            time.time(),
            metadata,
            status,
        )
    return list(records.values())


class _BrowserPageResponse:
    """Headless抓到的页面伪装成 httpx.Response 的最小接口，让后续 HTML 解析路径直接复用。"""

    def __init__(self, url: str, text: str) -> None:
        self.url = url
        self.text = text
        self.status_code = 200
        self.headers: dict[str, str] = {}

    def json(self) -> Any:
        raise ValueError("Headless页面没有 JSON 载荷")

    def raise_for_status(self) -> None:
        return None


class NetworkAdapter:
    def collect(
        self,
        spec: SiteSpec,
        client: httpx.Client,
        timeout: float,
        user_agent: str,
        ai: AIConfig | None = None,
    ) -> list[PriceRecord]:
        """直接请求配置的价格接口；不启动浏览器。

        全部模型都拿不到价格（unavailable）时，多半是 CDN 质询/接口偶发抖动
        而非站点真没数据，隔 20 秒重试一次，重试成功则用重试结果。
        """
        records = self._collect_once(spec, client, timeout, user_agent, ai)
        if records and all(record.price_status == "unavailable" for record in records):
            time.sleep(20)
            retried = self._collect_once(spec, client, timeout, user_agent, ai)
            if any(record.price_status != "unavailable" for record in retried):
                return retried
        return records

    def _collect_once(
        self,
        spec: SiteSpec,
        client: httpx.Client,
        timeout: float,
        user_agent: str,
        ai: AIConfig | None = None,
    ) -> list[PriceRecord]:
        """单次采集，不重试。"""
        if not spec.models:
            raise PriceMonitorError(f"站点 {spec.id} 未配置目标模型 models；全量采集请配置 models: [\"*\"]")
        network = spec.network if isinstance(spec.network, dict) else {}
        url_value = network.get("url")
        if isinstance(url_value, dict):
            entry = resolve_endpoint(url_value, spec=spec, label="network.url")
        else:
            if not isinstance(url_value, str) or not url_value.strip():
                raise PriceMonitorError(f"站点 {spec.id} 未配置 network.url")
            # 扁平形态：params/headers 等直接挂在 network 下
            entry = resolve_endpoint({**network, "url": url_value}, spec=spec, label="network")
        headless_config = network.get("headless") or {}
        if isinstance(headless_config, dict) and headless_config.get("enabled"):
            from llm_price_monitor.browser_fetch import fetch_page_html

            # 浏览器链路不做请求头注入，登录态只走 cookies/localStorage（值可引用当前凭证）
            response: Any = _BrowserPageResponse(
                entry.url, fetch_page_html(entry.url, headless_config, user_agent, spec=spec)
            )
        else:
            response = client.get(entry.url, **build_request_kwargs(entry, spec, user_agent, timeout, target="price"))
        if response.status_code in {401, 403}:
            reason = (
                http_error_message("网络价格接口", response, auth_hint=True)
                if isinstance(response, httpx.Response)
                else f"网络价格接口返回 HTTP {response.status_code}，可能需要认证"
            )
            return auth_required_records(spec, reason, str(response.url))
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            reason = (
                http_error_message("网络价格接口", response)
                if isinstance(response, httpx.Response)
                else str(exc)
            )
            raise PriceMonitorError(reason) from exc
        payload: Any = None
        response_is_json = True
        try:
            payload = response.json()
        except ValueError:
            response_is_json = False
        captured = {
            "url": str(response.url),
            "status": response.status_code,
            "resource_type": "fetch",
            "source": "model_list",
            "preferred_response": True,
            "payload": payload,
            "content_type": response.headers.get("content-type", ""),
        }
        if not response_is_json:
            # 接口直采不做Headless自动回退：抓到空壳/风控页就按采集失败上报，
            # 需要浏览器渲染的站点由管理员显式切到「网页模式」（headless.enabled）
            return self._collect_from_html(spec, network, entry, client, timeout, user_agent, ai, response, captured)
        if looks_like_newapi_pricing(payload):
            denomination = _newapi_denomination(client, str(response.url), timeout)
            direct_records = network_pricing_records(spec, [captured], denomination=denomination)
            # Always let AI inspect New API/One API model names when enabled.
            # It resolves informal configured labels to evidence-backed
            # model_name aliases; pricing itself remains deterministic.
            if ai is not None and ai.usable:
                try:
                    alias_details = AIPriceExtractor(ai).extract_aliases(
                        spec, [captured], client=client,
                        expected_models=[target.name for target in spec.models],
                    )
                    aliases: dict[str, tuple[str, ...]] = {}
                    for model, details in alias_details.items():
                        observed = str(details.get("observed_model") or "")
                        aliases[model] = tuple(
                            value for value in (observed, *(details.get("aliases") or [])) if value
                        )
                    resolved_records = network_pricing_records(spec, [captured], aliases, denomination=denomination)
                    for resolved in resolved_records:
                        details = alias_details.get(resolved.model)
                        if not details:
                            continue
                        merged = dict(resolved.metadata or {})
                        if details.get("observed_model"):
                            merged["observed_model"] = details["observed_model"]
                        if details.get("aliases"):
                            merged["aliases"] = details["aliases"]
                        resolved.metadata = merged
                    if aliases:
                        tasklog.emit(f"[{spec.id}] AI 模型名对照：命中 {len(aliases)} 个标准名")
                    if any(record.price_status != "unavailable" for record in resolved_records):
                        return resolved_records
                except AIExtractionError as exc:
                    # 回落确定性直采定价是既定设计，但回落原因必须留痕——
                    # 超时/模型池全坏时无日志就无从定位整轮为何拖长
                    tasklog.emit(f"[{spec.id}] AI 模型名解析失败，使用直采定价：{exc}", "warn")
            return direct_records
        if looks_like_product_library_prices(payload):
            # 302.ai 产品库价目：美元每百万 token 直读，未命中监控模型返回空不落 AI
            return product_library_price_records(spec, [captured])
        if looks_like_sub2api_model_prices(payload):
            # sub2api model-prices 分组实付价：确定性直读，未命中监控模型就返回空，
            # 不落 AI——形状已识别，空转提取只会烧钱且结果必然为空
            return sub2api_model_price_records(spec, [captured])
        if looks_like_platform_pricing(payload):
            # 平台分桶定价结构（totokens final_prices / sub2api channels 直读价）：
            # 同上，确定性形状不落 AI
            return platform_pricing_records(spec, [captured])
        if looks_like_marketplace_pricing(payload):
            # 模型广场牌价（items[].pricing / models[].cost_per_token）：确定性形状不落 AI
            return marketplace_price_records(spec, [captured])
        if looks_like_rate_pair_pricing(payload):
            # 价目+分组倍率二元组：确定性形状不落 AI
            return rate_pair_price_records(spec, [captured])
        if looks_like_billing_rate_items(payload):
            # billing 费率清单（items[].*_per_1m 微美元）：确定性形状不落 AI
            return billing_rate_item_records(spec, [captured])
        if ai is not None and ai.usable:
            return AIPriceExtractor(ai).extract(
                spec,
                "",
                [captured],
                client=client,
                expected_models=[target.name for target in spec.models],
            )
        raise PriceMonitorError(f"站点 {spec.id} 不是可识别的 New API/One API 响应，且未配置可用 AI")

    def _collect_from_html(
        self,
        spec: SiteSpec,
        network: dict[str, Any],
        entry: EndpointRequest,
        client: httpx.Client,
        timeout: float,
        user_agent: str,
        ai: AIConfig | None,
        response: Any,
        captured: dict[str, Any],
    ) -> list[PriceRecord]:
        """HTML/文本响应的价格提取：页面内嵌表 → 引用链 chunk → AI 兜底。"""
        captured["text"] = response.text
        # 页面自带结构化价格表时优先确定性解析；页面里没有目标模型时，
        # 自动发现页面引用的 JS chunk 逐个查找（chunk 文件名常带内容哈希，
        # 每次采集重新发现，站点改版也能跟上），仍未命中再交给 AI
        entries = parse_base_price_entries(response.text)
        evidence_url = str(response.url)
        evidence_status = response.status_code
        evidence_text = response.text
        evidence_source = "model_list"
        ai_page_text = response.text
        ai_captured = [captured]
        # chunk 搜索是给 httpx 直采拿到的空壳页设计的（页面没有数据才去引用链里找）。
        # 无头渲染出来的页面本身就是完整内容，且多是整站大包——把 AI 证据从渲染页换成
        # 压缩 JS 包会让抽取全面劣化（118.ink 实测：渲染页 6/6 全对，换成 445KB 包文本
        # 后同模型全变 unavailable/null），故浏览器链路不做 chunk 搜索。
        if not (
            isinstance(response, _BrowserPageResponse)
            or (entries and any(_entry_matches_targets(item, spec) for item in entries))
        ) and _looks_like_html(response.text):
            chunk_headers = build_request_kwargs(entry, spec, user_agent, timeout, target="price")["headers"]
            hit = _search_price_chunk(spec, client, entry.url, chunk_headers, timeout, response.text)
            if hit is not None and hit.entries is not None:
                entries = hit.entries
                evidence_url = hit.url
                evidence_status = hit.status
                evidence_text = hit.text
                evidence_source = "model_list_chunk"
            elif hit is not None:
                # chunk 里能看到目标模型名但格式认不出：AI 兜底改用该 chunk 文本，
                # 否则 AI 只能看到空壳 HTML，等于白跑
                ai_page_text = hit.text
                ai_captured = [
                    captured,
                    {
                        "url": hit.url,
                        "status": hit.status,
                        "resource_type": "fetch",
                        "source": "model_list",
                        "payload": None,
                        "text": hit.text,
                        "content_type": "application/javascript",
                    },
                ]
        if entries and any(_entry_matches_targets(item, spec) for item in entries):
            entry_evidence = [{
                "source": evidence_source,
                "url": redact_url(evidence_url),
                "resource_type": "fetch",
                "status": evidence_status,
                "payload_sha256": payload_hash(evidence_text),
            }]
            # 配置了倍率接口时，基准价 × 端点倍率折算实售价（人民币）；
            # 记录的 source_url 指向倍率接口，倍率证据排在基准价证据前面
            resolve_rate = None
            source_url = str(response.url)
            ratio = _ratio_endpoint(network)
            if ratio is not None:
                resolve_rate, rate_evidence = _rate_resolver(
                    spec, client, entry, user_agent, timeout, ratio[0], extra_headers=ratio[1],
                )
                entry_evidence = [rate_evidence[0], *entry_evidence]
                source_url = ratio[0]
            # HTML 解析成功与 JSON 直采共用 browser_network 标签（含义见 network_pricing_records docstring）
            records = _records_from_base_entries(
                spec, entries, entry_evidence, source_url, adapter_label="browser_network",
                resolve_rate=resolve_rate,
            )
            if any(record.price_status == "confirmed" for record in records):
                return records
        # JS 内嵌条目没命中时，页面是普通价目表（表格 + 单元格币种符号）就做确定性表格解析，
        # 命中监控模型即采信返回——这条兜底必须排在 AI 之前：AI 对干净表格页也会抽错
        # （01tree 实测 $2.00/1M 被放大 1000 倍并标成 CNY），确定性解析优先是采集侧铁律；
        # 延迟 import：page_price.tables 顶部反向引用本模块的 parse_base_price_entries
        from llm_price_monitor.page_price.tables import parse_text_tables

        table_entries = parse_text_tables(response.text, str(response.url))
        if table_entries:
            table_evidence = [{
                "source": evidence_source,
                "url": redact_url(evidence_url),
                "resource_type": "fetch",
                "status": evidence_status,
                "payload_sha256": payload_hash(evidence_text),
            }]
            table_records = _price_records_from_table_entries(spec, table_entries, table_evidence, str(response.url))
            if table_records:
                return table_records
        if ai is not None and ai.usable:
            return AIPriceExtractor(ai).extract(
                spec, ai_page_text, ai_captured, client=client,
                expected_models=[target.name for target in spec.models],
            )
        raise PriceMonitorError(f"站点 {spec.id} 返回 HTML/文本响应，且未配置可用 AI")





_BASE_ENTRY_PATTERN = re.compile(r'\{category:"[^"]+"[^{}]*\}')
_ENTRY_FIELD_PATTERN = re.compile(r'(\w+):("([^"]*)"|\[[^\]]*\]|-?(?:\d+\.?\d*|\.\d+)|null|true|false)')
# HTML 里是 src="/href="/，JS 里是 import("./x.js")、from"./x.js"；
# 统一按「带引号、以 .js 结尾（可带 query）」的字符串提取引用地址
_JS_REF_PATTERN = re.compile(r'["\']([^"\']+\.js(?:\?[^"\']*)?)["\']')

@dataclass(frozen=True)
class _ChunkHit:
    """引用链搜索结果：entries 命中即确定性计价；未命中但 chunk 文本含
    目标模型名时带出该 chunk（url/status/text），供 AI 兜底使用。"""

    url: str
    status: int
    text: str
    entries: list[dict[str, Any]] | None = None


_MAX_CHUNK_FETCHES = 60
_MAX_CHUNK_DEPTH = 3
# 同层引用按文件名关键词排序，优先抓价格/渠道相关的业务 chunk，
# 避免 admin/支付等无关视图把抓取次数上限耗光
_CHUNK_URL_PRIORITY = ("pricing", "price", "channel", "model", "home", "billing", "rate", "plaza")


def _search_price_chunk(
    spec: SiteSpec,
    client: httpx.Client,
    base_url: str,
    headers: dict[str, str],
    timeout: float,
    root_text: str,
) -> _ChunkHit | None:
    """从入口文本（HTML 或 JS）出发，按引用链逐层发现 JS chunk 并找价格表。

    chunk 文件名带内容哈希且常逐层嵌套（页面 → 入口 JS → 业务 chunk），
    每次采集从入口重新发现，站点改版也能跟上；命中目标模型即返回，
    超过次数/层数上限则放弃（宁可交给 AI 兜底也不无限爬）。
    """
    target_names = [target.name.casefold() for target in spec.models if target.name.strip()]
    seen: set[str] = set()
    queue: deque[tuple[str, str, int]] = deque()
    queue.append((base_url, root_text, 0))
    fallback: _ChunkHit | None = None
    while queue:
        url, text, depth = queue.popleft()
        if depth >= _MAX_CHUNK_DEPTH:
            continue
        for ref in sorted(
            _JS_REF_PATTERN.findall(text),
            key=lambda ref: sum(keyword in ref.casefold() for keyword in _CHUNK_URL_PRIORITY),
            reverse=True,
        ):
            chunk_url = urljoin(url, ref)
            if not chunk_url.startswith(("http://", "https://")) or chunk_url in seen:
                continue
            seen.add(chunk_url)
            if len(seen) > _MAX_CHUNK_FETCHES:
                return fallback
            try:
                chunk_response = client.get(chunk_url, headers=headers, timeout=timeout)
            except httpx.HTTPError:
                continue
            if chunk_response.status_code != 200:
                continue
            parsed = parse_base_price_entries(chunk_response.text)
            if parsed and any(_entry_matches_targets(item, spec) for item in parsed):
                return _ChunkHit(chunk_url, chunk_response.status_code, chunk_response.text, parsed)
            if fallback is None and any(name in chunk_response.text.casefold() for name in target_names):
                fallback = _ChunkHit(chunk_url, chunk_response.status_code, chunk_response.text)
            queue.append((chunk_url, chunk_response.text, depth + 1))
    return fallback


def _looks_like_html(text: str) -> bool:
    """判断响应是否是 HTML 文档；非 HTML 不做 chunk 地址发现。"""
    head = text.lstrip()[:1024].lower()
    return any(mark in head for mark in ("<!doctype html", "<html", "<head", "<body", "<script", "<div"))


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _parse_scalar(value: str) -> Any:
    if value.startswith('"'):
        return value[1:-1]
    if value.startswith("["):
        try:
            return json.loads(value)
        except ValueError:
            # 压缩 JS 的数组常不是合法 JSON（.15 前导点小数、单引号字符串等），
            # 原样返回文本，别让单个字段崩掉整条解析链
            return value
    if value == "null":
        return None
    if value in {"true", "false"}:
        return value == "true"
    return float(value)


def _entries_from_json(payload: Any) -> list[dict[str, Any]]:
    """从 JSON 结构中递归收集与 JS 字面量同构的基准价条目（键序无关、键带引号的标准 JSON）。"""
    entries: list[dict[str, Any]] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            models = node.get("models")
            if (
                isinstance(models, list) and models
                and isinstance(node.get("provider"), str)
                and _is_number(node.get("input"))
                and _is_number(node.get("output"))
            ):
                entries.append({
                    "category": node.get("category"),
                    "provider": node["provider"],
                    "name": node.get("name"),
                    "models": [str(model) for model in models],
                    "input": float(node["input"]),
                    "output": float(node["output"]),
                    "cache_read": node.get("cache_read") if _is_number(node.get("cache_read")) else None,
                    "cache_create": node.get("cache_create") if _is_number(node.get("cache_create")) else None,
                })
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(payload)
    return entries


def _unescape_rsc(text: str) -> str:
    """还原 RSC 载荷里嵌套 JSON 的转义引号；层级深浅不一，循环归一到不再出现 \\" 为止。"""
    normalized = text
    for _ in range(4):
        if '\\"' not in normalized:
            break
        normalized = normalized.replace('\\"', '"')
    return normalized


def _parse_micro_usd_entries(text: str) -> list[dict[str, Any]]:
    """解析 hao 型 RSC 内嵌价：priceMicroUsd（微美元）按 component 分行、official/sell 两组价。

    大部分模型对象不带 slug 字段，但每条价格行都带 modelId（provider/slug 形态），因此按
    价格行锚定、按 modelId 聚合；站点售价取 role=sell、active=true、unit=per_1m_tokens 的
    input/output 行，微美元换算成 USD/1M tokens。缺售组或没有输入/输出行的模型（纯缓存、
    按次计费等）跳过，交给后续 AI 兜底；同一模型的行在 RSC 分片里可能重复，先到先得。
    """
    if "priceMicroUsd" not in text:
        return []
    normalized = _unescape_rsc(text)
    sell_by_model: dict[str, dict[str, float]] = {}
    order: list[str] = []
    for row_text in re.findall(r'\{[^{}]*"priceMicroUsd"[^{}]*\}', normalized):
        try:
            row = json.loads(row_text)
        except ValueError:
            continue
        if not isinstance(row, dict):
            continue
        if (
            row.get("role") == "sell"
            and row.get("active") is True
            and row.get("unit") == "per_1m_tokens"
            and _is_number(row.get("priceMicroUsd"))
        ):
            model_id = row.get("modelId")
            component = row.get("component")
            if not isinstance(model_id, str) or not model_id or not isinstance(component, str):
                continue
            bucket = sell_by_model.setdefault(model_id, {})
            if not bucket:
                order.append(model_id)
            bucket.setdefault(component, float(row["priceMicroUsd"]) / 1_000_000)
    entries: list[dict[str, Any]] = []
    for model_id in order:
        sell = sell_by_model[model_id]
        if "input" not in sell or "output" not in sell:
            continue
        provider, _, slug = model_id.partition("/")
        entries.append({
            "category": None,
            "provider": provider or None,
            "name": None,
            "models": [model_id, slug] if slug else [model_id],
            "input": sell["input"],
            "output": sell["output"],
            "cache_read": sell.get("cache_read"),
            "cache_create": sell.get("cache_creation"),
        })
    return entries


def parse_base_price_entries(text: str) -> list[dict[str, Any]]:
    """解析基准价表条目：先试整体 JSON（标准编码、键序无关），再退回压缩 JS 字面量正则，
    最后试 hao 型 priceMicroUsd RSC 内嵌价（微美元计价、official/sell 双组价取 sell 组）。"""
    stripped = text.lstrip()
    if stripped[:1] in {"{", "["}:
        try:
            entries = _entries_from_json(json.loads(stripped))
        except ValueError:
            entries = []
        if entries:
            return entries
    entries = []
    for match in _BASE_ENTRY_PATTERN.finditer(text):
        fields: dict[str, Any] = {}
        for key, raw, _quoted in _ENTRY_FIELD_PATTERN.findall(match.group(0)):
            fields[key] = _parse_scalar(raw)
        if isinstance(fields.get("models"), list) and {"provider", "input", "output"} <= fields.keys():
            entries.append(fields)
    return entries or _parse_micro_usd_entries(text)


def _entry_matches_targets(entry: dict[str, Any], spec: SiteSpec) -> bool:
    """基准价表条目是否命中配置的目标模型；站点省略版本号的写法也算命中。"""
    return bool(resolve_site_names(
        [str(model) for model in entry.get("models") or []],
        {target.name: (target.name,) for target in spec.models},
    ))


def _base_entry_unavailable(
    spec: SiteSpec,
    model: str,
    source_url: str,
    evidence: list[dict[str, Any]],
    reason: str,
    adapter_label: str,
) -> PriceRecord:
    return PriceRecord(
        model,
        None,
        None,
        "CNY/1M tokens",
        source_url,
        time.time(),
        {
            "adapter": adapter_label,
            "pricing_kind": "unavailable",
            "currency": "CNY",
            "network_evidence": evidence,
            "page_evidence": [],
            "notes": reason,
        },
        "unavailable",
    )


def _ratio_endpoint(network: dict[str, Any]) -> tuple[str, dict[str, str]] | None:
    """network.ratio_url 归一成 (url, 独立请求头)；兼容旧的纯 URL 字符串写法。"""
    ratio_raw = network.get("ratio_url")
    if ratio_raw is None:
        return None
    if isinstance(ratio_raw, str):
        return (ratio_raw.strip(), {}) if ratio_raw.strip() else None
    if isinstance(ratio_raw, dict):
        url = ratio_raw.get("url")
        headers = ratio_raw.get("headers")
        if not isinstance(url, str) or not url.strip():
            return None
        return url.strip(), {str(key): str(value) for key, value in headers.items()} if isinstance(headers, dict) else {}
    return None


def _rate_resolver(
    spec: SiteSpec,
    client: httpx.Client,
    entry: EndpointRequest,
    user_agent: str,
    timeout: float,
    ratio_url: str,
    *,
    extra_headers: dict[str, str] | None = None,
) -> tuple[Callable[[dict[str, Any]], tuple[float | None, str | None]], list[dict[str, Any]]]:
    """倍率接口 JSON → (resolve_rate(entry), 证据)。

    接口行形如 {provider, model_display, rate}；倍率先按模型显示名匹配，
    缺失时回退厂商级。返回的 resolve_rate 交给 _records_from_base_entries 消费。
    extra_headers 是倍率接口自己的独立请求头；凭证注入用到的头名一律以注入为准。
    """
    base_headers = build_request_kwargs(entry, spec, user_agent, timeout, target="price")["headers"]
    injected_names = {name.casefold() for name in auth_inject_headers(spec, "price")}
    request_headers = {
        **base_headers,
        **{str(key): value for key, value in (extra_headers or {}).items() if str(key).casefold() not in injected_names},
    }
    response = client.get(ratio_url, headers=request_headers, timeout=timeout)
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise PriceMonitorError(http_error_message("倍率接口", response)) from exc
    try:
        payload = response.json()
    except ValueError as exc:
        raise PriceMonitorError(f"站点 {spec.id} 的 network.ratio_url 返回非 JSON 响应") from exc
    rows = payload.get("pricing") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise PriceMonitorError(f"站点 {spec.id} 的倍率接口响应不是 pricing 列表形态")
    by_name: dict[str, float] = {}
    by_provider: dict[str, float] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        rate = row.get("rate")
        if isinstance(rate, bool) or not isinstance(rate, (int, float)):
            continue
        display = row.get("model_display")
        if isinstance(display, str) and display.strip():
            by_name[display.strip().casefold()] = float(rate)
        provider = row.get("provider")
        if isinstance(provider, str) and provider.strip():
            by_provider[provider.strip().casefold()] = float(rate)
    evidence = [{
        "source": "rate_api",
        "url": redact_url(str(response.url)),
        "resource_type": "fetch",
        "status": response.status_code,
        "payload_sha256": payload_hash(response.text),
    }]

    def resolve_rate(entry: dict[str, Any]) -> tuple[float | None, str | None]:
        name = str(entry.get("name") or "").strip().casefold()
        if name in by_name:
            return by_name[name], "model"
        provider = str(entry.get("provider") or "").strip().casefold()
        if provider in by_provider:
            return by_provider[provider], "provider"
        return None, None

    return resolve_rate, evidence


def _records_from_base_entries(
    spec: SiteSpec,
    entries: list[dict[str, Any]],
    evidence: list[dict[str, Any]],
    source_url: str,
    *,
    adapter_label: str,
    resolve_rate=None,
    ai_assisted: bool = False,
) -> list[PriceRecord]:
    """基准价表条目 → 价格记录。

    resolve_rate 为空时条目价即站点价（USD）；提供时输出 实售价 = 基准价(USD) × 端点倍率。
    ai_assisted 表示基准价或倍率来自 AI 归一化：记录降级为 candidate 并在 metadata 标注来源。
    """
    records: list[PriceRecord] = []
    entry_by_name: dict[str, dict[str, Any]] = {}
    for item in entries:
        for model in item["models"]:
            name = str(model).strip()
            if name:
                entry_by_name.setdefault(name, item)
    matched = resolve_site_names(
        list(entry_by_name),
        {target.name: (target.name,) for target in spec.models},
    )
    pairs = [
        (target, matched.get(target.name, ""), entry_by_name.get(matched.get(target.name, "")))
        for target in spec.models
    ]
    for target, site_name, entry in pairs:
        if entry is None:
            records.append(_base_entry_unavailable(spec, target.name, source_url, evidence, f"基准价表中未找到模型 {target.name}", adapter_label))
            continue
        rate, rate_source = 1.0, None
        if resolve_rate is not None:
            rate, rate_source = resolve_rate(entry)
            if rate is None:
                records.append(_base_entry_unavailable(spec, target.name, source_url, evidence, "站点未公布该模型的端点倍率", adapter_label))
                continue
        currency = "CNY" if resolve_rate is not None else "USD"
        metadata: dict[str, Any] = {
            "adapter": adapter_label,
            "pricing_kind": "base_times_rate" if resolve_rate is not None else "base_price",
            "currency": currency,
            "base_price": {
                "name": entry.get("name"),
                "provider": entry.get("provider"),
                "models": entry.get("models"),
                "input_usd": entry.get("input"),
                "output_usd": entry.get("output"),
                "cache_read_usd": entry.get("cache_read"),
                "cache_create_usd": entry.get("cache_create"),
            },
            "network_evidence": evidence,
            "page_evidence": [],
        }
        if site_name.casefold() != target.name.casefold():
            metadata["matched_model_name"] = site_name
        if resolve_rate is not None:
            metadata.update({
                "rate": rate,
                "rate_source": rate_source,
                "formula": "实售价 = 厂商基准价(USD) × 端点倍率；倍率取模型级，缺失时回退厂商级",
            })
        else:
            metadata["formula"] = "价格直接取自站点公布的基准价表（USD）"
        if ai_assisted:
            metadata["extraction"] = "ai"
        records.append(PriceRecord(
            target.name,
            round(float(entry["input"]) * rate, 6),
            round(float(entry["output"]) * rate, 6),
            f"{currency}/1M tokens",
            source_url,
            time.time(),
            metadata,
            "candidate" if ai_assisted else "confirmed",
        ))
    return records


def _price_records_from_table_entries(
    spec: SiteSpec,
    entries: list[dict[str, Any]],
    evidence: list[dict[str, Any]],
    source_url: str,
) -> list[PriceRecord]:
    """page_price 表格解析条目 → 价格记录：只产出命中监控模型且输入输出齐全的行，confirmed。

    表格条目自带币种与单位（取自页面单元格符号与表头标注），与"USD 基准价 × 端点倍率"
    那套语义不同，单独转换不走 _records_from_base_entries。页面上没有的监控模型不产出
    也不交给 AI 兜底（页面没有就是没有，AI 补抽只会编造——01tree 实测：页面 $2.00/1M
    被 AI 整表放大 1000 倍并标错币种，连续多轮被合理性校验作废）。"""
    matched = resolve_site_names(
        [str(item.get("model") or "") for item in entries],
        {target.name: (target.name,) for target in spec.models},
    )
    entry_by_model = {str(item.get("model") or "").strip(): item for item in entries}
    records: list[PriceRecord] = []
    for target_name, site_name in matched.items():
        entry = entry_by_model.get(site_name)
        if entry is None:
            continue
        input_price, output_price = entry.get("input_price"), entry.get("output_price")
        if input_price is None or output_price is None:
            continue
        currency = str(entry.get("currency") or "USD")
        unit = str(entry.get("unit") or f"{currency}/1M tokens")
        metadata: dict[str, Any] = {
            "adapter": "browser_network",
            "pricing_kind": "page_table",
            "currency": currency,
            "formula": "价格取自页面价目表（page_price 表格解析，币种与单位按页面标注）",
            "network_evidence": evidence,
            "page_evidence": [],
        }
        if site_name.casefold() != target_name.casefold():
            metadata["matched_model_name"] = site_name
        records.append(PriceRecord(
            target_name,
            float(input_price),
            float(output_price),
            unit,
            source_url,
            time.time(),
            metadata,
            "confirmed",
        ))
    return records


