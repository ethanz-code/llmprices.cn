/** 展示口径纯函数：相对时间、跨币种折算、阶梯价与格式化——金额展示的地基，先钉住。 */
import { describe, expect, it } from "vitest";

import {
  cachePriceText,
  effectiveCnyCachePrice,
  effectiveCnyPrice,
  formatPrice,
  formatTimeAgo,
  toCnyPrice,
  tieredPrices,
} from "@/lib/format";

describe("formatTimeAgo", () => {
  it("分钟/小时/天三档与未来回落", () => {
    const now = Date.parse("2026-10-04T12:00:00+08:00");
    expect(formatTimeAgo(now / 1000 - 30, now)).toBe("刚刚");
    expect(formatTimeAgo(now / 1000 - 5 * 60, now)).toBe("5 分钟前");
    expect(formatTimeAgo(now / 1000 - 3 * 3600, now)).toBe("3 小时前");
    expect(formatTimeAgo(now / 1000 - 2 * 86400, now)).toBe("2 天前");
    // 未来时间/超 30 天回落绝对日期，不出现负数或"未来前"
    expect(formatTimeAgo(now / 1000 + 60, now)).toMatch(/^\d{4}\/\d{1,2}\/\d{1,2}$/);
  });

  it("兼容秒级与毫秒级时间戳", () => {
    const now = Date.now();
    expect(formatTimeAgo((now - 120_000) / 1000, now)).toBe("2 分钟前");
    expect(formatTimeAgo(now - 120_000, now)).toBe("2 分钟前");
  });
});

describe("toCnyPrice / effectiveCnyPrice", () => {
  it("CNY 原样、USD 按汇率折算、无汇率或未知币种返回 null", () => {
    expect(toCnyPrice(8, "CNY/1M tokens", 7.2)).toBe(8);
    expect(toCnyPrice(2, "USD/1M tokens", 7.2)).toBeCloseTo(14.4);
    expect(toCnyPrice(2, "USD/1M tokens", null)).toBeNull();
    expect(toCnyPrice(2, "EUR/1M tokens", 7.2)).toBeNull();
    expect(toCnyPrice(null, "USD/1M tokens", 7.2)).toBeNull();
  });

  it("排序用有效价：顶层价优先，缺顶层回落阶梯最低档", () => {
    expect(effectiveCnyPrice({ input_price: 3, unit: "USD/1M" }, "input_price", 7)).toBe(21);
    const tiered = {
      unit: "USD/1M",
      metadata: { pricing_rules: { groups: [{ tiers: [{ input_price: 6 }, { input_price: 2 }] }] } },
    };
    expect(effectiveCnyPrice(tiered, "input_price", 7)).toBe(14);
    expect(effectiveCnyPrice(tiered, "input_price", null)).toBe(2); // 折不了就回落原币，保证可排序
  });

  it("阶梯价至少两档才算阶梯，单档已被回填到顶层", () => {
    const single = {
      metadata: { pricing_rules: { groups: [{ tiers: [{ input_price: 5 }] }] } },
    };
    expect(tieredPrices(single, "input_price")).toEqual([]);
  });
});

describe("cachePriceText / effectiveCnyCachePrice", () => {
  // tiered_expr 记录的缓存价只存在 pricing_rules.groups[].tiers[]（实测 136 条顶层全空）
  const tiered = {
    unit: "CNY/1M tokens",
    metadata: {
      cache_read_price: null,
      pricing_rules: {
        groups: [
          { tiers: [{ name: "standard", cache_read_price: 0.018, cache_create_price: 0.225 }] },
        ],
      },
    },
  };

  it("顶层缺失时回落阶梯第一档", () => {
    expect(cachePriceText(tiered, "cache_read_price")).toBe("¥0.018");
    expect(effectiveCnyCachePrice(tiered, "cache_create_price", null)).toBe(0.225);
  });

  it("顶层有值优先，两处都缺返回 null", () => {
    expect(
      cachePriceText({ unit: "CNY/1M tokens", metadata: { cache_read_price: 0.5 } }, "cache_read_price"),
    ).toBe("¥0.5");
    expect(cachePriceText({ unit: "CNY/1M tokens", metadata: {} }, "cache_read_price")).toBeNull();
  });
});

describe("formatPrice", () => {
  it("按量级取小数位并去掉尾零", () => {
    expect(formatPrice(120)).toBe("120");
    expect(formatPrice(3.5)).toBe("3.5");
    expect(formatPrice(0.125)).toBe("0.125");
    expect(formatPrice(null)).toBe("—");
  });
});
