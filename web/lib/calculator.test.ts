/** 花费计算口径单测：四档 token 直接计价、缓存档缺价回落输入价、估算场景预设折算、
 *  单价浮点噪声收敛、URL 编解码与老链接迁移。 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_HIT_RATE,
  DEFAULT_OUTPUT_SHARE,
  EMPTY_PRICES,
  EMPTY_STATE,
  EMPTY_TOKENS,
  ESTIMATE_PRESETS,
  PRICE_KEYS,
  calcCost,
  decodeCalcState,
  encodeCalcState,
  estimateTokens,
  formatAmount,
  formatPriceText,
  hasAnyPrice,
  hasAnyToken,
  matchPreset,
  parseHitRate,
  parseOutputShare,
  type CalcPrices,
  type PriceKey,
  type UsageTokens,
} from "@/lib/calculator";

/** 取某档明细行（四档固定返回，顺序与 PRICE_KEYS 一致）。 */
function lineOf(result: ReturnType<typeof calcCost>, key: string) {
  const line = result.lines.find((item) => item.key === key);
  if (!line) throw new Error(`缺少 ${key} 档`);
  return line;
}

function tokens(over: Partial<UsageTokens> = {}): UsageTokens {
  return { ...EMPTY_TOKENS, ...over };
}

const TOTAL = 100_000_000; // 1 亿

describe("估算场景预设", () => {
  it("三个场景的比率与出处一致，默认取普通对话（不算缓存）", () => {
    expect(ESTIMATE_PRESETS.map((item) => item.key)).toEqual(["chat", "agent", "longdoc"]);
    expect(ESTIMATE_PRESETS.find((item) => item.key === "agent")).toMatchObject({
      outputShare: 0.4,
      hitRate: 96,
    });
    // 默认场景不再假设重缓存：没开缓存的用户按老默认值会看到只有实际几分之一的花费
    expect(DEFAULT_OUTPUT_SHARE).toBe(20);
    expect(DEFAULT_HIT_RATE).toBe(0);
  });

  it("按两个比率反查场景：手改过就查不到", () => {
    expect(matchPreset(20, 0)?.key).toBe("chat");
    expect(matchPreset(0.4, 96)?.key).toBe("agent");
    expect(matchPreset(5, 0)?.key).toBe("longdoc");
    expect(matchPreset(15, 0)).toBeNull();
    expect(matchPreset(0.4, 90)).toBeNull();
  });
});

describe("parseHitRate / parseOutputShare", () => {
  it("空/非法回落默认场景的值，超过 100 钳到 100", () => {
    expect(parseHitRate("")).toBe(0);
    expect(parseHitRate("abc")).toBe(0);
    expect(parseHitRate("150")).toBe(100);
    // 负数按非法值处理（parseAmount 判负为 null），回落默认而非 0
    expect(parseHitRate("-5")).toBe(0);
    expect(parseHitRate("80")).toBe(80);

    expect(parseOutputShare("")).toBe(20);
    expect(parseOutputShare("abc")).toBe(20);
    expect(parseOutputShare("150")).toBe(100);
    expect(parseOutputShare("0.4")).toBe(0.4);
  });
});

describe("estimateTokens 估算 → 四档用量", () => {
  it("普通对话（输出 20%、不算缓存）：输入池整池记普通输入", () => {
    const filled = estimateTokens({ total: TOTAL, hitRate: 0, outputShare: 20 });
    expect(filled.output).toBe(20_000_000);
    expect(filled.input).toBe(80_000_000);
    // 没走缓存就不能记到缓存档：写入价多数站点比输入价贵，记错会凭空估高
    expect(filled.cacheRead).toBe(0);
    expect(filled.cacheWrite).toBe(0);
  });

  it("编码 Agent（输出 0.4%、命中率 96%）：命中段读缓存、未命中段写缓存", () => {
    const filled = estimateTokens({ total: TOTAL, hitRate: 96, outputShare: 0.4 });
    expect(filled.output).toBe(400_000);
    expect(filled.cacheRead).toBe(95_616_000);
    expect(filled.cacheWrite).toBe(3_984_000);
    expect(filled.input).toBe(0);
  });

  it("长文分析（输出 5%、不算缓存）", () => {
    const filled = estimateTokens({ total: TOTAL, hitRate: 0, outputShare: 5 });
    expect(filled.output).toBe(5_000_000);
    expect(filled.input).toBe(95_000_000);
    expect(filled.cacheRead).toBe(0);
  });

  it("缺省回落默认场景；命中率 100 时全部走缓存读取", () => {
    expect(estimateTokens({ total: TOTAL, hitRate: null, outputShare: null }).input).toBe(80_000_000);
    const allCached = estimateTokens({ total: TOTAL, hitRate: 100, outputShare: 20 });
    expect(allCached.cacheRead).toBe(80_000_000);
    expect(allCached.cacheWrite).toBe(0);
    expect(allCached.input).toBe(0);
  });

  it("取整后四档加总严格等于总用量（明细表逐行加起来不会跟总量对不上）", () => {
    const totals = [10_000_000, 99_999_999, 100_000_000, 1_000_000_000];
    for (const preset of ESTIMATE_PRESETS) {
      for (const total of totals) {
        const filled = estimateTokens({ total, hitRate: preset.hitRate, outputShare: preset.outputShare });
        const sum = PRICE_KEYS.reduce((acc, key) => acc + (filled[key] ?? 0), 0);
        expect(sum, `${preset.key} / ${total}`).toBe(total);
      }
    }
  });

  it("总用量为 0 时四档全 0", () => {
    const filled = estimateTokens({ total: 0, hitRate: 96, outputShare: 0.4 });
    expect(PRICE_KEYS.every((key) => filled[key] === 0)).toBe(true);
  });
});

