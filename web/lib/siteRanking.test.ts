/** 站点评分口径：价格在「当前模型内」归一、其余三项站点级、数据滞后另扣、缺数据中性、排序主键。 */
import { describe, expect, it } from "vitest";

import type { SiteStats } from "@/lib/channelStatus";
import { smartOrderRows } from "@/lib/priceRows";
import {
  STALE_PENALTY_MAX,
  buildSiteRanking,
  effectiveCostCny,
  rowRankScore,
  rowScore,
} from "@/lib/siteRanking";
import type { OverviewRecord, SiteFlags } from "@/lib/types";

/** 造一行；默认「刚采到」（captured_at == last_price_at），不触发数据滞后扣分。 */
function row(over: Partial<OverviewRecord>): OverviewRecord {
  return {
    site_id: "s1",
    model: "demo",
    input_price: null,
    output_price: null,
    unit: "USD/1M tokens",
    price_status: "confirmed",
    requires_auth: false,
    source_url: "https://s1.example",
    captured_at: 100,
    last_price_at: 100,
    fingerprint: "f",
    discount: null,
    ...over,
  };
}

const FULL_FLAGS: SiteFlags = {
  network: true,
  status: true,
  notice: true,
  networks: true,
  token_refresh: true,
  homepage: true,
  enabled: true,
};

const BARE_FLAGS: SiteFlags = {
  ...FULL_FLAGS,
  status: false,
  notice: false,
  networks: false,
  token_refresh: false,
  homepage: false,
};

/** 造一份渠道视图：把给定站点的可用率放进时段桶（单桶即该站的 7 天可用率）。 */
function statsWith(availability: Record<string, number>): SiteStats {
  const uptimeBuckets: SiteStats["uptimeBuckets"] = {};
  for (const [site, pct] of Object.entries(availability)) {
    uptimeBuckets[site] = [{ start: 0, end: 60, count: 10, avg: pct, worst: pct, down: [] }];
  }
  return { channels: {}, availability: {}, uptimeBuckets };
}

describe("effectiveCostCny 缓存加权实付成本", () => {
  it("给了便宜缓存读价，成本明显低于按输入价计", () => {
    const plain = row({ input_price: 10, output_price: 40 });
    const cached = row({ input_price: 10, output_price: 40, metadata: { cache_read_price: 1 } });
    expect(effectiveCostCny(cached, 7)!).toBeLessThan(effectiveCostCny(plain, 7)!);
  });

  it("没给缓存读价时按输入价计（无缓存优惠），不因缺数据被算便宜", () => {
    const missing = row({ input_price: 10, output_price: 40 });
    const explicitSame = row({ input_price: 10, output_price: 40, metadata: { cache_read_price: 10 } });
    expect(effectiveCostCny(missing, 7)).toBeCloseTo(effectiveCostCny(explicitSame, 7)!, 6);
  });

  it("输入输出双缺返回 null", () => {
    expect(effectiveCostCny(row({}), 7)).toBeNull();
  });
});

describe("价格分在当前模型内比", () => {
  const cheap = row({ site_id: "cheap", model: "m1", input_price: 1, output_price: 4 });
  const pricey = row({ site_id: "pricey", model: "m1", input_price: 10, output_price: 40 });

  it("同模型下最便宜得 1、最贵得 0，最便宜的站总分更高", () => {
    const ranking = buildSiteRanking({ records: [cheap, pricey], rate: null });
    expect(rowScore(ranking, cheap).price).toBe(1);
    expect(rowScore(ranking, pricey).price).toBe(0);
    expect(rowScore(ranking, cheap).score).toBeGreaterThan(rowScore(ranking, pricey).score);
  });

  it("同一个站在不同模型里的价格分不同（不再拿跨模型中位数）", () => {
    const a1 = row({ site_id: "a", model: "m1", input_price: 1, output_price: 4 });
    const b1 = row({ site_id: "b", model: "m1", input_price: 10, output_price: 40 });
    const a2 = row({ site_id: "a", model: "m2", input_price: 10, output_price: 40 });
    const b2 = row({ site_id: "b", model: "m2", input_price: 1, output_price: 4 });
    const ranking = buildSiteRanking({ records: [a1, b1, a2, b2], rate: null });
    expect(rowScore(ranking, a1).price).toBe(1); // m1 里 a 便宜
    expect(rowScore(ranking, a2).price).toBe(0); // m2 里 a 贵
  });

  it("只有一个站在售的模型，价格分按 1（它就是最便宜的）", () => {
    const only = row({ site_id: "only", model: "solo", input_price: 1, output_price: 4 });
    const ranking = buildSiteRanking({ records: [only], rate: null });
    expect(rowScore(ranking, only).price).toBe(1);
  });

  it("真免费档（0/0 confirmed）算最便宜，不被当成没有价", () => {
    const free = row({ site_id: "free", model: "m1", input_price: 0, output_price: 0 });
    const paid = row({ site_id: "paid", model: "m1", input_price: 1, output_price: 4 });
    const ranking = buildSiteRanking({ records: [free, paid], rate: null });
    expect(rowScore(ranking, free).price).toBe(1);
    expect(rowScore(ranking, paid).price).toBe(0);
  });

  it("全站都免费时同价全给 1，不产生 NaN", () => {
    const a = row({ site_id: "a", model: "m1", input_price: 0, output_price: 0 });
    const b = row({ site_id: "b", model: "m1", input_price: 0, output_price: 0 });
    const ranking = buildSiteRanking({ records: [a, b], rate: null });
    expect(rowScore(ranking, a).price).toBe(1);
    expect(Number.isFinite(rowScore(ranking, b).price)).toBe(true);
  });
});

