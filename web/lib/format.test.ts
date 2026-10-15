/** 展示规则纯函数：相对时间、跨币种折算、阶梯价与格式化——金额展示的地基，先钉住。 */
import { describe, expect, it } from "vitest";

import {
  cachePriceText,
  effectiveCnyCachePrice,
  effectiveCnyPrice,
  formatCompact,
  formatPrice,
  formatTimeAgo,
  formatTokens,
  noticeExcerpt,
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

  it("千位补逗号，小数部分不受影响", () => {
    expect(formatPrice(1200)).toBe("1,200");
    expect(formatPrice(1234.5)).toBe("1,234.5");
  });
});

describe("formatCompact / formatTokens", () => {
  it("千以下原样，往上 k/M/B 一位小数，999,960 进位成 1M", () => {
    expect(formatCompact(950)).toBe("950");
    expect(formatCompact(9500)).toBe("9.5k");
    expect(formatCompact(134_700)).toBe("134.7k");
    expect(formatCompact(969_713)).toBe("969.7k");
    expect(formatCompact(1_200_000)).toBe("1.2M");
    expect(formatCompact(999_960)).toBe("1M");
    expect(formatCompact(2_300_000_000)).toBe("2.3B");
  });

  it("formatTokens 与 formatCompact 同一套规则（272k 小写）", () => {
    expect(formatTokens(272_000)).toBe("272k");
    expect(formatTokens(1_000_000)).toBe("1M");
  });
});

/** 公告摘要规则：后端 llm_price_monitor/feed_page.py 的 notice_excerpt 是同一套规则
 *  （事件流为省体积只下发摘要），下面这批样例在 tests/test_feed_page.py 里有逐条对应断言，
 *  改规则时两边一起改，否则页面上的摘要会与后端下发的不一致。 */
describe("noticeExcerpt", () => {
  const cases: [string, string][] = [
    ["<div>公告</div>\n<p>第二行</p>", "公告"],
    ["# 标题\n正文", "标题"],
    ["###   带空格的标题\n正文", "带空格的标题"],
    ["\n\n   \n只有一个段落", "只有一个段落"],
    ["", ""],
  ];

  it.each(cases)("剥掉标签与标题井号后取首行：%j", (content, expected) => {
    expect(noticeExcerpt(content)).toBe(expected);
  });

  it("超过 120 字截断加省略号", () => {
    expect(noticeExcerpt("字".repeat(200))).toBe(`${"字".repeat(120)}…`);
  });
});