describe("calcCost 四档计价", () => {
  const priced: CalcPrices = { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1.25 };

  it("各档独立计价：token 数 × 单价 ÷ 100 万", () => {
    const result = calcCost(
      priced,
      tokens({ input: 1_000_000, output: 2_000_000, cacheRead: 10_000_000, cacheWrite: 4_000_000 }),
    );
    expect(lineOf(result, "input").subtotal).toBeCloseTo(1, 6);
    expect(lineOf(result, "output").subtotal).toBeCloseTo(20, 6);
    expect(lineOf(result, "cacheRead").subtotal).toBeCloseTo(1, 6);
    expect(lineOf(result, "cacheWrite").subtotal).toBeCloseTo(5, 6);
    expect(result.total).toBeCloseTo(27, 6);
  });

  it("填多少算多少：四档不拆分、不搬移（账单一档为 0 就是 0）", () => {
    const result = calcCost(priced, tokens({ input: 50_000_000 }));
    expect(lineOf(result, "input").tokens).toBe(50_000_000);
    expect(lineOf(result, "cacheRead").tokens).toBe(0);
    expect(lineOf(result, "cacheWrite").tokens).toBe(0);
    expect(lineOf(result, "output").tokens).toBe(0);
  });

  it("费用占比按小计摊，加总为 1", () => {
    const result = calcCost(
      priced,
      tokens({ input: 1_000_000, output: 2_000_000, cacheRead: 10_000_000, cacheWrite: 4_000_000 }),
    );
    const sum = result.lines.reduce((acc, line) => acc + (line.share ?? 0), 0);
    expect(sum).toBeCloseTo(1, 10);
    expect(lineOf(result, "output").share).toBeCloseTo(20 / 27, 10);
  });

  it("缓存档没填价时回落按输入价并标记 fallback", () => {
    const result = calcCost({ ...priced, cacheRead: null, cacheWrite: null }, tokens({ cacheRead: 1_000_000, cacheWrite: 1_000_000 }));
    for (const key of ["cacheRead", "cacheWrite"] as PriceKey[]) {
      const line = lineOf(result, key);
      expect(line.unitPrice).toBe(1);
      expect(line.fallback).toBe(true);
      expect(line.subtotal).toBeCloseTo(1, 6);
    }
    // 输入/输出两档本来就有价，不会被打上回落标记
    expect(lineOf(result, "input").fallback).toBe(false);
    expect(lineOf(result, "output").fallback).toBe(false);
  });

  it("缓存价标 0（免费）算自家价，不回落也不计费", () => {
    const result = calcCost({ ...priced, cacheRead: 0 }, tokens({ cacheRead: 1_000_000 }));
    const line = lineOf(result, "cacheRead");
    expect(line.unitPrice).toBe(0);
    expect(line.fallback).toBe(false);
    expect(line.subtotal).toBe(0);
    expect(result.total).toBe(0);
  });

  it("连输入价都没有时缓存档不计入总价：小计与占比为 null", () => {
    const result = calcCost({ ...EMPTY_PRICES, output: 10 }, tokens({ cacheRead: 1_000_000, output: 1_000_000 }));
    const cacheRead = lineOf(result, "cacheRead");
    expect(cacheRead.unitPrice).toBeNull();
    expect(cacheRead.subtotal).toBeNull();
    expect(cacheRead.share).toBeNull();
    // 用量照实展示，别让整行消失
    expect(cacheRead.tokens).toBe(1_000_000);
    expect(result.total).toBeCloseTo(10, 6);
  });

  it("四档固定返回，顺序与 PRICE_KEYS 一致", () => {
    const result = calcCost(priced, tokens({ input: 1 }));
    expect(result.lines.map((line) => line.key)).toEqual(PRICE_KEYS);
  });

  it("用量为 0 时总价 0、占比全 null", () => {
    const result = calcCost(priced, EMPTY_TOKENS);
    expect(result.total).toBe(0);
    expect(result.lines.every((line) => line.share === null)).toBe(true);
  });
});

