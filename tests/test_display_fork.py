"""站方自有计价 fork（heyroute 型双列价格）解析测试。

数值取自 2026-10-12 页面实证：Grok $2.00→$0.040、CN-Models glm-5.3 $1.14→$0.64、
Codex-Pro20x gpt-6-astra $12.00→$0.48、minimax-m3 $0.30→$0.168。
"""
from llm_price_monitor.adapters import (
    display_fork_price_records,
    looks_like_display_price_fork,
)
from llm_price_monitor.config import ModelTarget, SiteSpec

GROUP_RATIO = {
    "grok": 1,
    "cn-models": 3,
    "codex-pro20x": 1.8,
}
PRICING = {
    "group_ratio": GROUP_RATIO,
    "display_prices": {"grok-imagine-image": {"": {"CNY": 0.14, "USD": 0.02}}},
    "data": [
        {"model_name": "grok-4.7", "enable_groups": ["grok"], "model_ratio": 1, "completion_ratio": 3},
        {"model_name": "glm-5.3", "enable_groups": ["cn-models"], "model_ratio": 4, "completion_ratio": 3.5},
        {"model_name": "minimax-m3", "enable_groups": ["cn-models"], "model_ratio": 1.05, "completion_ratio": 4},
        {"model_name": "gpt-6-astra", "enable_groups": ["codex-pro20x"], "model_ratio": 6, "completion_ratio": 5},
    ],
}
STATUS = {"data": {"quota_per_unit": 500000, "price": 7.3}}
TOPUP = {"data": {"data": {"wallet_recharge_rate": 20, "payment_market": "overseas"}}}
PLANS = {
    "data": [
        {"price_amount": 10, "total_amount": 6000000, "quota_reset_period": "daily", "duration_unit": "day", "duration_value": 30},
        {"price_amount": 24, "total_amount": 15000000, "quota_reset_period": "daily", "duration_unit": "day", "duration_value": 30},
    ]
}


class _Resp:
    def __init__(self, payload):
        self._payload = payload
        self.status_code = 200
        self.is_success = True

    def json(self):
        return self._payload


class _Client:
    def __init__(self, mapping):
        self.mapping = mapping

    def get(self, url, **kwargs):
        for key, value in self.mapping.items():
            if key in url:
                return _Resp(value)
        raise AssertionError(f"unexpected url: {url}")


def _spec(*names):
    return SiteSpec(id="heyroute", network={"url": "https://heyroute.ai/api/pricing"},
                    models=tuple(ModelTarget(name=n) for n in names))


def _captured():
    return [{"url": "https://heyroute.ai/api/pricing", "status": 200, "resource_type": "fetch",
             "payload": PRICING}]


def test_display_fork_price_matches_rendered_page():
    client = _Client({"/api/status": STATUS, "/api/user/topup/info": TOPUP, "/api/subscription/plans": PLANS})
    records = display_fork_price_records(
        _spec("grok-4.7", "glm-5.3", "minimax-m3", "gpt-6-astra"),
        _captured(), client=client, user_agent="UA", timeout=5,
    )
    got = {f"{r.model}:{r.metadata['group']}": (r.input_price, r.output_price) for r in records}
    assert got["grok-4.7:grok"] == (0.04, 0.12)
    assert got["glm-5.3:cn-models"] == (0.64, 2.24)
    assert got["minimax-m3:cn-models"] == (0.168, 0.672)
    assert got["gpt-6-astra:codex-pro20x"] == (0.48, 2.4)
    assert all(r.unit == "USD/1M tokens" and r.price_status == "confirmed" for r in records)
    assert all(r.metadata["display_fork_rates"] == [20, 37.5] for r in records)


def test_display_fork_without_rate_is_unavailable_not_wrong_price():
    client = _Client({"/api/status": STATUS})
    records = display_fork_price_records(
        _spec("grok-4.7"), _captured(), client=client, user_agent="UA", timeout=5,
    )
    assert records and all(r.price_status == "unavailable" and r.input_price is None for r in records)
    assert "汇率" in records[0].metadata["notes"]


def test_looks_like_display_price_fork_requires_display_prices():
    assert looks_like_display_price_fork(PRICING)
    plain = {k: v for k, v in PRICING.items() if k != "display_prices"}
    assert not looks_like_display_price_fork(plain)