describe("其余三项：渠道稳定 / 配置完整 / 公告新鲜", () => {
  it("渠道稳定取时段桶可用率均值；无状态数据中性 0.5", () => {
    const s = row({ site_id: "s", model: "m" });
    const t = row({ site_id: "t", model: "m" });
    const ranking = buildSiteRanking({
      records: [],
      rate: null,
      siteFlags: { s: FULL_FLAGS, t: FULL_FLAGS },
      views: statsWith({ s: 80 }),
    });
    expect(rowScore(ranking, s).stability).toBeCloseTo(0.8, 6);
    expect(rowScore(ranking, t).stability).toBe(0.5);
  });

  it("配置完整是六项清单命中比例；无标志中性 0.5", () => {
    const full = row({ site_id: "full", model: "m" });
    const bare = row({ site_id: "bare", model: "m" });
    const unknown = row({ site_id: "unknown", model: "m" });
    const ranking = buildSiteRanking({
      records: [unknown],
      rate: null,
      siteFlags: { full: FULL_FLAGS, bare: BARE_FLAGS },
    });
    expect(rowScore(ranking, full).completeness).toBe(1);
    expect(rowScore(ranking, bare).completeness).toBeCloseTo(1 / 6, 6);
    expect(rowScore(ranking, unknown).completeness).toBe(0.5);
  });

  it("公告新鲜：≤7 天满分、≥60 天 0、无公告 0", () => {
    const day = 86_400;
    const now = 1_000_000_000;
    const s = row({ site_id: "s", model: "m" });
    const noticeOf = (at: number | null) =>
      rowScore(
        buildSiteRanking({ records: [], rate: null, siteFlags: { s: FULL_FLAGS }, noticeAt: { s: at }, now }),
        s,
      ).notice;
    expect(noticeOf(now - 2 * day)).toBe(1);
    expect(noticeOf(now - 100 * day)).toBe(0);
    expect(noticeOf(null)).toBe(0);
  });

  it("其他三项能把「只便宜一点点」的站压下去", () => {
    const cheap = row({ site_id: "cheap", model: "m1", input_price: 1.0, output_price: 4 });
    const good = row({ site_id: "good", model: "m1", input_price: 1.05, output_price: 4.2 });
    const spike = row({ site_id: "spike", model: "m1", input_price: 4.0, output_price: 16 });
    const ranking = buildSiteRanking({
      records: [cheap, good, spike],
      rate: null,
      siteFlags: { cheap: BARE_FLAGS, good: FULL_FLAGS },
      views: statsWith({ cheap: 0, good: 100 }),
      noticeAt: { cheap: null, good: 1_000_000_000 },
      now: 1_000_000_000,
    });
    expect(rowScore(ranking, cheap).price).toBe(1); // 它确实最便宜
    expect(rowScore(ranking, good).score).toBeGreaterThan(rowScore(ranking, cheap).score); // 但综合分被反超
  });
});

describe("数据滞后扣分", () => {
  const fresh = row({ site_id: "s", model: "m1", input_price: 1, output_price: 4 });
  const stale = row({
    site_id: "s",
    model: "m1",
    input_price: 1,
    output_price: 4,
    captured_at: 100 + 5 * 86_400,
    last_price_at: 100,
  });

  it("刚采到不扣；滞后满 4 天扣满（上限 10 分）", () => {
    const ranking = buildSiteRanking({ records: [fresh], rate: null });
    expect(rowScore(ranking, fresh).stale).toBe(0);
    const full = row({
      site_id: "s",
      model: "m1",
      input_price: 1,
      output_price: 4,
      captured_at: 100 + 99 * 86_400,
      last_price_at: 100,
    });
    expect(rowScore(ranking, full).stale).toBeCloseTo(STALE_PENALTY_MAX, 6);
  });

  it("滞后让同价的两行分出高低（综合分差 = 扣分）", () => {
    const ranking = buildSiteRanking({ records: [fresh], rate: null });
    const gap = rowScore(ranking, fresh).score - rowScore(ranking, stale).score;
    expect(gap).toBeCloseTo(STALE_PENALTY_MAX, 6);
    // 同一张表里，滞后的行排到后面
    const ordered = smartOrderRows(
      [stale, fresh],
      () => 0,
      null,
      (r) => rowRankScore(ranking, r),
    );
    expect(ordered[0]).toBe(fresh);
  });

  it("分数与分项都在合法区间", () => {
    const a = row({ site_id: "a", model: "m1", input_price: 1, output_price: 4 });
    const b = row({ site_id: "b", model: "m1", input_price: 10, output_price: 40 });
    const ranking = buildSiteRanking({
      records: [a, b],
      rate: null,
      siteFlags: { a: FULL_FLAGS, b: BARE_FLAGS },
    });
    for (const r of [a, b]) {
      const s = rowScore(ranking, r);
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(100);
      for (const part of [s.price, s.stability, s.completeness, s.notice]) {
        expect(Number.isFinite(part)).toBe(true);
        expect(part).toBeGreaterThanOrEqual(0);
        expect(part).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("smartOrderRows 用行综合分作主排序键", () => {
  it("同模型里最便宜的站排第一；不传评分时退回按价格排", () => {
    const pricey = row({ site_id: "pricey", model: "m1", input_price: 10, output_price: 40, captured_at: 2, last_price_at: 2 });
    const cheap = row({ site_id: "cheap", model: "m1", input_price: 1, output_price: 4, captured_at: 1, last_price_at: 1 });
    const rows = [pricey, cheap];
    const ranking = buildSiteRanking({ records: rows, rate: null });
    const ordered = smartOrderRows(rows, () => 0, null, (r) => rowRankScore(ranking, r));
    expect(ordered[0]).toBe(cheap);
    expect(smartOrderRows(rows, () => 0, null)[0]).toBe(cheap);
  });
});
