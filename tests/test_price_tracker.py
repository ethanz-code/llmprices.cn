import httpx
import pytest

from llm_price_monitor.tracker import (
    GroupRatioUnavailableError,
    detect_site_kind,
    extract_price,
    fetch_newapi_price,
    fetch_price,
    newapi_denomination_from_status,
    newapi_price_record,
)


def test_extract_price_from_model_price_text():
    record = extract_price("gpt-5.6-luna 输入价格 ¥3.3 / 1M tokens，输出价格 ¥9.9 / 1M tokens", "gpt-5.6-luna", "https://pricing.test")
    assert record.input_price == 3.3
    assert record.output_price == 9.9
    assert "1M tokens" in record.unit


def test_fetch_price_supports_json_endpoint():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"gpt-5.6-luna": {"input": 3.3, "output": 9.9}})

    record = fetch_price("https://pricing.test/api", "gpt-5.6-luna", client=httpx.Client(transport=httpx.MockTransport(handler)))
    assert record.input_price == 3.3 and record.output_price == 9.9
    assert record.price_status == "candidate"


def test_fetch_newapi_price_parses_tiered_expression_and_applies_group_ratio():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/status":
            return httpx.Response(200, json={"data": {"HeaderNavModules": "{}"}})
        return httpx.Response(200, json={"pricing_version": "v1", "group_ratio": {"gpt pro": 0.2}, "data": [{"model_name": "gpt-5.6-luna", "enable_groups": ["gpt pro"], "billing_mode": "tiered_expr", "billing_expr": "len <= 272000 ? tier(\"standard\", p * 2 + c * 12 + cr * 0.2) : tier(\"long\", p * 4 + c * 24 + cr * 0.4)"}]})

    record = fetch_newapi_price("https://newapi.test", "gpt-5.6-luna", group="gpt pro", client=httpx.Client(transport=httpx.MockTransport(handler)))
    assert record.input_price is None and record.output_price is None
    assert record.price_status == "rule_only"
    assert record.metadata["pricing_kind"] == "tiered_expr"
    tiers = record.metadata["pricing_rules"]["groups"][0]["tiers"]
    assert tiers == [
        {"name": "standard", "context_min": None, "context_max": 272000, "input_price": 0.4, "output_price": 2.4000000000000004, "cache_read_price": 0.04000000000000001, "unit": "CNY/1M tokens"},
        {"name": "long", "context_min": 272001, "context_max": None, "input_price": 0.8, "output_price": 4.800000000000001, "cache_read_price": 0.08000000000000002, "unit": "CNY/1M tokens"},
    ]
    assert record.metadata["newapi"] is True


def test_extract_price_marks_missing_unit_or_output_as_candidate():
    record = extract_price("gpt-5.6-luna ¥3.3", "gpt-5.6-luna", "https://pricing.test")
    assert record.input_price == 3.3
    assert record.output_price is None
    assert record.price_status == "candidate"


def test_extract_price_does_not_scan_unrelated_page_numbers():
    try:
        extract_price("首页有 ¥3.3、版本 2.0，但没有目标模型", "gpt-5.6-luna", "https://pricing.test")
    except ValueError as exc:
        assert "未找到模型" in str(exc)
    else:
        raise AssertionError("页面未出现模型名时不应提取整页数字")


def test_newapi_price_requires_auth_when_pricing_is_private():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/status":
            return httpx.Response(200, json={"data": {"HeaderNavModules": "{}"}})
        return httpx.Response(401, json={"success": False})

    record = fetch_newapi_price("https://private.test", "gpt-5.6-luna", client=httpx.Client(transport=httpx.MockTransport(handler)))
    assert record.price_status == "unavailable"
    assert record.requires_auth is True


def test_newapi_ratio_price_overrides_official_reference_price():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/status":
            return httpx.Response(403, text="blocked")
        return httpx.Response(200, json={"data": [{"model_name": "gpt-5.6-luna", "model_ratio": 0.02, "completion_ratio": 6, "official_pricing": {"input": 1.5, "output": 7.5}}]})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    site = detect_site_kind("https://sudocode.test/", client=client)
    record = fetch_newapi_price("https://sudocode.test", "gpt-5.6-luna", client=client)
    assert site["kind"] == "newapi"
    assert record.input_price == 0.04 and record.output_price == 0.24
    assert record.price_status == "confirmed"
    assert "CNY/1M" in record.unit