describe("formatPriceText 单价文本", () => {
  it("收敛真实数据里的浮点噪声与循环小数（选中模型后输入框不再是一长串小数）", () => {
    // 下面这些值都是站点价接口实测回传的原值
    expect(formatPriceText(0.5249999999999999)).toBe("0.525");
    expect(formatPriceText(0.24999999999999997)).toBe("0.25");
    expect(formatPriceText(0.8999999999999999)).toBe("0.9");
    expect(formatPriceText(14.399999999999999)).toBe("14.4");
    expect(formatPriceText(0.13460000000000003)).toBe("0.1346");
    expect(formatPriceText(0.0006471300000000001)).toBe("0.00064713");
    expect(formatPriceText(0.0029786625)).toBe("0.00297866");
    expect(formatPriceText(1401.6)).toBe("1401.6");
  });

  it("不用指数写法：小于 1e-6 的单价落到定长小数", () => {
    expect(formatPriceText(0.0000005)).toBe("0.0000005");
    expect(formatPriceText(1e-7)).toBe("0.0000001");
    // 小到定长小数印不出来时退回原样，不返回空串（空串在输入框里等于「这一档没填」）
    expect(formatPriceText(1e-13)).not.toBe("");
  });

  it("0 显示 0、null/undefined 留空（留空就是这一档没填）", () => {
    expect(formatPriceText(0)).toBe("0");
    expect(formatPriceText(null)).toBe("");
    expect(formatPriceText(undefined)).toBe("");
    expect(formatPriceText(Number.NaN)).toBe("");
  });

  it("任何输入都不产出超过 12 个字符或带 e 的文本", () => {
    const sample = [0.5249999999999999, 1e-7, 14.399999999999999, 0.0006471300000000001, 1e6, 123456.789, 0.1 + 0.2];
    for (const value of sample) {
      const text = formatPriceText(value);
      expect(text.includes("e"), `${value} → ${text}`).toBe(false);
      expect(text.length, `${value} → ${text}`).toBeLessThanOrEqual(12);
    }
    // 0.1 + 0.2 这类经典噪声也要收敛掉
    expect(formatPriceText(0.1 + 0.2)).toBe("0.3");
  });
});

describe("formatAmount 金额文本", () => {
  it("大额少留位、小额多留位，整数与 0 原样", () => {
    expect(formatAmount(0)).toBe("0");
    expect(formatAmount(12.3456)).toBe("12.35");
    expect(formatAmount(0.0004)).toBe("0.0004");
    expect(formatAmount(1.5)).toBe("1.5");
    expect(formatAmount(null)).toBe("—");
  });
});

describe("hasAnyPrice / hasAnyToken", () => {
  it("任一档填了就为真", () => {
    expect(hasAnyPrice(EMPTY_PRICES)).toBe(false);
    expect(hasAnyPrice({ ...EMPTY_PRICES, cacheWrite: 1.25 })).toBe(true);
    expect(hasAnyToken(EMPTY_TOKENS)).toBe(false);
    expect(hasAnyToken(tokens({ output: 1 }))).toBe(true);
  });
});

describe("URL 编解码", () => {
  it("四档单价 + 四档用量 + 场景往返保真", () => {
    const state = {
      ...EMPTY_STATE,
      prices: { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1.25 },
      tokens: { input: null, output: 400_000, cacheRead: 95_616_000, cacheWrite: 3_984_000 },
      estimate: { total: 10_000_000, hitRate: 96, outputShare: 0.4 },
    };
    const decoded = decodeCalcState(encodeCalcState(state));
    expect(decoded.prices).toEqual(state.prices);
    expect(decoded.tokens).toEqual(state.tokens);
    expect(decoded.estimate).toEqual(state.estimate);
  });

  it("默认场景不写进链接：还原后仍是普通对话（输出 20%、命中率 0）", () => {
    const params = encodeCalcState(EMPTY_STATE);
    expect(params.get("h")).toBeNull();
    expect(params.get("os")).toBeNull();
    expect(params.get("t")).toBeNull();
    const decoded = decodeCalcState(params);
    expect(decoded.estimate.hitRate).toBe(0);
    expect(decoded.estimate.outputShare).toBe(20);
  });

  it("老分享链接（总量 + 两个比率）按同一口径迁移成四档用量", () => {
    const legacy = new URLSearchParams("t=100000000&h=96&os=0.4");
    const decoded = decodeCalcState(legacy);
    expect(decoded.tokens.output).toBe(400_000);
    expect(decoded.tokens.cacheRead).toBe(95_616_000);
    expect(decoded.tokens.cacheWrite).toBe(3_984_000);
    expect(decoded.estimate.total).toBe(100_000_000);
  });

  it("新旧参数同时存在时以四档用量为准", () => {
    const both = new URLSearchParams("ti=1000&to=2000&t=100000000&h=96&os=0.4");
    const decoded = decodeCalcState(both);
    expect(decoded.tokens.input).toBe(1000);
    expect(decoded.tokens.output).toBe(2000);
    expect(decoded.tokens.cacheRead).toBeNull();
  });

  it("总量只认快捷档位，非法值回落默认档", () => {
    expect(decodeCalcState(new URLSearchParams("t=123456")).estimate.total).toBe(TOTAL);
  });
});
