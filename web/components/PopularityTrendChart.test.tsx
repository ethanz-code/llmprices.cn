/** 人气趋势图的接线钉子（不引 jsdom，用 renderToStaticMarkup）：
 *  1) 数据摊平——排名按来源分成两条线（Tranco / SimilarWeb 月度），访问量单独一列；
 *  2) 服务端渲染冒烟——两个信号的标题与来源说明在位、没有点整块为空。
 *     chart 本体走 recharts 的 ResponsiveContainer，要等浏览器量宽才画，静态渲染只钉壳。 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { PopularityTrendChart, popularityRows } from "@/components/PopularityTrendChart";
import type { PopularityPoint } from "@/lib/popularity";

const NOW = 1_792_000_000;
const POINTS: PopularityPoint[] = [
  { day: "2026-07-01", at: NOW - 90 * 86_400, visits: null, visits_source: "", rank: 625_665, rank_source: "similarweb" },
  { day: "2026-08-01", at: NOW - 60 * 86_400, visits: null, visits_source: "", rank: 1_170_871, rank_source: "similarweb" },
  { day: "2026-09-01", at: NOW - 30 * 86_400, visits: null, visits_source: "", rank: 422_889, rank_source: "similarweb" },
  { day: "2026-10-10", at: NOW - 4 * 86_400, visits: 51_000, visits_source: "similarweb", rank: 900_000, rank_source: "tranco" },
  { day: "2026-10-15", at: NOW, visits: 57_654, visits_source: "similarweb", rank: 944_958, rank_source: "tranco" },
];

describe("popularityRows", () => {
  it("排名按来源分列，访问量独立一列；缺的留空", () => {
    const rows = popularityRows(POINTS);
    expect(rows).toHaveLength(5);
    // 月度种子点只有 SimilarWeb 排名，没有访问量
    expect(rows[0]).toMatchObject({ day: "2026-07-01", visits: null, tranco: null, similarweb: 625_665 });
    // 常规点带访问量与 Tranco 排名
    expect(rows[4]).toMatchObject({ day: "2026-10-15", visits: 57_654, tranco: 944_958, similarweb: null });
  });
});

describe("PopularityTrendChart", () => {
  it("两个信号的标题、来源说明与排名图例都在位", () => {
    const html = renderToStaticMarkup(<PopularityTrendChart points={POINTS} />);
    expect(html).toContain("月访问量");
    expect(html).toContain("SimilarWeb 公开估算");
    expect(html).toContain("全网排名");
    expect(html).toContain("越靠上越热");
    expect(html).toContain("Tranco 全网排名");
    expect(html).toContain("SimilarWeb 月度排名");
  });

  it("只有访问量时不出排名图；没有点整块为空", () => {
    const visitsOnly = POINTS.filter((point) => point.visits != null).map((point) => ({ ...point, rank: null, rank_source: "" }));
    const html = renderToStaticMarkup(<PopularityTrendChart points={visitsOnly} />);
    expect(html).toContain("月访问量");
    expect(html).not.toContain("Tranco 全网排名");
    expect(renderToStaticMarkup(<PopularityTrendChart points={[]} />)).toBe("");
  });
});