def test_newapi_regular_ratio_applies_group_and_cache_multipliers():
    payload = {
        "group_ratio": {"gpt pro": 0.8},
        "data": [{
            "model_name": "gpt-5.6-luna",
            "enable_groups": ["gpt pro"],
            "model_ratio": 0.5,
            "completion_ratio": 4,
            "cache_ratio": 0.1,
            "create_cache_ratio": 1.25,
        }],
    }

    record = newapi_price_record(payload, "gpt-5.6-luna", "https://newapi.test/api/pricing", group="gpt pro")

    assert record.input_price == 0.8
    assert record.output_price == 3.2
    assert record.metadata["cache_read_price"] == 0.08000000000000002
    assert record.metadata["cache_create_price"] == 1.0
    assert record.unit == "CNY/1M tokens"


def test_newapi_missing_group_ratio_is_not_inferred_from_other_fields():
    """group_ratio 未覆盖的分组不再从 group_definitions / first_topup_offer 静默推断倍率。"""
    payload = {
        "group_ratio": {},
        "group_definitions": [{"id": "vip", "label": "VIP", "ratio": 0.5}],
        "first_topup_offer": {"group": "vip", "ratio": 0.3},
        "data": [{
            "model_name": "gpt-5.6-luna",
            "enable_groups": ["vip"],
            "model_ratio": 0.5,
            "completion_ratio": 4,
        }],
    }

    with pytest.raises(GroupRatioUnavailableError):
        newapi_price_record(payload, "gpt-5.6-luna", "https://newapi.test/api/pricing", group="vip")


def test_newapi_currency_can_be_explicitly_configured_as_usd():
    payload = {"data": [{"model_name": "gpt-5.6-luna", "model_ratio": 0.5}]}

    record = newapi_price_record(payload, "gpt-5.6-luna", "https://newapi.test/api/pricing", currency="USD")

    assert record.unit == "USD/1M tokens"


def test_newapi_denomination_from_status_derives_topup_base():
    """充值口径 = (1e6/quota_per_unit) × price；price=1 的人民币站维持倍率×2。"""
    assert newapi_denomination_from_status({"data": {"quota_per_unit": 500000, "price": 6.8}}) == {
        "ratio_base_price": 13.6,
        "quota_per_unit": 500000,
        "topup_cny_per_usd": 6.8,
        "source": "api_status",
    }
    assert newapi_denomination_from_status({"data": {"quota_per_unit": 500000, "price": 1}})["ratio_base_price"] == 2.0


def test_newapi_denomination_from_status_rejects_missing_or_absurd_values():
    assert newapi_denomination_from_status({"data": {"HeaderNavModules": "{}"}}) is None
    assert newapi_denomination_from_status({"data": {"quota_per_unit": 0, "price": 1}}) is None
    assert newapi_denomination_from_status({"data": {"quota_per_unit": 3333333.3, "price": 1}}) is None
    assert newapi_denomination_from_status(None) is None
    assert newapi_denomination_from_status({"data": "blocked"}) is None


def test_newapi_ratio_price_applies_topup_denomination():
    """AIHub365 实锤：price=6.8 的站倍率基准是 ¥13.6，按默认 ¥2 会整体低算 6.8 倍。"""
    payload = {
        "data": [{
            "model_name": "glm-5.3-flash", "model_ratio": 0.017647058824,
            "completion_ratio": 3.5, "cache_ratio": 0.2875,
        }],
        "group_ratio": {"default": 1},
    }
    denomination = newapi_denomination_from_status({"data": {"quota_per_unit": 500000, "price": 6.8}})

    record = newapi_price_record(
        payload, "glm-5.3-flash", "https://aihub365.test/api/pricing", group="default", denomination=denomination,
    )

    assert record.input_price == pytest.approx(0.24, abs=1e-6)
    assert record.output_price == pytest.approx(0.84, abs=1e-6)
    assert record.metadata["ratio_base_price"] == 13.6
    assert record.metadata["denomination"]["topup_cny_per_usd"] == 6.8
    assert record.metadata["cache_read_price"] == pytest.approx(0.24 * 0.2875, abs=1e-6)


def test_newapi_explicit_and_tiered_prices_scale_by_topup_rate():
    """cun 实锤：显式价与阶梯价是展示美元（定价页直接显示的数），要乘充值汇率才是实付。"""
    denomination = newapi_denomination_from_status({"data": {"quota_per_unit": 500000, "price": 6.95}})
    explicit_payload = {
        "data": [{"model_name": "deepseek-v4-pro", "input_price": 0.6, "output_price": 1.8}],
        "group_ratio": {"default": 1.25},
    }
    record = newapi_price_record(
        explicit_payload, "deepseek-v4-pro", "https://cun.test/api/pricing", group="default", denomination=denomination,
    )
    assert record.input_price == pytest.approx(0.6 * 1.25 * 6.95)
    assert record.output_price == pytest.approx(1.8 * 1.25 * 6.95)

    tiered_payload = {
        "data": [{
            "model_name": "deepseek-v4-pro",
            "billing_mode": "tiered_expr",
            "pricing_rules": {"tiers": [
                {"label": "peak", "unit_prices": {"input": 0.77, "output": 2.3116}},
                {"label": "offpeak", "unit_prices": {"input": 0.385, "output": 1.1558}},
            ]},
            "enable_groups": ["default"],
        }],
        "group_ratio": {"default": 1.0},
    }
    tiered = newapi_price_record(
        tiered_payload, "deepseek-v4-pro", "https://cun.test/api/pricing", group="default", denomination=denomination,
    )
    tiers = tiered.metadata["pricing_rules"]["groups"][0]["tiers"]
    assert tiers[0]["input_price"] == pytest.approx(0.77 * 6.95)
    assert tiers[1]["input_price"] == pytest.approx(0.385 * 6.95)


