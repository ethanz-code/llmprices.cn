/** 花费计算口径单测：AI Agent 用量拆分（输出 0.4% / 输入按命中率切缓存读取与缓存写入）、
 *  缓存写入价缺失时回落输入价、没填价的档不进总价、URL 编解码往返。 */
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

/** 一条标准用量口径：1 亿总量、命中率 96%、输出占比 0.4%（都是默认值）。 */
const USAGE = { total: TOTAL, hitRate: 96, outputShare: 0.4 };

describe("parseHitRate", () => {
  it("空/非法回落默认 96，超过 100 钳到 100", () => {
    expect(DEFAULT_HIT_RATE).toBe(96);
    expect(parseHitRate("")).toBe(96);
    expect(parseHitRate("abc")).toBe(96);
    expect(parseHitRate("150")).toBe(100);
    // 负数按非法值处理（parseAmount 判负为 null），回落默认而非 0
    expect(parseHitRate("-5")).toBe(96);
    expect(parseHitRate("80")).toBe(80);
  });
});

describe("parseOutputShare", () => {
  it("空/非法回落默认 0.4，超过 100 钳到 100", () => {
    expect(DEFAULT_OUTPUT_SHARE).toBe(0.4);
    expect(parseOutputShare("")).toBe(0.4);
    expect(parseOutputShare("abc")).toBe(0.4);
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

  it("命中率 0 时全部输入都是首次写入缓存", () => {
    const result = calcCost(priced, { ...USAGE, hitRate: 0 });
    expect(lineOf(result, "cacheRead").tokens).toBe(0);
    expect(lineOf(result, "cacheWrite").tokens).toBeCloseTo(99_600_000, 0);
    expect(lineOf(result, "output").tokens).toBeCloseTo(400_000, 0);
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

  it("默认值不写进链接：命中率 96、输出占比 0.4 与空价还原后仍是默认", () => {
    const params = encodeCalcState(EMPTY_STATE);
    expect(params.get("h")).toBeNull();
    expect(params.get("os")).toBeNull();
    expect(params.get("pw")).toBeNull();
    expect(decodeCalcState(params).hitRate).toBe(96);
    expect(decodeCalcState(params).outputShare).toBe(0.4);
  });
});
