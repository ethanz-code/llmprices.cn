/** 花费计算口径单测：用量拆分（输出占比 × 缓存命中率 → 四档 token）、缓存档缺价时的回落、
 *  没填价的档不进总价、默认口径（会话式：输出 2% / 命中率 96%）、单价文本收敛、URL 编解码往返。 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_HIT_RATE,
  DEFAULT_OUTPUT_SHARE,
  EMPTY_PRICES,
  EMPTY_STATE,
  PRICE_KEYS,
  calcCost,
  decodeCalcState,
  encodeCalcState,
  formatPriceText,
  hasAnyPrice,
  parseHitRate,
  parseOutputShare,
  type CalcPrices,
} from "@/lib/calculator";

/** 取某档明细行（四档固定返回，顺序与 PRICE_KEYS 一致）。 */
function lineOf(result: ReturnType<typeof calcCost>, key: string) {
  const line = result.lines.find((item) => item.key === key);
  if (!line) throw new Error(`缺少 ${key} 档`);
  return line;
}

const TOTAL = 100_000_000; // 1 亿

/** 一条显式的重缓存口径：1 亿总量、命中率 96%、输出占比 0.4%（旧默认那套，用来钉住拆分公式）。 */
const USAGE = { total: TOTAL, hitRate: 96, outputShare: 0.4 };

describe("默认口径", () => {
  it("按「反复带同一段前缀的会话式用法」给：输出 2%、命中率 96%", () => {
    expect(DEFAULT_OUTPUT_SHARE).toBe(2);
    expect(DEFAULT_HIT_RATE).toBe(96);
  });

  it("留空回落默认：与显式填 2/96 算出来的是同一笔账", () => {
    const prices: CalcPrices = { input: 1, output: 10, cacheRead: 0.1, cacheWrite: null };
    const byDefault = calcCost(prices, { total: TOTAL, hitRate: null, outputShare: null });
    const byExplicit = calcCost(prices, { total: TOTAL, hitRate: 96, outputShare: 2 });
    expect(byDefault.total).toBeCloseTo(byExplicit.total, 6);
  });

  it("完全没走缓存（命中率 0 / 输出 20）比默认口径贵近一个量级", () => {
    // 输入 1 / 输出 10 / 缓存读 0.1（元每百万 token），站点没报缓存写入价
    const prices: CalcPrices = { input: 1, output: 10, cacheRead: 0.1, cacheWrite: null };
    const byDefault = calcCost(prices, { total: TOTAL, hitRate: null, outputShare: null });
    const noCache = calcCost(prices, { total: TOTAL, hitRate: 0, outputShare: 20 });
    // 默认口径：9800 万输入池里 9408 万走 0.1 的读价、剩下 392 万按输入价，输出 200 万
    expect(byDefault.total).toBeCloseTo(9.408 + 3.92 + 20, 4);
    // 全按输入/输出价：8000 万输入 × 1 + 2000 万输出 × 10 = 280
    expect(noCache.total).toBeCloseTo(280, 4);
    expect(noCache.total).toBeGreaterThan(byDefault.total * 8);
  });
});

describe("parseHitRate", () => {
  it("空/非法回落默认 96，明确填 0 就是 0，超过 100 钳到 100", () => {
    expect(parseHitRate("")).toBe(96);
    expect(parseHitRate("abc")).toBe(96);
    expect(parseHitRate("150")).toBe(100);
    // 负数按非法值处理（parseAmount 判负为 null），回落默认而非 0 以外的东西
    expect(parseHitRate("-5")).toBe(96);
    expect(parseHitRate("80")).toBe(80);
    // 0 是合法用法（这批用量没走缓存），不能被当成「没填」顶回默认值
    expect(parseHitRate("0")).toBe(0);
  });
});

describe("parseOutputShare", () => {
  it("空/非法回落默认 2，超过 100 钳到 100", () => {
    expect(parseOutputShare("")).toBe(2);
    expect(parseOutputShare("abc")).toBe(2);
    expect(parseOutputShare("150")).toBe(100);
    expect(parseOutputShare("5")).toBe(5);
  });
});

