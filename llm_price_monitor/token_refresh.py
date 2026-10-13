"""站点认证 token 续签：采集返回"需认证"时调用续签接口换取新 token 并回写配置。

配置形如（存站点 JSON 的 token_refresh 字段）：
    {
        "url": "https://totokens.cc/api/v1/auth/refresh",
        "method": "POST",
        "body": "{\"refresh_token\": \"${refresh_token}\"}",
        "refresh_token": "rt_xxx",
        "access_token_field": "data.access_token"  # 可选；管理面板保存时由 AI 从响应案例分析得出
    }
请求头 = 站点通用请求头（request_headers）打底；headers 值同样支持 ${refresh_token} 占位，
cookie 型站点（如 new-api）写成 "new_api_refresh=${refresh_token}" 即可自动代入；
响应解析优先用配置的字段路径，否则自动探测 data.access_token / access_token，
响应里带新 refresh_token 时一并换新。

轮换型凭据（new-api 的 new_api_refresh）：旧值用一次就作废，新值只经响应 Set-Cookie
下发、body 里没有。配置 "refresh_cookie_name": "new_api_refresh" 后，续签会从 Set-Cookie
提取新值回写 refresh_token，下次请求 headers 里的占位符自动展开成新值，接力续签。

触发时机：价格采集按"需认证占位记录"判定，渠道状态与公告按接口返回 401/403 判定，
三者都用新 access_token 重试一次；access_token 落到站点级 auth_token，
价格/状态/公告的请求头因此统一带上 Authorization。
此外 token 是 JWT 且配了续签的站点会主动续签（ensure_fresh_token，三条采集腿每站开抓前调用）：
轮换型 refresh_token 放着不用会被站方作废或被并发腿抢用，等 401 再续对 24h 短效 token
意味着一天死一次。触发条件是"闲置满 REFRESH_IDLE_CAP_SECONDS"或"剩余寿命不足总寿命 1/6"，
取先到者；闲置上限防的是机器休眠整段吞掉到期前窗口、醒来时 refresh_token 已超龄
（2026-10-13 totokens/2btocken 实锤：睡 10 小时，醒来再续已闲置约 22 小时被站方判死）。
"""
from __future__ import annotations

import json
import time
from dataclasses import replace
from typing import Any, Callable, TypeVar

import httpx

from llm_price_monitor.config import PriceMonitorError, SiteSpec, jwt_claim
from llm_price_monitor.tasklog import emit as _emit
from llm_price_monitor.tracker import PriceRecord

T = TypeVar("T")

# 主动续签的闲置上限：轮换型 rt_ 闲置约一天即被站方作废（实测闲置 20 小时可续、约 22 小时已拒）。
# "到期前 1/6"的提前量一旦整段落在机器休眠期就会被跳过（2026-10-13 totokens/2btocken 实锤），
# 所以只要 token 用满 6 小时就先换新：即使机器连睡 10 余小时，醒来第一轮扫描补续时
# 闲置也只有 16 小时上下，仍远小于 rt_ 约 22 小时的寿命。24h token 约每 6 小时换一次。
REFRESH_IDLE_CAP_SECONDS = 6 * 3600.0


def refresh_due(auth_token: str | None, *, now: float | None = None) -> bool:
    """access_token 是否该主动续签：闲置满 6 小时（保链）或剩余寿命不足总寿命 1/6，取先到者。

    24h token 由闲置上限主导（约每 6 小时换一次），提前量兜底；15 分钟 token 由 1/6 条主导
    （提前 2.5 分钟），节奏不变；赶不上的由 401 后的被动续签兜底。非 JWT（无法判断过期时间）不主动续。
    """
    token = str(auth_token or "")
    exp = jwt_claim(token, "exp")
    if exp <= 0:
        return False
    current = now if now is not None else time.time()
    at = exp - current
    if at <= 0:
        return True  # 已过期：主动续一次没坏处，省得等下一轮 401
    iat = jwt_claim(token, "iat")
    if iat and current - iat >= REFRESH_IDLE_CAP_SECONDS:
        return True  # 闲置到上限：先换新，别等它睡过到期前窗口后超龄
    lifetime = max(exp - iat, 0.0) if iat else 0.0
    margin = min(max(lifetime / 6, 60.0), lifetime / 2, 21600.0) if lifetime else 7200.0
    return at < margin


