/** 站点评分口径：价格在「当前模型内」归一、其余三项站点级、缺数据中性、排序主键。 */
import { describe, expect, it } from "vitest";

import type { SiteViews } from "@/lib/channelStatus";
import { smartOrderRows } from "@/lib/priceRows";
import { buildSiteRanking, effectiveCostCny, rowRankScore, rowScore } from "@/lib/siteRanking";
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

const BARE_FLAGS: SiteFlags = { ...FULL_FLAGS, status: false, notice: false, networks: false, token_refresh: false, homepage: false };

/** 造一份渠道视图：把给定站点的可用率放进时段桶（单桶即该站的 7 天可用率）。 */
function viewsWith(availability: Record<string, number>): SiteViews {
  const uptimeBuckets: SiteViews["uptimeBuckets"] = {};
  for (const [site, pct] of Object.entries(availability)) {
    uptimeBuckets[site] = [{ start: 0, end: 60, count: 10, avg: pct, worst: pct, down: [] }];
  }
  return { channels: {}, availability: {}, latency: {}, uptimeBuckets };
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
  it("同模型下最便宜得 1、最贵得 0，最便宜的站总分更高", () => {
    const ranking = buildSiteRanking({
      records: [
        row({ site_id: "cheap", model: "m1", input_price: 1, output_price: 4 }),
        row({ site_id: "pricey", model: "m1", input_price: 10, output_price: 40 }),
      ],
      rate: null,
    });
    expect(rowScore(ranking, "cheap", "m1").price).toBe(1);
    expect(rowScore(ranking, "pricey", "m1").price).toBe(0);
    expect(rowScore(ranking, "cheap", "m1").score).toBeGreaterThan(rowScore(ranking, "pricey", "m1").score);
  });

  it("同一个站在不同模型里的价格分不同（不再拿跨模型中位数）", () => {
    const ranking = buildSiteRanking({
      records: [
        row({ site_id: "a", model: "m1", input_price: 1, output_price: 4 }),
        row({ site_id: "b", model: "m1", input_price: 10, output_price: 40 }),
        row({ site_id: "a", model: "m2", input_price: 10, output_price: 40 }),
        row({ site_id: "b", model: "m2", input_price: 1, output_price: 4 }),
      ],
      rate: null,
    });
    expect(rowScore(ranking, "a", "m1").price).toBe(1); // m1 里 a 便宜
    expect(rowScore(ranking, "a", "m2").price).toBe(0); // m2 里 a 贵
  });

  it("只有一个站在售的模型，价格分按 1（它就是最便宜的）", () => {
    const ranking = buildSiteRanking({
      records: [row({ site_id: "only", model: "solo", input_price: 1, output_price: 4 })],
      rate: null,
    });
    expect(rowScore(ranking, "only", "solo").price).toBe(1);
  });
});

describe("其余三项：渠道稳定 / 配置完整 / 公告新鲜", () => {
  it("渠道稳定取时段桶可用率均值；无状态数据中性 0.5", () => {
    const ranking = buildSiteRanking({
      records: [],
      rate: null,
      siteFlags: { s: FULL_FLAGS, t: FULL_FLAGS },
      views: viewsWith({ s: 80 }),
    });
    expect(rowScore(ranking, "s", "m").stability).toBeCloseTo(0.8, 6);
    expect(rowScore(ranking, "t", "m").stability).toBe(0.5);
  });

  it("配置完整是六项清单命中比例；无标志中性 0.5", () => {
    const ranking = buildSiteRanking({
      records: [row({ site_id: "unknown", model: "m1", input_price: 1, output_price: 4 })],
      rate: null,
      siteFlags: { full: FULL_FLAGS, bare: BARE_FLAGS },
    });
    expect(rowScore(ranking, "full", "m").completeness).toBe(1);
    expect(rowScore(ranking, "bare", "m").completeness).toBeCloseTo(1 / 6, 6);
    expect(rowScore(ranking, "unknown", "m").completeness).toBe(0.5);
  });

  it("公告新鲜：≤7 天满分、≥60 天 0、无公告 0", () => {
    const day = 86_400;
    const now = 1_000_000_000;
    const noticeOf = (at: number | null) =>
      rowScore(
        buildSiteRanking({ records: [], rate: null, siteFlags: { s: FULL_FLAGS }, noticeAt: { s: at }, now }),
        "s",
        "m",
      ).notice;
    expect(noticeOf(now - 2 * day)).toBe(1);
    expect(noticeOf(now - 100 * day)).toBe(0);
    expect(noticeOf(null)).toBe(0);
  });

  it("其他三项能把「只便宜一点点」的站压下去", () => {
    const ranking = buildSiteRanking({
      records: [
        row({ site_id: "cheap", model: "m1", input_price: 1.0, output_price: 4 }),
        row({ site_id: "good", model: "m1", input_price: 1.05, output_price: 4.2 }),
        row({ site_id: "spike", model: "m1", input_price: 4.0, output_price: 16 }),
      ],
      rate: null,
      siteFlags: { cheap: BARE_FLAGS, good: FULL_FLAGS },
      views: viewsWith({ cheap: 0, good: 100 }),
      noticeAt: { cheap: null, good: 1_000_000_000 },
      now: 1_000_000_000,
    });
    expect(rowScore(ranking, "cheap", "m1").price).toBe(1); // 它确实最便宜
    expect(rowScore(ranking, "good", "m1").score).toBeGreaterThan(rowScore(ranking, "cheap", "m1").score); // 但综合分被反超
  });

  it("分数与分项都在合法区间", () => {
    const ranking = buildSiteRanking({
      records: [
        row({ site_id: "a", model: "m1", input_price: 1, output_price: 4 }),
        row({ site_id: "b", model: "m1", input_price: 10, output_price: 40 }),
      ],
      rate: null,
      siteFlags: { a: FULL_FLAGS, b: BARE_FLAGS },
    });
    for (const site of ["a", "b"]) {
      const s = rowScore(ranking, site, "m1");
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
    const rows = [
      row({ site_id: "pricey", model: "m1", input_price: 10, output_price: 40, captured_at: 2 }),
      row({ site_id: "cheap", model: "m1", input_price: 1, output_price: 4, captured_at: 1 }),
    ];
    const ranking = buildSiteRanking({ records: rows, rate: null });
    const ordered = smartOrderRows(rows, () => 0, null, (r) => rowRankScore(ranking, r.site_id, r.model));
    expect(ordered[0].site_id).toBe("cheap");
    expect(smartOrderRows(rows, () => 0, null)[0].site_id).toBe("cheap");
  });
});
