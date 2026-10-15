"""代理节点自动切换：备用代理的出口也被目标站拒绝时，经 Clash/mihomo 外部控制接口
把节点切到「对该站实测可达」的其他节点，让采集换个出口再试一次。

只在系统设置里配齐了控制接口（proxy_controller_url + proxy_switch_group，密钥无则留空）
才启用；proxy_switch_node_filter 可选，填关键词（逗号分隔、模糊包含、忽略大小写）后
只挑名字含任一关键词的节点（如「香港」或「hk」）。
切换改的是所选代理组的节点选择，影响面取决于谁挂在该组上：本机「采集出口」组只被
采集专线口（127.0.0.1:7899，Verge Merge 的 listeners 定义）引用，浏览流量与其他组的
选点不受影响；生产容器内核专用，等同换整个采集出口。切换仍刻意克制：
- 冷却：同一目标域名切换后 10 分钟内不再切，连环被拉黑也不连环换出口；
- 全局串行：多个站点同时失败只允许一个切换流程在跑；
- 证据：候选节点用 mihomo 的 delay 端点对「失败的那个目标网址」实测（它会用该节点
  真实请求一次目标网址），测不通的（含剩余流量/官网这类信息位）一律不选。
配置读取走 provider（app 启动时接线），每次切换现读，面板改动即时生效。
"""
from __future__ import annotations

import json
import threading
import time
import urllib.parse
import urllib.request
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from llm_price_monitor import egress, tasklog

# 同一域名两次自动切换的最小间隔：换出口是后备手段，冷却防止连环被拒就连环换
_SWITCH_COOLDOWN_SECONDS = 600.0
# 候选节点实测数量上限：全部测会拖长失败请求的等待，测到有可达的就行
_MAX_DELAY_PROBES = 6
# 信息位节点名特征：机场塞在组里的流量/官网/过期提醒，不是真节点
_INFO_NODE_MARKS = ("剩余", "官网", "过期", "流量", "重置")

_settings_provider: Callable[[], dict] = lambda: {}
_lock = threading.Lock()
_switched_at: dict[str, float] = {}


def configure_settings(provider: Callable[[], dict]) -> None:
    """接线设置读取（app 启动时调用一次）；每次切换现读，面板改动即时生效。"""
    global _settings_provider
    _settings_provider = provider


def _controller() -> tuple[str, str, str, list[str]]:
    settings = _settings_provider() or {}
    url = str(settings.get("proxy_controller_url") or "").strip().rstrip("/")
    secret = str(settings.get("proxy_controller_secret") or "").strip()
    group = str(settings.get("proxy_switch_group") or "").strip()
    # 切换节点范围：逗号分隔（中英文皆可）的关键词，模糊包含、忽略大小写；留空不限制
    filter_raw = str(settings.get("proxy_switch_node_filter") or "")
    keywords = [kw.strip().lower() for kw in filter_raw.replace("，", ",").split(",") if kw.strip()]
    return url, secret, group, keywords