def _stored_tokens(store: Any, site_id: str) -> tuple[str, str] | None:
    """读库里的 (access_token, refresh_token)；库里的 access 与 spec 持有的不同说明别的腿刚续签过。"""
    config = store.get_site_config(site_id)
    if not isinstance(config, dict):
        return None
    access = str(config.get("auth_token") or "")
    refresh = str((config.get("token_refresh") or {}).get("refresh_token") or "")
    return (access, refresh) if access and refresh else None


# 站方响应里"凭据已作废、换再多也不会好"的判别词（大小写不敏感）。命中即触发熔断：
# 这类失效不是时序问题，继续每轮打续签接口只会反复撞墙（且部分站方会把反复使用已作废
# 凭据判为滥用，连带吊销整个会话家族），必须等人工重新登录接管。
REFRESH_DEAD_MARKERS = ("refresh_token_invalid", "invalid refresh token", "token revoked")
# 熔断标记落库用的键：token_refresh.dead_since 有值 = 链已判死，采集侧跳过续签。
# 重新接管（更新 refresh_token / 重建 token_refresh）时管理台保存会换掉该对象，标记自然清除。
REFRESH_DEAD_FIELD = "dead_since"


class RefreshTokenRevokedError(PriceMonitorError):
    """refresh_token 已被站方作废（REFRESH_TOKEN_INVALID 类）：续签无法自愈，必须人工重新接管。"""


def _revoked_detail(response: httpx.Response) -> str:
    """从作废响应里摘站方的 reason/message，给用户看的是人话不是状态码。"""
    try:
        payload = response.json()
    except ValueError:
        return "站方未给出原因"
    if not isinstance(payload, dict):
        return "站方未给出原因"
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    detail = payload.get("reason") or payload.get("message") or data.get("reason") or data.get("message")
    return str(detail) if detail else "站方未给出原因"


def refresh_chain_dead(token_refresh: dict[str, Any] | None) -> bool:
    """续签链是否已被熔断：dead_since 有值即死，等重新接管。"""
    return bool(token_refresh and token_refresh.get(REFRESH_DEAD_FIELD))


def _mark_refresh_dead(store: Any, site_id: str, reason: str) -> None:
    """把"续签链已死"写进站点配置：后续所有采集腿看到标记直接跳过续签，不再锤站方接口。"""
    if store is None:
        return
    config = store.get_site_config(site_id)
    if not isinstance(config, dict):
        return
    current = config.get("token_refresh")
    if not isinstance(current, dict) or current.get(REFRESH_DEAD_FIELD):
        return
    updated = {
        **config,
        "token_refresh": {
            **current,
            REFRESH_DEAD_FIELD: time.time(),
            "dead_reason": reason,
        },
    }
    store.upsert_site(site_id, updated)


def _is_refresh_dead_response(response: httpx.Response) -> bool:
    """站方是否明确说了"refresh_token 已作废"：优先看 body 里的 reason/message，401 状态兜底看语义。"""
    if response.status_code not in {401, 403}:
        return False
    try:
        payload = response.json()
    except ValueError:
        return False
    blob = json.dumps(payload, ensure_ascii=False).casefold()
    return any(marker in blob for marker in REFRESH_DEAD_MARKERS)


def ensure_fresh_token(
    spec: SiteSpec,
    *,
    client: httpx.Client,
    timeout: float,
    user_agent: str,
    store: Any | None,
) -> SiteSpec:
    """每站采集开抓前的主动续签：token 快到期就先换新，别等 401。

    返回可直接用于本轮采集的 spec（未到期/没配续签时原样返回）。续签失败不在这里报错——
    若是真失效，随后的采集会撞 401 并走被动续签链路给出用户可见的失败；若只是撞上并发
    （别的采集腿刚续签过），直接采用库里已回写的新 token，本轮照常采，不刷瞬时错误。
    """
    if not spec.token_refresh or not str(spec.token_refresh.get("refresh_token") or "").strip():
        return spec
    if refresh_chain_dead(spec.token_refresh):
        return spec
    if not refresh_due(spec.auth_token):
        return spec
    _emit(f"[{spec.id}] access_token 快到期，主动续签…")
    try:
        access_token, refresh_token = refresh_site_token(spec, client, timeout, user_agent)
    except RefreshTokenRevokedError as exc:
        # 凭据被站方作废（REFRESH_TOKEN_INVALID 类）：熔断落库，别让每轮×每腿继续锤站方接口。
        # 库里若已有别的腿换上的新 rt_（spec 是旧快照），说明链其实活着，静默采用即可。
        newer = _stored_tokens(store, spec.id) if store is not None else None
        if newer and newer[1] and newer[1] != str(spec.token_refresh.get("refresh_token") or ""):
            _emit(f"[{spec.id}] 主动续签撞上并发，采用库里的新 token")
            return refreshed_spec(spec, *newer)
        _mark_refresh_dead(store, spec.id, str(exc))
        _emit(f"[{spec.id}] 续签链已熔断：{exc}", "error")
        return spec
    except (PriceMonitorError, httpx.HTTPError, ValueError):
        newer = _stored_tokens(store, spec.id) if store is not None else None
        if newer and newer[0] and newer[0] != str(spec.auth_token or ""):
            _emit(f"[{spec.id}] 主动续签撞上并发，采用库里的新 token")
            return refreshed_spec(spec, *newer)
        return spec
    if store is not None:
        persist_refreshed_config(store, spec.id, access_token, refresh_token)
    _emit(f"[{spec.id}] token 已主动续签")
    return refreshed_spec(spec, access_token, refresh_token)


