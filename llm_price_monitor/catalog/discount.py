"""折扣计算：站点价格 vs 官方价的对比与折扣率。

计算为纯函数，输入输出都是 dict/list；文件 IO 由 CLI 层完成。
站点价按记录 unit 折算 CNY，官方价按条目 currency 折算 CNY 后相除，
汇率在分子分母同时出现，因此折扣率与汇率标准无关。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .normalize import model_key, round2


@dataclass(frozen=True)
class DiscountEntry:
    """一条 (站点, 模型, 分组) 的对比结果。"""

    site_id: str
    model: str
    group: Any
    input_discount: Any
    output_discount: Any
    site_input_cny: Any
    site_output_cny: Any
    official_input_cny: Any
    official_output_cny: Any
    source_url: str
    region: str | None = None  # 折扣基准规则：cn=国内站官方价 / global=国际站官方价
    # 未取整的原始比值：sanity 判界专用。input_discount 为展示用的两位小数，
    # 低于 0.005 的折扣会被取整成 0，判界必须用原始值（model101 x0.01 折扣组实证）
    input_ratio: float | None = None
    output_ratio: float | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "input": self.input_discount,
            "output": self.output_discount,
            "input_price_cny": self.site_input_cny,
            "output_price_cny": self.site_output_cny,
            "official_input_cny": self.official_input_cny,
            "official_output_cny": self.official_output_cny,
            "source_url": self.source_url,
            "region": self.region,
        }


def build_discount(
    row: dict[str, Any],
    official_models: dict[str, Any],
    rate: float,
) -> tuple[DiscountEntry | None, str | None]:
    """单条记录的折扣计算；返回 (条目, None) 或 (None, 跳过原因)。全部折算成 CNY 后相除。"""
    official_entry = official_models.get(model_key(str(row.get("model", ""))))
    if not isinstance(official_entry, dict) or not official_entry.get("found"):
        return None, "厂商价目录中没有该模型的可用定价"
    site_input, site_output = _site_prices(row)
    if site_input is None and site_output is None:
        return None, "站点未拿到可用价格"

    list_prices = official_entry.get("list") or {}
    official_currency = str(official_entry.get("currency") or "USD").upper()

    def to_cny(value: Any, *, currency: str = "CNY", unit: str | None = None) -> Any:
        """官方价按条目 currency 换算；站点价按记录 unit 换算。"""
        if value is None:
            return None
        is_usd = ("USD" in unit.upper()) if unit is not None else currency == "USD"
        return round2(value * rate) if is_usd else round2(value)

    official_input_cny = to_cny(list_prices.get("input"), currency=official_currency)
    official_output_cny = to_cny(list_prices.get("output"), currency=official_currency)
    site_input_cny = to_cny(site_input, unit=row.get("unit"))
    site_output_cny = to_cny(site_output, unit=row.get("unit"))

    input_ratio = site_input_cny / official_input_cny if site_input_cny and official_input_cny else None
    output_ratio = site_output_cny / official_output_cny if site_output_cny and official_output_cny else None
    entry = DiscountEntry(
        site_id=row.get("site_id"),
        model=row.get("model"),
        group=row.get("group"),
        input_discount=round2(input_ratio) if input_ratio is not None else None,
        output_discount=round2(output_ratio) if output_ratio is not None else None,
        site_input_cny=site_input_cny,
        site_output_cny=site_output_cny,
        official_input_cny=official_input_cny,
        official_output_cny=official_output_cny,
        source_url=official_entry.get("source_url") or "",
        region=official_entry.get("region"),
        input_ratio=input_ratio,
        output_ratio=output_ratio,
    )
    return entry, None


# 价格合理性边界：站点价 / 厂商价 落在 (0.01, 20) 之外视为提取事故（单位换算翻车、
# 幻觉价格）。上界依据：在售中转站实测最高约 2.8 倍厂商价，20 倍留足余量；
# 下界拦"两百万/1M tokens"这类放大百万倍的换算事故；0 元价不在数值上判真伪。
SANITY_MIN_RATIO = 0.01
SANITY_MAX_RATIO = 20.0
# 结构化 API 字段直采（explicit_price + network adapter）无"提取"环节，只剩单位标准
# 风险——错位量级是千倍/百万倍，上界放宽到 500 以放行订阅套餐转售真价（totokens CC-MAX
# 组实测约 149 倍官价，站方页面明码），千倍以上的单位错位仍拦。
SANITY_DIRECT_MAX_RATIO = 500.0
# 结构直采行的下界同步放宽：倍率/表达式/显式价直读同样没有提取环节，站方把某个分组
# 定到官价 1% 以下是真事——2026-10-14 model101「限时折扣测试组」x0.01 实价 ¥0.04
# （页面明码）触发 1% 下界被判"提取错误"两轮作废。放宽到 1e-4：÷1e6 级换算事故（1e-6）
# 仍拦得住，实测真实在售最低值 1.5e-3 留 15 倍余量；页面/AI 提取行维持 1e-2 严格下界。
SANITY_DIRECT_MIN_RATIO = 0.0001
# 无提取环节的行按 adapter 判定（network=JSON 直采解析、browser_network=直采成功）；
# page_table 是 HTML 表格文本解析，虽非 AI 但仍是文本提取，按下界严格档处理。
_SANITY_STRUCTURED_ADAPTERS = frozenset({"network", "browser_network"})
_SANITY_EXTRACTED_KINDS = frozenset({"page_table"})


# 产品决策（与上面的提取校验分开）：站点价折合后**高于官方价**（折扣 > 100%）对用户没有
# 参考意义——「比官价还贵」中转站没有选择价值。这类行不展示、采集侧也不入快照。
# 判定要有官方基准才成立：目录没收录/没价的条目无法比较，放行。
ABOVE_OFFICIAL_MAX_RATIO = 1.0


def above_official(row: dict[str, Any], official_models: dict[str, Any], rate: float) -> bool:
    """站点价折算 CNY 后是否高于官方价（输入/输出任一轴折扣 > 100% 即为真）。无基准返回 False。"""
    if not official_models or rate is None:
        return False
    entry, _reason = build_discount(row, official_models, rate)
    if entry is None:
        return False
    for ratio in (entry.input_discount, entry.output_discount):
        if isinstance(ratio, (int, float)) and ratio > ABOVE_OFFICIAL_MAX_RATIO:
            return True
    return False


def structured_direct_row(row: dict[str, Any]) -> bool:
    """该行的价格是否来自结构化直采（JSON 字段直读，无提取环节）：
    adapter=network/browser_network 且 pricing_kind 不是文本表格解析。"""
    metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
    adapter = str(metadata.get("adapter") or "")
    price_kind = str(metadata.get("pricing_kind") or "")
    return adapter in _SANITY_STRUCTURED_ADAPTERS and price_kind not in _SANITY_EXTRACTED_KINDS


def sanity_violation(row: dict[str, Any], official_models: dict[str, Any], rate: float) -> str | None:
    """价格合理性校验：站点价与厂商价的比例超出可信边界时返回中文原因，正常或无法判据返回 None。

    无法判据包括目录无该模型、站点无价；0 元价同样不拦——可能是真零价，数值上分不清真伪。
    结构化直采的价（explicit_price + network adapter）数值直接来自站方接口字段，上界放宽；
    结构直采（adapter=network/browser_network、非 page_table 文本解析）的下界同样放宽——
    这类行只有单位标准风险，站方真把某分组定到官价 0.15% 也属真价；
    页面文本/AI 提取的价维持严格上下界。
    """
    entry, _reason = build_discount(row, official_models, rate)
    if entry is None:
        return None
    metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
    price_kind = str(metadata.get("pricing_kind") or "")
    adapter = str(metadata.get("adapter") or "")
    direct = price_kind == "explicit_price" and adapter == "network"
    structured = structured_direct_row(row)
    max_ratio = SANITY_DIRECT_MAX_RATIO if direct else SANITY_MAX_RATIO
    min_ratio = SANITY_DIRECT_MIN_RATIO if structured else SANITY_MIN_RATIO
    for label, ratio, site_price, official_price in (
        ("输入", entry.input_ratio, entry.site_input_cny, entry.official_input_cny),
        ("输出", entry.output_ratio, entry.site_output_cny, entry.official_output_cny),
    ):
        if ratio is None:
            continue
        if ratio < min_ratio or ratio > max_ratio:
            shown = f"{ratio:.4f}" if ratio < 0.01 else f"{ratio:.0f}"
            return f"站点{label}价 {site_price} 为厂商价 {official_price} 的 {shown} 倍，超出可信区间，判定为提取错误"
    return None


def _site_prices(row: dict[str, Any]) -> tuple[Any, Any]:
    """顶层价格优先；阶梯记录顶层为空时取第一档（standard）价格。"""
    site_input, site_output = row.get("input_price"), row.get("output_price")
    tiers = row.get("tiers") or []
    if (site_input is None or site_output is None) and tiers:
        first = tiers[0]
        site_input = site_input if site_input is not None else first.get("input_price")
        site_output = site_output if site_output is not None else first.get("output_price")
    return site_input, site_output
