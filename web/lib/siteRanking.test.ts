/** 站点综合分口径：价格按缓存加权实付成本、同模型内归一、缺数据中性、公告新鲜衰减、排序主键。 */
import { describe, expect, it } from "vitest";

import type { SiteViews } from "@/lib/channelStatus";
import { smartOrderRows } from "@/lib/priceRows";
import { computeSiteScores, effectiveCostCny, siteScoreRank, type SiteScore } from "@/lib/siteRanking";
import type { OverviewRecord, SiteFlags } from "@/lib/types";

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
  network: true,
  status: false,
  notice: false,
  networks: false,
  token_refresh: false,
  homepage: false,
  enabled: true,
};

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

describe("computeSiteScores 分项", () => {
  it("价格项：同一模型内最便宜得 1、最贵得 0；单站模型不计分", () => {
    const scores = computeSiteScores({
      records: [
        row({ site_id: "cheap", model: "m1", input_price: 1, output_price: 4 }),
        row({ site_id: "pricey", model: "m1", input_price: 10, output_price: 40 }),
        row({ site_id: "only", model: "solo", input_price: 1, output_price: 4 }),
      ],
      rate: null,
    });
    expect(scores.cheap.price).toBe(1);
    expect(scores.pricey.price).toBe(0);
    expect(scores.cheap.score).toBeGreaterThan(scores.pricey.score);
    expect(scores.only.price).toBe(0); // 只有一个站点在售的模型没有横向比较
  });

  it("配置完整项：清单命中比例；无配置标志取中性 0.5", () => {
    const scores = computeSiteScores({
      records: [row({ site_id: "unknown", model: "m1", input_price: 1, output_price: 4 })],
      rate: null,
      siteFlags: { full: FULL_FLAGS, bare: BARE_FLAGS },
    });
    expect(scores.full.completeness).toBe(1);
    expect(scores.bare.completeness).toBeCloseTo(1 / 6, 6);
    expect(scores.unknown.completeness).toBe(0.5);
  });

  it("公告新鲜项：≤7 天满分，≥60 天 0，中间线性，无公告 0", () => {
    const day = 86_400;
    const now = 1_000_000_000;
    const noticeOf = (at: number | null) =>
      computeSiteScores({ records: [], rate: null, siteFlags: { s: FULL_FLAGS }, noticeAt: { s: at }, now }).s.notice;
    expect(noticeOf(now - 2 * day)).toBe(1);
    expect(noticeOf(now - 100 * day)).toBe(0);
    expect(noticeOf(now - 33.5 * day)).toBeCloseTo(0.5, 2);
    expect(noticeOf(null)).toBe(0);
  });

  it("渠道稳定项：可用率与渠道成功率取均值；无状态数据取中性 0.5", () => {
    const views = {
      channels: { s: [{ name: "c", status: "up", ok: true, dots: [], successRate24h: 90 }] },
      availability: {},
      latency: {},
      uptimeBuckets: { s: [{ start: 0, end: 1, count: 10, avg: 80, worst: 60, down: [] }] },
    } as unknown as SiteViews;
    const withData = computeSiteScores({ records: [], rate: null, siteFlags: { s: FULL_FLAGS }, views });
    expect(withData.s.stability).toBeCloseTo(0.85, 6);
    const noData = computeSiteScores({ records: [], rate: null, siteFlags: { s: FULL_FLAGS }, views: null });
    expect(noData.s.stability).toBe(0.5);
  });

  it("综合分落在 0–100，分项落在 0–1", () => {
    const scores = computeSiteScores({
      records: [
        row({ site_id: "a", model: "m1", input_price: 1, output_price: 4 }),
        row({ site_id: "b", model: "m1", input_price: 10, output_price: 40 }),
      ],
      rate: null,
      siteFlags: { a: FULL_FLAGS, b: BARE_FLAGS },
    });
    for (const value of Object.values(scores)) {
      expect(value.score).toBeGreaterThanOrEqual(0);
      expect(value.score).toBeLessThanOrEqual(100);
      for (const part of [value.price, value.stability, value.completeness, value.notice]) {
        expect(Number.isFinite(part)).toBe(true);
        expect(part).toBeGreaterThanOrEqual(0);
        expect(part).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("smartOrderRows 站点分作主排序键", () => {
  it("rankOf 优先于价格：分高的站点排前面", () => {
    const rows = [
      row({ site_id: "a", model: "m1", input_price: 1, output_price: 4, captured_at: 1 }),
      row({ site_id: "b", model: "m1", input_price: 100, output_price: 400, captured_at: 2 }),
    ];
    const fake: Record<string, SiteScore> = {
      a: { score: 10, price: 0, stability: 0, completeness: 0, notice: 0 },
      b: { score: 90, price: 0, stability: 0, completeness: 0, notice: 0 },
    };
    const ordered = smartOrderRows(rows, () => 0, null, (r) => siteScoreRank(fake, r.site_id));
    expect(ordered.map((r) => r.site_id)).toEqual(["b", "a"]);
    // 不传 rankOf 时退回按价格：更便宜的 a 在前
    expect(smartOrderRows(rows, () => 0, null)[0].site_id).toBe("a");
  });
});