def needs_refresh(collected: list[PriceRecord]) -> bool:
    """任一记录是"需认证"占位就触发续签：无需认证的接口可能照样拿到数据，只看全部会漏掉真过期。"""
    return any(record.requires_auth for record in collected)


def _dig_token(payload: dict[str, Any], configured: Any, fallbacks: tuple[str, ...]) -> str | None:
    """按字段路径取 token：显式配置优先（点号路径，如 data.access_token），否则按常见结构自动探测。"""
    paths: list[str] = []
    if isinstance(configured, str) and configured.strip():
        paths.append(configured.strip())
    paths.extend(fallbacks)
    for path in paths:
        value: Any = payload
        for part in path.split("."):
            value = value.get(part) if isinstance(value, dict) else None
            if value is None:
                break
        if value:
            return str(value)
    return None


def _cookie_from_response(response: httpx.Response, name: Any) -> str | None:
    """从响应 Set-Cookie 里取轮换后的新凭据；new-api 型站点的新 refresh token 只经这里下发。"""
    if not isinstance(name, str) or not name.strip():
        return None
    for header in response.headers.get_list("set-cookie"):
        cookie_name, sep, value = header.split(";", 1)[0].strip().partition("=")
        if sep and cookie_name.strip() == name.strip() and value:
            return value
    return None


def refresh_site_token(spec: SiteSpec, client: httpx.Client, timeout: float, user_agent: str) -> tuple[str, str]:
    """执行续签请求，返回 (新 access_token, 新 refresh_token)。失败抛 PriceMonitorError。"""
    config = spec.token_refresh
    method = str(config.get("method") or "POST").upper()
    url = str(config["url"]).strip()
    refresh_token = str(config.get("refresh_token") or "")
    params = {str(k): str(v).replace("${refresh_token}", refresh_token) for k, v in (config.get("params") or {}).items()}
    extra_headers = {
        **{str(k): str(v).replace("${refresh_token}", refresh_token) for k, v in spec.request_headers.items()},
        **{str(k): str(v).replace("${refresh_token}", refresh_token) for k, v in (config.get("headers") or {}).items()},
    }
    body_template = config.get("body")
    kwargs: dict[str, Any] = {"params": params, "headers": extra_headers, "timeout": timeout}
    if body_template is not None and method != "GET":
        kwargs["content"] = body_template.replace("${refresh_token}", refresh_token)
        if not any(name.casefold() == "content-type" for name in extra_headers):
            kwargs["headers"] = {**extra_headers, "content-type": "application/json"}
    response = client.request(method, url, **kwargs)
    if response.status_code in {401, 403}:
        if _is_refresh_dead_response(response):
            raise RefreshTokenRevokedError(
                f"续签接口返回 HTTP {response.status_code}：refresh_token 已被站方作废"
                f"（{_revoked_detail(response)}），续签无法自愈，需重新登录接管"
            )
        raise PriceMonitorError(f"续签接口返回 HTTP {response.status_code}，refresh_token 可能已失效")
    response.raise_for_status()
    payload = response.json() if "json" in response.headers.get("content-type", "") else {}
    if not isinstance(payload, dict):
        raise PriceMonitorError("续签接口响应不是 JSON 对象")
    access_token = _dig_token(payload, config.get("access_token_field"), ("data.access_token", "access_token"))
    if not access_token:
        data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
        message = payload.get("message") or data.get("message")
        raise PriceMonitorError(f"续签接口响应中没有 access_token{f'：{message}' if message else ''}")
    # 新 refresh token 优先取 Set-Cookie（轮换型站点 body 里没有），再退回 body 字段路径；都没有则沿用旧值
    new_refresh = (
        _cookie_from_response(response, config.get("refresh_cookie_name"))
        or _dig_token(payload, config.get("refresh_token_field"), ("data.refresh_token", "refresh_token"))
    )
    return str(access_token), str(new_refresh or refresh_token)