def test_newapi_explicit_price_with_declared_unit_is_not_rescaled():
    """载荷自己声明了单位（官方参考价）说明数值已是终价，不再折算。"""
    denomination = newapi_denomination_from_status({"data": {"quota_per_unit": 500000, "price": 6.95}})
    payload = {
        "data": [{"model_name": "gpt-x", "input_price": 3.0, "output_price": 9.0, "unit": "USD/1M tokens"}],
        "group_ratio": {"default": 1.0},
    }
    record = newapi_price_record(payload, "gpt-x", "https://x.test/api/pricing", group="default", denomination=denomination)
    assert record.input_price == 3.0 and record.output_price == 9.0


def test_newapi_tiered_expr_applies_billing_multiplier():
    """sudocode 实锤：billing_multiplier 是站方对计费表达式的折扣/加价系数，漏乘会把官方基准价当站价。"""
    payload = {
        "data": [{
            "model_name": "deepseek-v4-pro",
            "billing_mode": "tiered_expr",
            "billing_expr": '(tier("base", p * 9 + c * 27 + cr * 0.3)) * (hour("Asia/Shanghai") >= 9 ? 1.2 : 1)',
            "billing_multiplier": 0.5,
            "enable_groups": ["default"],
        }],
        "group_ratio": {"default": 1.0},
    }
    record = newapi_price_record(payload, "deepseek-v4-pro", "https://sudocode.test/api/pricing", group="default")
    tiers = record.metadata["pricing_rules"]["groups"][0]["tiers"]
    assert tiers[0]["input_price"] == pytest.approx(4.5)
    assert tiers[0]["output_price"] == pytest.approx(13.5)
    assert record.metadata["billing_multiplier"] == 0.5


def test_newapi_advertised_price_wins_over_official_rate_tier_expr():
    """subrouter 实锤：billing_expr 里的 p*10+c*50 是官方价率的池子计费，站方挂牌价
    input_price 0.6（=官价 94% 折扣）才是页面展示的站价，挂牌价必须优先。"""
    payload = {
        "data": [{
            "model_name": "gpt-6-astra",
            "input_price": 0.6,
            "output_price": 3,
            "official_input_price": 10,
            "official_output_price": 50,
            "billing_mode": "tiered_expr",
            "billing_expr": 'len <= 272000 ? tier("0_272k", p * 10 + cr * 1 + cc * 12.5 + c * 50) : tier("272k_plus", p * 20 + cr * 2 + cc * 25 + c * 75)',
        }],
        "group_ratio": {"default": 1.0},
    }
    denomination = newapi_denomination_from_status({"data": {"quota_per_unit": 500000, "price": 6.8}})

    record = newapi_price_record(
        payload, "gpt-6-astra", "https://subrouter.test/api/marketplace/shared-models",
        group="default", denomination=denomination,
    )

    assert record.price_status == "confirmed"
    assert record.input_price == pytest.approx(0.6 * 6.8)
    assert record.output_price == pytest.approx(3 * 6.8)
    assert record.metadata["pricing_kind"] == "explicit_price"


def test_newapi_v2_payload_keeps_priority_over_status_denomination():
    """modelflare：v2 载荷自带基准声明，/api/status 的 qpu 自定义值不参与推导。"""
    payload = {
        "billing_denomination_version": 2,
        "pricing_cny_rate": 6.73,
        "data": [{"model_name": "glm-5.3-flash", "model_ratio": 0.4}],
        "group_ratio": {"default": 1},
    }
    denomination = {"ratio_base_price": 13.6, "quota_per_unit": 500000, "topup_cny_per_usd": 6.8, "source": "api_status"}

    record = newapi_price_record(
        payload, "glm-5.3-flash", "https://modelflare.test/api/pricing", group="default", denomination=denomination,
    )

    assert record.input_price == pytest.approx(0.4 * 2 * 6.73)
    assert "denomination" not in record.metadata


