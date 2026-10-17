/** 人气趋势图的接线钉子（不引 jsdom，用 renderToStaticMarkup）：
 *  1) 数据摊平——排名按来源分成两条线（Tranco / SimilarWeb 月度），访问量单独一列；
 *  2) 服务端渲染冒烟——两个信号的标题与来源说明在位、没有点整块为空。
 *     chart 本体走 recharts 的 ResponsiveContainer，要等浏览器量宽才画，静态渲染只钉壳。 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { PopularityRankChart, PopularityTrendChart, PopularityVisitsChart, popularityRows } from "@/components/PopularityTrendChart";
import type { PopularityPoint } from "@/lib/popularity";

const NOW = 1_792_000_000;
const POINTS: PopularityPoint[] = [
  { day: "2026-07-01", at: NOW - 90 * 86_400, visits: null, visits_source: "", rank: 625_665, rank_source: "similarweb" },
  { day: "2026-08-01", at: NOW - 60 * 86_400, visits: null, visits_source: "", rank: 1_170_871, rank_source: "similarweb" },
  { day: "2026-09-01", at: NOW - 30 * 86_400, visits: null, visits_source: "", rank: 422_889, rank_source: "similarweb" },
  { day: "2026-10-10", at: NOW - 4 * 86_400, visits: 51_000, visits_source: "similarweb", rank: 900_000, rank_source: "similarweb" },
  { day: "2026-10-15", at: NOW, visits: 57_654, visits_source: "similarweb", rank: 944_958, rank_source: "similarweb" },
];

describe("popularityRows", () => {
  it("访问量与排名各一列；非 SimilarWeb 来源的排名点不进图（旧数据兜底）", () => {
    const rows = popularityRows(POINTS);
    expect(rows).toHaveLength(5);
    // 月度种子点只有排名，没有访问量
    expect(rows[0]).toMatchObject({ day: "2026-07-01", visits: null, rank: 625_665 });
    // 常规点带访问量与排名
    expect(rows[4]).toMatchObject({ day: "2026-10-15", visits: 57_654, rank: 944_958 });
    // 旧的 Tranco 点（历史残留）不画
    const legacy = popularityRows([{ day: "2026-10-01", at: 1, visits: null, visits_source: "", rank: 123, rank_source: "tranco" }]);
    expect(legacy[0].rank).toBeNull();
  });
});

describe("PopularityTrendChart", () => {
  it("两个信号的标题、来源说明与排名图例都在位", () => {
    const html = renderToStaticMarkup(<PopularityTrendChart points={POINTS} />);
    expect(html).toContain("月访问量");
    expect(html).toContain("SimilarWeb 公开估算");
    expect(html).toContain("全网排名");
    expect(html).toContain("越靠上越热");
    expect(html).not.toContain("Tranco");
  });

  it("点数不足两个时给「还在积累」提示而不是空图", () => {
    const onePoint = POINTS.filter((point) => point.visits != null).slice(-1).map((point) => ({ ...point, rank: null, rank_source: "" }));
    const html = renderToStaticMarkup(<PopularityVisitsChart points={onePoint} />);
    expect(html).toContain("还在积累");
    expect(html).not.toContain("recharts-responsive-container");
    // 两个点起才画图
    const twoPoints = POINTS.filter((point) => point.visits != null);
    expect(renderToStaticMarkup(<PopularityVisitsChart points={twoPoints} />)).toContain("recharts-responsive-container");
  });

  it("单图拆分：详情页按信号各取一张，缺信号的返回空", () => {
    const html = renderToStaticMarkup(<PopularityVisitsChart points={POINTS} />);
    expect(html).toContain("recharts-responsive-container");
    const rankHtml = renderToStaticMarkup(<PopularityRankChart points={POINTS} />);
    expect(rankHtml).toContain("recharts-responsive-container");
    // 只有访问量的点集：排名图整块为空
    const visitsOnly = POINTS.filter((point) => point.visits != null).map((point) => ({ ...point, rank: null, rank_source: "" }));
    expect(renderToStaticMarkup(<PopularityRankChart points={visitsOnly} />)).toBe("");
    expect(renderToStaticMarkup(<PopularityVisitsChart points={[]} />)).toBe("");
  });

  it("只有访问量时不出排名图；没有点整块为空", () => {
    const visitsOnly = POINTS.filter((point) => point.visits != null).map((point) => ({ ...point, rank: null, rank_source: "" }));
    const html = renderToStaticMarkup(<PopularityTrendChart points={visitsOnly} />);
    expect(html).toContain("月访问量");
    expect(html).not.toContain("全网排名");
    expect(renderToStaticMarkup(<PopularityTrendChart points={[]} />)).toBe("");
  });
});