def refreshed_spec(spec: SiteSpec, access_token: str, refresh_token: str) -> SiteSpec:
    """新 token 写入 auth_token 和写死在采集地址 headers 里的认证头，本次采集立即可用。"""
    spec = _with_access_token(spec, access_token)
    return replace(spec, token_refresh={**spec.token_refresh, "refresh_token": refresh_token})


def _retokenize_value(value: str, token: str) -> str:
    """替换认证头的 token 部分，保留 "Bearer " 之类的前缀。"""
    prefix, _, rest = value.partition(" ")
    if prefix and rest:
        return f"{prefix} {token}"
    name, sep, _ = value.partition("=")
    return f"{name}{sep}{token}" if sep else token


def _synced_endpoint(endpoint: Any, token: str, auth_header: str) -> Any:
    """把 endpoint 配置 headers 里写死的认证头同步成新 token；没有认证头则原样返回。

    network 条目下还可能挂着倍率接口（ratio_url）自己的一套请求头，一并同步。
    Cookie 不在同步范围：会话凭据续签拿不到，写死了只能手动维护；
    Headless 登录态里引用 ${access_token}/${refresh_token} 占位符的不受此限，
    新 token 落到 auth_token/refresh_token 后采集时实时展开（见 browser_fetch）。
    """
    if not isinstance(endpoint, dict):
        return endpoint
    synced: dict[str, Any] = {}
    if isinstance(endpoint.get("headers"), dict):
        synced["headers"] = _retokenized_headers(endpoint["headers"], token, auth_header)
    ratio = endpoint.get("ratio_url")
    if isinstance(ratio, dict) and isinstance(ratio.get("headers"), dict):
        synced["ratio_url"] = {**ratio, "headers": _retokenized_headers(ratio["headers"], token, auth_header)}
    return {**endpoint, **synced} if synced else endpoint


def _retokenized_headers(headers: dict[str, Any], token: str, auth_header: str) -> dict[str, Any]:
    """headers 里的认证头换成新 token，其余键原样保留。"""
    auth_names = {auth_header.lower(), "authorization"}
    return {
        key: (_retokenize_value(value, token) if key.lower() in auth_names and isinstance(value, str) else value)
        for key, value in headers.items()
    }


def _with_access_token(spec: SiteSpec, access_token: str) -> SiteSpec:
    return replace(
        spec,
        auth_token=access_token,
        network=_synced_endpoint(spec.network, access_token, "Authorization"),
        networks=tuple(_synced_endpoint(entry, access_token, "Authorization") for entry in spec.networks),
        status=_synced_endpoint(spec.status, access_token, "Authorization"),
        notice=_synced_endpoint(spec.notice, access_token, "Authorization"),
    )


def persist_refreshed_config(store: Any, site_id: str, access_token: str, refresh_token: str) -> None:
    """把新 token 写回数据库里的站点 JSON：auth_token 之外，写死的认证请求头也一并替换。\n\n    部分站点把 Authorization 直接写死在采集地址 headers 里，采集时它会覆盖\n    auth_token 拼出的同名头，不同步的话续签永远"成功"但请求头还是旧 token。\n    价格、渠道状态、公告地址都在同步范围内；Cookie 不动（会话凭据续签拿不到，手动维护）。\n    Headless 登录态走 ${access_token} 占位符的站点不需要同步：采集时按新 auth_token 实时展开。\n    """
    config = store.get_site_config(site_id)
    if config is None:
        return
    updated = {
        **config,
        "auth_token": access_token,
        "network": _synced_endpoint(config.get("network") or {}, access_token, "Authorization"),
        "networks": [_synced_endpoint(entry, access_token, "Authorization") for entry in (config.get("networks") or [])],
        "status": _synced_endpoint(config.get("status") or {}, access_token, "Authorization"),
        "notice": _synced_endpoint(config.get("notice") or {}, access_token, "Authorization"),
        "token_refresh": {**(config.get("token_refresh") or {}), "refresh_token": refresh_token},
    }
    store.upsert_site(site_id, updated)