def test_fetch_newapi_price_reads_topup_denomination_from_status():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/status":
            return httpx.Response(200, json={"data": {"quota_per_unit": 500000, "price": 6.8, "HeaderNavModules": "{}"}})
        return httpx.Response(200, json={"data": [{"model_name": "gpt-5.6-luna", "model_ratio": 0.02, "completion_ratio": 6}]})

    record = fetch_newapi_price("https://denom.test", "gpt-5.6-luna", client=httpx.Client(transport=httpx.MockTransport(handler)))

    assert record.input_price == pytest.approx(0.272)
    assert record.output_price == pytest.approx(1.632)
    assert record.metadata["denomination"]["source"] == "api_status"


def test_newapi_requires_explicit_group_for_multiple_enabled_groups():
    payload = {
        "group_ratio": {"gpt pro": 0.8, "claude-kiro": 1.2},
        "data": [{"model_name": "gpt-5.6-luna", "enable_groups": ["gpt pro", "claude-kiro"], "model_ratio": 0.5}],
    }

    try:
        newapi_price_record(payload, "gpt-5.6-luna", "https://newapi.test/api/pricing")
    except ValueError as exc:
        assert "必须显式指定 group" in str(exc)
    else:
        raise AssertionError("多分组模型不应依赖响应中的显示顺序选择价格")


def test_newapi_unlabeled_group_keeps_unit_ratio_when_group_rate_missing():
    payload = {
        "group_ratio": {},
        "data": [{"model_name": "gpt-5.6-luna", "enable_groups": ["gpt pro"], "model_ratio": 0.5}],
    }

    record = newapi_price_record(payload, "gpt-5.6-luna", "https://newapi.test/api/pricing")

    assert record.metadata["group"] == "gpt pro"
    assert record.input_price == 1.0 and record.output_price == 1.0


def test_newapi_pricing_rules_supply_output_price_when_top_level_only_has_input():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/status":
            return httpx.Response(200, json={"data": {"HeaderNavModules": "{}"}})
        return httpx.Response(200, json={"data": [{"model_name": "gpt-5.6-sol", "input_price": 5, "model_ratio": 2.5, "pricing_rules": {"tiers": [{"unit_prices": {"input": 5, "output": 30}}]}}]})

    record = fetch_newapi_price("https://rules.test", "gpt-5.6-sol", client=httpx.Client(transport=httpx.MockTransport(handler)))
    assert record.input_price == 5 and record.output_price == 30
    assert record.price_status == "confirmed"


def test_newapi_tiered_mode_uses_pricing_rules_tiers_when_expression_missing():
    payload = {
        "data": [{
            "model_name": "gpt-5.6-sol",
            "billing_mode": "tiered_expr",
            "billing_expr": None,
            "pricing_rules": {"tiers": [
                {"label": "standard", "conditions": [{"operator": "<=", "value": 272000}], "unit_prices": {"input": 1.5, "output": 9, "cache_read": 0.15}},
                {"label": "long", "unit_prices": {"input": 3, "output": 18, "cache_read": 0.3}},
            ]},
            "enable_groups": ["default"],
        }],
        "group_ratio": {"default": 0.5},
    }
    record = newapi_price_record(payload, "gpt-5.6-sol", "https://newapi.test/api/pricing", group="default")
    assert record.price_status == "rule_only"
    assert record.metadata["pricing_rules"]["groups"][0]["tiers"][0]["input_price"] == 0.75


def test_newapi_ratio_pair_takes_precedence_over_incomplete_explicit_price():
    payload = {"data": [{"model_name": "claude-fable-5", "model_ratio": 0.5, "completion_ratio": 4, "input_price": 99}]}
    record = newapi_price_record(payload, "claude-fable-5", "https://newapi.test/api/pricing")
    assert record.input_price == 1.0
    assert record.output_price == 4.0


def test_newapi_accepts_api_pricing_url_without_duplicate_api_path():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/status":
            return httpx.Response(200, json={"data": {"HeaderNavModules": "{}"}})
        assert request.url.path == "/api/pricing"
        return httpx.Response(200, json={"data": [{"model_name": "gpt-5.6-luna", "input_price": 1, "output_price": 2, "unit": "USD/1M tokens"}]})

    record = fetch_newapi_price("https://newapi.test/api/pricing", "gpt-5.6-luna", client=httpx.Client(transport=httpx.MockTransport(handler)))
    assert record.input_price == 1 and record.output_price == 2


def test_detect_site_kind_identifies_newapi_from_public_status():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/status":
            return httpx.Response(200, json={"data": {"HeaderNavModules": "{}"}})
        return httpx.Response(200, text="<html></html>")

    result = detect_site_kind("https://newapi.test/pricing", client=httpx.Client(transport=httpx.MockTransport(handler)))
    assert result["kind"] == "newapi" and result["price_endpoint"] == "https://newapi.test/api/pricing"