def _request(base: str, secret: str, path: str, *, method: str = "GET", body: dict | None = None, timeout: float = 8.0) -> Any:
    headers = {"Authorization": f"Bearer {secret}"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(base + path, method=method, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    return json.loads(raw) if raw else None


def fetch_groups(base: str, secret: str, *, timeout: float = 8.0) -> list[dict[str, Any]]:
    """读控制接口里的全部代理组，供管理面板下拉选组、选节点。

    返回 [{name, type, now, builtin, nodes: [{name, info, group}]}]：builtin 标出内置的
    GLOBAL 组（排序排最后）；info 标出机场塞在组里的信息位（剩余流量/套餐到期这类），
    group 标出该成员本身还是个策略组——两个标记只做展示，过滤与否由调用方决定。
    连不上/密钥不对/响应不是 mihomo 的形状都会抛异常，由调用方翻成人话提示。
    """
    data = _request(base, secret, "/proxies", timeout=timeout)
    proxies = data.get("proxies") if isinstance(data, dict) else None
    if not isinstance(proxies, dict):
        raise ValueError("控制接口返回的不是 mihomo 的代理清单")
    groups: list[dict[str, Any]] = []
    for name, item in proxies.items():
        if not isinstance(item, dict) or not isinstance(item.get("all"), list):
            continue  # 只有带 all 的才是代理组，单个节点与内置 DIRECT/REJECT 跳过
        members = [
            {
                "name": member,
                "info": any(mark in member for mark in _INFO_NODE_MARKS),
                "group": member != name and isinstance((proxies.get(member) or {}).get("all"), list),
            }
            for member in item["all"]
            if isinstance(member, str) and member.strip()
        ]
        groups.append(
            {
                "name": name,
                "type": str(item.get("type") or ""),
                "now": str(item.get("now") or ""),
                "builtin": name == "GLOBAL",
                "nodes": members,
            }
        )
    groups.sort(key=lambda group: (group["builtin"], group["name"]))
    return groups


def _usable_members(group_data: dict[str, Any], node_filter: list[str]) -> list[str]:
    """组数据里的可用节点：剔除机场信息位（流量/官网这类），再按关键词过滤。"""
    return [
        member
        for member in group_data.get("all") or []
        if isinstance(member, str) and member.strip() and not any(mark in member for mark in _INFO_NODE_MARKS)
        and (not node_filter or any(keyword in member.lower() for keyword in node_filter))
    ]


def pool_state(*, timeout: float = 8.0) -> tuple[list[str], str] | None:
    """切换组的出口池：([可用节点], 当前选中节点)；没配控制接口返回 None。

    人气采集按这份清单把请求分散到不同出口（SimilarWeb 这类 WAF 按出口 IP 限流），
    读不到/连不上由调用方降级处理（照常抛异常，留痕）。
    """
    base, secret, group, node_filter = _controller()
    if not base or not group:
        return None
    group_data = _request(base, secret, f"/proxies/{urllib.parse.quote(group, safe='')}", timeout=timeout) or {}
    return _usable_members(group_data, node_filter), str(group_data.get("now") or "")


def select_node(node: str, *, timeout: float = 8.0) -> bool:
    """把切换组的选中节点设为 node；没配控制接口或设置失败返回 False（失败留痕）。"""
    base, secret, group, _node_filter = _controller()
    if not base or not group:
        return False
    try:
        _request(base, secret, f"/proxies/{urllib.parse.quote(group, safe='')}", method="PUT", body={"name": node}, timeout=timeout)
    except Exception as exc:  # noqa: BLE001 —— 切换失败不回滚调用方流程，只留痕
        tasklog.emit(f"切换代理节点失败（{node}）：{exc}", "warn")
        return False
    egress.invalidate_egress_ip()  # 出口变了：会话绑定站的 XFF 下次拼装重新探测
    return True


def auto_switch_for(host: str, target_url: str) -> str | None:
    """host 的代理出口也被目标站拒绝时，切到对该站实测可达的节点，返回新节点名。

    未启用、冷却中、没有可达节点都返回 None（调用方按原样失败上报，不重试）。
    """
    base, secret, group, node_filter = _controller()
    if not base or not group:
        return None
    now = time.monotonic()
    with _lock:
        if now - _switched_at.get(host, float("-inf")) < _SWITCH_COOLDOWN_SECONDS:
            return None
        _switched_at[host] = now  # 先占坑：切换失败也要等冷却，避免连环折腾
    try:
        node = _switch_to_reachable(base, secret, group, node_filter, target_url)
    except Exception as exc:  # 控制接口抖动不能反过来打断采集，留痕后按无节点处理
        tasklog.emit(f"[{host}] 自动切换代理节点失败：{exc}", "warn")
        return None
    if node is not None:
        tasklog.emit(f"[{host}] 代理出口也被目标站拒绝，已自动切换节点 → {node}")
    return node


def _switch_to_reachable(base: str, secret: str, group: str, node_filter: list[str], target_url: str) -> str | None:
    group_data = _request(base, secret, f"/proxies/{urllib.parse.quote(group, safe='')}") or {}
    members = _usable_members(group_data, node_filter)
    current = str(group_data.get("now") or "")
    candidates = [member for member in members if member != current][:_MAX_DELAY_PROBES]
    if not candidates:
        return None
    target = urllib.parse.quote(target_url, safe="")

    def probe(member: str) -> tuple[str, int | None]:
        path = f"/proxies/{urllib.parse.quote(member, safe='')}/delay?timeout=5000&url={target}"
        try:
            return member, int(_request(base, secret, path, timeout=8.0).get("delay") or 0)
        except Exception:
            return member, None

    with ThreadPoolExecutor(max_workers=_MAX_DELAY_PROBES) as pool:
        reachable = {member: delay for member, delay in pool.map(probe, candidates) if delay and delay > 0}
    if not reachable:
        return None
    best = min(reachable, key=reachable.get)
    _request(base, secret, f"/proxies/{urllib.parse.quote(group, safe='')}", method="PUT", body={"name": best})
    egress.invalidate_egress_ip()  # 出口变了：会话绑定站的 XFF 下次拼装重新探测
    return best