def refresh_and_retry_once(
    spec: SiteSpec,
    *,
    client: httpx.Client,
    timeout: float,
    user_agent: str,
    store: Any | None,
    attempt: Callable[[SiteSpec], T],
) -> tuple[T | None, str | None]:
    """接口返回 401/403 时用续签换来的新 token 重试一次，供渠道状态/公告采集使用。

    与 refresh_and_recollect 的分工：那条链路按"需认证占位记录"判定并整体替换本轮价格；
    这条只在真正撞上 auth 失败时才换新。返回 (结果, 错误说明)，两者恰好有一个为 None——
    attempt 返回 None 是合法结果（公告接口不存在），调用方以错误说明区分成功与失败。
    """
    try:
        access_token, refresh_token = refresh_site_token(spec, client, timeout, user_agent)
    except RefreshTokenRevokedError as exc:
        # 被动作废：熔断落库 + 并发护栏（别的腿可能刚续签成功、库里的 rt_ 已换新）。
        newer = _stored_tokens(store, spec.id) if store is not None else None
        if newer and newer[1] and newer[1] != str(spec.token_refresh.get("refresh_token") or ""):
            try:
                result = attempt(refreshed_spec(spec, *newer))
                return result, None
            except (PriceMonitorError, httpx.HTTPError, ValueError) as retry_exc:
                return None, f"采用库内新 token 重试失败：{retry_exc}"
        _mark_refresh_dead(store, spec.id, str(exc))
        return None, f"token 续签失败：{exc}"
    except (PriceMonitorError, httpx.HTTPError, ValueError) as exc:
        return None, f"token 续签失败：{exc}"
    if store is not None:
        persist_refreshed_config(store, spec.id, access_token, refresh_token)
    try:
        return attempt(refreshed_spec(spec, access_token, refresh_token)), None
    except (PriceMonitorError, httpx.HTTPError, ValueError) as exc:
        return None, f"token 续签成功但重新采集失败：{exc}"


def refresh_and_recollect(
    spec: SiteSpec,
    collected: list[PriceRecord],
    *,
    collect: Any,
    client: httpx.Client,
    timeout: float,
    user_agent: str,
    store: Any | None,
) -> tuple[list[PriceRecord], list[str]]:
    """需要续签时调用续签接口，成功则回写配置并用新 token 重新采集一次。

    collect 是"给定 spec → (记录, 地址错误)"的采集回调（含多地址循环）。
    返回 (记录, 错误列表)，与 collect 契约一致，调用方整体替换本轮结果，不再有元组/列表形状错配。

    退回占位记录（而非空列表）的两种情况：续签失败、续签成功但重采一条都没拿到。
    空列表会被调用方当成"该站点本轮无数据"，从而照常跑分组下线判定、把全部分组记成缺失；
    退回带 requires_auth 的占位记录才能保住"需认证"状态，让判定照旧跳过。
    """
    try:
        access_token, refresh_token = refresh_site_token(spec, client, timeout, user_agent)
    except RefreshTokenRevokedError as exc:
        # 被动作废：熔断落库 + 并发护栏，与 refresh_and_retry_once 同一套路。
        newer = _stored_tokens(store, spec.id) if store is not None else None
        if newer and newer[1] and newer[1] != str(spec.token_refresh.get("refresh_token") or ""):
            try:
                retried, retry_errors = collect(refreshed_spec(spec, *newer))
            except (PriceMonitorError, httpx.HTTPError, ValueError) as retry_exc:
                return collected, [f"采用库内新 token 重试失败：{retry_exc}"]
            if not retried:
                return collected, [*retry_errors, "采用库内新 token 重试未取到任何价格"]
            return retried, retry_errors
        _mark_refresh_dead(store, spec.id, str(exc))
        return collected, [f"token 续签失败：{exc}"]
    except (PriceMonitorError, httpx.HTTPError, ValueError) as exc:
        return collected, [f"token 续签失败：{exc}"]
    if store is not None:
        persist_refreshed_config(store, spec.id, access_token, refresh_token)
    try:
        retried, retry_errors = collect(refreshed_spec(spec, access_token, refresh_token))
    except (PriceMonitorError, httpx.HTTPError, ValueError) as exc:
        return collected, [f"token 续签成功但重新采集失败：{exc}"]
    if not retried:
        return collected, [*retry_errors, "token 续签成功但重新采集未取到任何价格"]
    return retried, retry_errors