describe("calcCost 用量拆分", () => {
  const priced: CalcPrices = { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1.25 };

  it("输出占 0.4%，输入池按命中率切缓存读取与缓存写入", () => {
    const result = calcCost(priced, USAGE);
    expect(lineOf(result, "output").tokens).toBe(400_000);
    expect(lineOf(result, "cacheRead").tokens).toBeCloseTo(95_616_000, 0);
    expect(lineOf(result, "cacheWrite").tokens).toBeCloseTo(3_984_000, 0);
    // 填了缓存写入价，非命中输入计入缓存写入，输入档为 0（同一批 token 不重复计）
    expect(lineOf(result, "input").tokens).toBe(0);
  });

  it("各档小计与合计按每百万单价计算", () => {
    const result = calcCost(priced, USAGE);
    expect(lineOf(result, "cacheRead").subtotal).toBeCloseTo(9.5616, 4);
    expect(lineOf(result, "cacheWrite").subtotal).toBeCloseTo(4.98, 4);
    expect(lineOf(result, "output").subtotal).toBeCloseTo(4, 4);
    expect(result.total).toBeCloseTo(18.5416, 4);
  });

  it("没填缓存写入价时，非命中输入回落按输入价计", () => {
    const result = calcCost({ ...priced, cacheWrite: null }, USAGE);
    expect(lineOf(result, "cacheWrite").tokens).toBe(0);
    expect(lineOf(result, "input").tokens).toBeCloseTo(3_984_000, 0);
    expect(lineOf(result, "input").subtotal).toBeCloseTo(3.984, 4);
    expect(result.total).toBeCloseTo(17.5456, 4);
  });

  it("命中率 0：整池输入按普通输入计，不记到缓存写入档", () => {
    const result = calcCost(priced, { ...USAGE, hitRate: 0 });
    expect(lineOf(result, "cacheRead").tokens).toBe(0);
    expect(lineOf(result, "cacheWrite").tokens).toBe(0);
    expect(lineOf(result, "input").tokens).toBeCloseTo(99_600_000, 0);
    expect(lineOf(result, "output").tokens).toBeCloseTo(400_000, 0);
    // 写入价 1.25 比输入价 1 贵：不记到写入档才不会凭空估高
    expect(result.total).toBeCloseTo(99.6 + 4, 4);
  });

  it("输出占比可改：改大后输出分到更多 token，输入池相应缩小", () => {
    const result = calcCost(priced, { ...USAGE, outputShare: 5 });
    expect(lineOf(result, "output").tokens).toBe(5_000_000);
    expect(lineOf(result, "cacheRead").tokens).toBeCloseTo(91_200_000, 0);
    expect(lineOf(result, "cacheWrite").tokens).toBeCloseTo(3_800_000, 0);
  });

  it("没填价的档不进总价：占比为 null，其余档照常计", () => {
    const result = calcCost({ ...priced, cacheRead: null }, USAGE);
    const cacheRead = lineOf(result, "cacheRead");
    expect(cacheRead.unitPrice).toBeNull();
    expect(cacheRead.subtotal).toBeNull();
    expect(cacheRead.share).toBeNull();
    expect(result.total).toBeCloseTo(4.98 + 4, 4);
  });

  it("四档固定返回，顺序与 PRICE_KEYS 一致", () => {
    const result = calcCost(priced, USAGE);
    expect(result.lines.map((line) => line.key)).toEqual(PRICE_KEYS);
  });

  it("用量为 0 时总价 0、占比全 null", () => {
    const result = calcCost(priced, { ...USAGE, total: 0 });
    expect(result.total).toBe(0);
    expect(result.lines.every((line) => line.share === null)).toBe(true);
  });
});

describe("formatPriceText 单价收敛", () => {
  it("浮点噪声与循环小数都收敛成短小数", () => {
    expect(formatPriceText(0.2499999999999999)).toBe("0.25");
    expect(formatPriceText(0.5249999999999999)).toBe("0.525");
    expect(formatPriceText(14.399999999999999)).toBe("14.4");
    expect(formatPriceText(0.38457142857142856)).toBe("0.384571");
    expect(formatPriceText(12.498571428571429)).toBe("12.4986");
  });

  it("小单价保留有效位，不被抹成 0", () => {
    expect(formatPriceText(0.00064713)).toBe("0.00064713");
    expect(formatPriceText(0.001)).toBe("0.001");
    expect(formatPriceText(1401.6)).toBe("1401.6");
  });

  it("极小的值不用指数写法（输入框里读不出量级）", () => {
    expect(formatPriceText(0.0000005)).toBe("0.0000005");
    expect(formatPriceText(1e-7)).toBe("0.0000001");
    // 小到 12 位小数都印不出来时才退回原样，宁可给指数也不给空框
    expect(formatPriceText(1e-13)).toBe("1e-13");
  });

  it("空值留空、0 原样、非数留空", () => {
    expect(formatPriceText(null)).toBe("");
    expect(formatPriceText(undefined)).toBe("");
    expect(formatPriceText(Number.NaN)).toBe("");
    expect(formatPriceText(0)).toBe("0");
  });
});

describe("hasAnyPrice", () => {
  it("任一档填了就为真", () => {
    expect(hasAnyPrice(EMPTY_PRICES)).toBe(false);
    expect(hasAnyPrice({ ...EMPTY_PRICES, cacheWrite: 1.25 })).toBe(true);
  });
});

describe("URL 编解码", () => {
  it("含缓存写入价与两个假设的四档往返保真", () => {
    const state = {
      ...EMPTY_STATE,
      prices: { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1.25 },
      hitRate: 80,
      outputShare: 5,
      totalTokens: 10_000_000,
    };
    const decoded = decodeCalcState(encodeCalcState(state));
    expect(decoded.prices).toEqual(state.prices);
    expect(decoded.hitRate).toBe(80);
    expect(decoded.outputShare).toBe(5);
    expect(decoded.totalTokens).toBe(10_000_000);
  });

  it("默认值不写进链接：命中率 96、输出占比 2 与空价还原后仍是默认", () => {
    const params = encodeCalcState(EMPTY_STATE);
    expect(params.get("h")).toBeNull();
    expect(params.get("os")).toBeNull();
    expect(params.get("pw")).toBeNull();
    expect(decodeCalcState(params).hitRate).toBe(96);
    expect(decodeCalcState(params).outputShare).toBe(2);
  });
});
