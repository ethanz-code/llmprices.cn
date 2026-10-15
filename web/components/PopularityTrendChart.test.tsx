/** 人气趋势图的渲染钉子（不引 jsdom，用 renderToStaticMarkup）：
 *  两个信号各一张小图、排名图两条来源分线、日期刻度用后端给的 day 字符串（不做本地时区格式化，
 *  避免服务端与浏览器时区不一致导致标签漂移）；没有点时整块返回空，调用方据此不渲染。
 *  管理页「趋势」弹窗（Modal 走 createPortal，需要 DOM）不在静态渲染测试范围内。 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { PopularityTrendChart } from "@/components/PopularityTrendChart";
import type { PopularityPoint } from "@/lib/popularity";

const NOW = 1_792_000_000;
const POINTS: PopularityPoint[] = [
  { day: "2026-07-01", at: NOW - 90 * 86_400, visits: null, visits_source: "", rank: 625_665, rank_source: "similarweb" },
  { day: "2026-08-01", at: NOW - 60 * 86_400, visits: null, visits_source: "", rank: 1_170_871, rank_source: "similarweb" },
  { day: "2026-09-01", at: NOW - 30 * 86_400, visits: null, visits_source: "", rank: 422_889, rank_source: "similarweb" },
  { day: "2026-10-10", at: NOW - 4 * 86_400, visits: 51_000, visits_source: "similarweb", rank: 900_000, rank_source: "tranco" },
  { day: "2026-10-15", at: NOW, visits: 57_654, visits_source: "similarweb", rank: 944_958, rank_source: "tranco" },
];

describe("PopularityTrendChart", () => {
  it("两个信号各一张图：月访问量 + 全网排名，排名图两条来源分线", () => {
    const html = renderToStaticMarkup(<PopularityTrendChart points={POINTS} />);
    expect(html).toContain("月访问量趋势图");
    expect(html).toContain("全网排名趋势图");
    expect(html).toContain("SimilarWeb 公开估算");
    expect(html).toContain("Tranco 全网排名");
    expect(html).toContain("SimilarWeb 月度排名");
    // 日期刻度直接用后端给的 day 字符串；数值走 formatCompact
    expect(html).toContain("2026-07-01");
    expect(html).toContain("2026-10-15");
    expect(html).toContain("57.7k");
    expect(html).toContain("422.9k");
  });

  it("只有一个信号时只出一张图；没有点整块为空", () => {
    const visitsOnly = POINTS.filter((point) => point.visits != null).map((point) => ({ ...point, rank: null, rank_source: "" }));
    const html = renderToStaticMarkup(<PopularityTrendChart points={visitsOnly} />);
    expect(html).toContain("月访问量趋势图");
    expect(html).not.toContain("全网排名趋势图");
    expect(renderToStaticMarkup(<PopularityTrendChart points={[]} />)).toBe("");
  });
});
