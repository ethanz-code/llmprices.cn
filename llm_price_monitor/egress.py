"""采集出口的直连失败记忆与备用代理（直连优先、被墙回退）。

进程内维护一份域名级失败记忆：某域名直连出现连接类失败（超时/重置/TLS 中断）
或 403/451 时记上一笔，TTL 内后续请求直接走备用代理，不再反复失败；TTL 过期后
放行一次直连探测，成功即洗白、失败续期。备用代理地址实时读系统设置
（settings.fallback_proxy，管理面板「系统设置」里维护），面板改完下轮采集生效。

单实例设计（与调度器同一约束），记忆只存进程内存，重启即清零重新学习。
无头浏览器采集共用这份记忆（只读），保证同一站点两条链路的出口选择一致。
"""
from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass
from typing import Callable, Iterable

# 直连失败后改走代理的时长（秒）；过期后放行一次直连探测，成功即切回
REPROBE_SECONDS = 3600

_log = logging.getLogger("llm_price_monitor.egress")

_now = time.time
_provider: Callable[[], str | None] | None = None
_failures: dict[str, float] = {}
_lock = threading.Lock()


def configure_provider(provider: Callable[[], str | None] | None) -> None:
    """注入备用代理地址的读取函数（应用启动时接 store.get_document("settings")）；None 表示未接线。"""
    global _provider
    _provider = provider


def fallback_proxy() -> str | None:
    """当前生效的备用代理地址；未配置返回 None（采集永不因配置读取挂掉）。"""
    if _provider is None:
        return None
    try:
        value = _provider()
    except Exception as cause:  # noqa: BLE001 —— 配置读取失败按未配置处理，但必须留痕可排查
        _log.warning("备用代理配置读取失败，本轮按未配置处理（被墙域名将直连重试）: %s", cause)
        return None
    return str(value or "").strip() or None


@dataclass(frozen=True)
class DirectPlan:
    """单个域名的直连决策：use_proxy=直接走代理；reprobe=失败标记过期，放行一次直连探测。"""

    use_proxy: bool
    reprobe: bool


# 强制走代理的域名（会话绑定站）：站方校验「请求对端 IP == X-Forwarded-For」，采集器直连的
# 国内出口与 XFF 声明的登录出口（代理）必然不一致 → SESSION_BINDING_MISMATCH。这类站
# 必须与 XFF 同路（走同一代理出口），不参与直连优先。配置加载时按站点注册。
_forced_hosts: set[str] = set()


def register_forced_proxy_hosts(hosts: Iterable[str]) -> None:
    """登记「出口必须与 XFF 一致」的域名（会话绑定站），plan() 对它们跳过直连。"""
    with _lock:
        for host in hosts:
            normalized = _normalize(host)
            if normalized:
                _forced_hosts.add(normalized)


# 当前出口 IP（会话绑定站的 XFF 要与请求对端一致，节点漂移时跟随）。
# 查询结果缓存 EGRESS_IP_TTL 秒：代理出口不会秒级变化，每轮采集只查一次足够。
EGRESS_IP_TTL_SECONDS = 300.0
_egress_ip: str | None = None
_egress_ip_at: float = 0.0
_PROXY_ENV_KEYS = ("all_proxy", "http_proxy", "https_proxy", "ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY")


def _local_env_proxy() -> str | None:
    """读标准代理环境变量（与 http_retry._env_proxy 同语义；那边 import 本模块，这里不能反向 import）。"""
    for key in _PROXY_ENV_KEYS:
        value = os.environ.get(key, "").strip()
        if value:
            return value
    return None


def effective_proxy() -> str | None:
    """采集回退出口的最终地址：面板备用代理优先，未配置才回落标准代理环境变量。

    面板的「备用代理 + 节点自动切换（控制口/切换组）」是一个整体，描述同一条出口链路；
    环境变量只覆盖代理地址，切换功能对它无从生效——面板配置在场时必须让它赢，
    否则自动切换切的是面板那个组、流量却走在环境变量指的另一个代理上（2026-10-14
    cun.ai 实证：shell 的 https_proxy=7897 遮蔽面板 7899，切换改「采集出口」组全程无效）。
    """
    return fallback_proxy() or _local_env_proxy()


def invalidate_egress_ip() -> None:
    """出口 IP 缓存作废：代理节点切换后立刻生效，下一次 XFF 拼装重新探测当前出口。

    缓存默认 5 分钟，节点切换会让 XFF 最多滞后一个缓存周期，会话绑定站（校验
    请求对端 IP == XFF）可能瞬时对不上，所以切换成功即调用这里。
    """
    global _egress_ip_at
    _egress_ip_at = 0.0


def current_egress_ip(*, timeout: float = 8.0) -> str | None:
    """当前采集出口（代理）IP；没有代理或查询失败返回 None（调用方保留 XFF 原文并留痕）。

    优先读环境/备用代理的出口；查询走 ipify，5 分钟缓存。线程安全靠幂等的赋值即可。
    """
    global _egress_ip, _egress_ip_at
    now = _now()
    if _egress_ip and now - _egress_ip_at < EGRESS_IP_TTL_SECONDS:
        return _egress_ip
    proxy = effective_proxy()
    if not proxy:
        return None
    try:
        import httpx

        with httpx.Client(timeout=timeout, transport=httpx.HTTPTransport(proxy=proxy)) as client:
            value = (client.get("https://api.ipify.org").text or "").strip()
    except Exception as cause:  # noqa: BLE001 —— 出口查询失败不该拖垮采集，按"未知出口"处理
        _log.warning("出口 IP 查询失败（XFF 跟随将使用配置原值）: %s", cause)
        return None
    if value:
        _egress_ip = value
        _egress_ip_at = now
    return _egress_ip


def plan(host: str) -> DirectPlan:
    """给定域名该直连还是走代理；失败标记过期时返回 reprobe 放行一次直连探测。

    探测请求与普通直连请求同路（直连请求统一压短建连超时），不再需要调用方单独注入短超时。
    """
    key = _normalize(host)
    with _lock:
        if key in _forced_hosts:
            return DirectPlan(use_proxy=True, reprobe=False)
        failed_at = _failures.get(key)
    if failed_at is None:
        return DirectPlan(use_proxy=False, reprobe=False)
    if _now() - failed_at >= REPROBE_SECONDS:
        return DirectPlan(use_proxy=False, reprobe=True)
    return DirectPlan(use_proxy=True, reprobe=False)


def mark_direct_failed(host: str) -> None:
    with _lock:
        _failures[_normalize(host)] = _now()


def mark_direct_ok(host: str) -> None:
    with _lock:
        _failures.pop(_normalize(host), None)


def _normalize(host: str) -> str:
    return str(host or "").strip().lower()
