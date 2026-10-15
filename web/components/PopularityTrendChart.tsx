"use client";

/** 站点人气趋势图（recharts，与首页/统计页同一套图表库与主题）：
 *  月访问量与全网排名两张小图，点少、纯展示，不需要站点状态页那种 canvas 刷选。
 *
 * 数据点由后端 popularity_points 逐次采集积累（一天一个、同天覆盖）；SimilarWeb 自带的
 * 月度排名历史在首次采集时补种。两个信号分开画、图例如实标注来源（访问量是 SimilarWeb
 * 公开估算，排名是 Tranco 全网榜 / SimilarWeb 月度），不混源；没有点的信号不出图。
 *
 * 横轴用采集时刻的数值轴而不是分类轴：种子点按月、常规点按天，分类轴会把不均匀的间隔画成等距。
 * 刻度文字只在浏览器里生成（ResponsiveContainer 之下），所以用本地时区格式化不会引发水合差异。 */

import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as ReTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartBubble, useChartTheme } from "./chartTheme";
import { dayKey, formatCompact } from "@/lib/format";
import type { PopularityPoint } from "@/lib/popularity";

/** recharts 的数据行：访问量与两个排名来源各占一列（缺的留空，线自动断开）。 */
export interface PopularityTrendRow {
  at: number;
  day: string;
  visits: number | null;
  tranco: number | null;
  similarweb: number | null;
}

/** 后端的人气点摊成 recharts 数据行：排名按来源分成两条线。 */
export function popularityRows(points: PopularityPoint[]): PopularityTrendRow[] {
  return points.map((point) => ({
    at: point.at,
    day: point.day,
    visits: point.visits,
    tranco: point.rank != null && point.rank_source !== "similarweb" ? point.rank : null,
    similarweb: point.rank_source === "similarweb" ? point.rank : null,
  }));
}

/** 横轴量程：直接用数据里的最早/最晚时刻，不交给 recharts 的 dataMin/dataMax——
 *  scale="time" 在只有一两个点的序列上会把量程算到数据之外（实测点画到绘图区右侧外头）。 */
function timeDomain(rows: PopularityTrendRow[]): [number, number] {
  const times = rows.map((row) => row.at);
  return [Math.min(...times), Math.max(...times)];
}

/** 排名量程：全相等时给一点余量，避免退化成一个值画不出轴。 */
function rankDomain(values: number[]): [number, number] {
  const low = Math.min(...values);
  const high = Math.max(...values);
  const pad = high === low ? Math.max(1, low * 0.02) : (high - low) * 0.08;
  return [Math.max(0, low - pad), high + pad];
}

interface TooltipRow {
  key: keyof PopularityTrendRow;
  name: string;
  color: string;
}

function TrendTooltip({
  active,
  payload,
  rows,
}: {
  active?: boolean;
  payload?: { payload?: PopularityTrendRow }[];
  rows: TooltipRow[];
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload;
  if (!point) return null;
  return (
    <ChartBubble
      label={point.day}
      rows={rows
        .filter((row) => point[row.key] != null)
        .map((row) => ({ color: row.color, name: row.name, value: formatCompact(point[row.key] as number) }))}
    />
  );
}

export function PopularityTrendChart({ points, height = 132 }: { points: PopularityPoint[]; height?: number }) {
  const { lineColor, secondaryColor, axisColor, gridColor, palette } = useChartTheme();
  const rows = useMemo(() => popularityRows(points), [points]);
  const hasVisits = rows.some((row) => row.visits != null);
  const hasRank = rows.some((row) => row.tranco != null || row.similarweb != null);
  const rankValues = rows.flatMap((row) => [row.tranco, row.similarweb].filter((value): value is number => value != null));
  if (rows.length === 0 || (!hasVisits && !hasRank)) return null;
  const xDomain = timeDomain(rows);

  const swColor = palette[2]; // 与站点状态页多系列取色同一套色板
  const axis = { fill: axisColor, fontSize: 10.5 } as const;
  const tickLabel = (at: number) => dayKey(at).slice(5); // MM-DD
  const rankLegend: { name: string; color: string }[] = [
    { name: "Tranco 全网排名", color: secondaryColor },
    { name: "SimilarWeb 月度排名", color: swColor },
  ];

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {hasVisits && (
        <div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", fontSize: 12.5 }}>
            <span style={{ color: "var(--text-2)", fontWeight: 550 }}>月访问量</span>
            <span style={{ color: "var(--text-3)", fontSize: 12 }}>SimilarWeb 公开估算 · 每轮采集记一个点</span>
          </div>
          <div style={{ height, marginTop: 6 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={rows} margin={{ top: 6, right: 10, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={gridColor} vertical={false} />
                <XAxis
                  dataKey="at"
                  type="number"
                  scale="linear"
                  domain={xDomain}
                  tick={axis}
                  tickLine={false}
                  axisLine={{ stroke: gridColor }}
                  tickMargin={6}
                  minTickGap={48}
                  tickFormatter={tickLabel}
                />
                <YAxis
                  width={46}
                  tick={axis}
                  tickLine={false}
                  axisLine={false}
                  domain={[0, "auto"]}
                  tickFormatter={(value: number) => formatCompact(value)}
                />
                <ReTooltip content={<TrendTooltip rows={[{ key: "visits", name: "月访问量", color: lineColor }]} />} />
                <defs>
                  <linearGradient id="pop-visits-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={lineColor} stopOpacity={0.22} />
                    <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area
                  type="monotone"
                  dataKey="visits"
                  name="月访问量"
                  stroke={lineColor}
                  strokeWidth={1.8}
                  fill="url(#pop-visits-fill)"
                  dot={{ r: 2.6, strokeWidth: 0, fill: lineColor }}
                  connectNulls
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {hasRank && (
        <div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", fontSize: 12.5 }}>
            <span style={{ color: "var(--text-2)", fontWeight: 550 }}>全网排名</span>
            <span style={{ color: "var(--text-3)", fontSize: 12 }}>越靠上越热 · 每轮采集记一个点</span>
          </div>
          <div style={{ height, marginTop: 6 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows} margin={{ top: 6, right: 10, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={gridColor} vertical={false} />
                <XAxis
                  dataKey="at"
                  type="number"
                  scale="linear"
                  domain={xDomain}
                  tick={axis}
                  tickLine={false}
                  axisLine={{ stroke: gridColor }}
                  tickMargin={6}
                  minTickGap={48}
                  tickFormatter={tickLabel}
                />
                <YAxis
                  width={46}
                  tick={axis}
                  tickLine={false}
                  axisLine={false}
                  reversed
                  domain={rankDomain(rankValues)}
                  tickFormatter={(value: number) => formatCompact(value)}
                />
                <ReTooltip content={<TrendTooltip rows={rankLegend.map((item, index) => ({ key: index === 0 ? "tranco" : "similarweb", ...item }))} />} />
                <Line
                  type="monotone"
                  dataKey="tranco"
                  name="Tranco 全网排名"
                  stroke={secondaryColor}
                  strokeWidth={1.8}
                  dot={{ r: 2.6, strokeWidth: 0, fill: secondaryColor }}
                  connectNulls
                />
                <Line
                  type="monotone"
                  dataKey="similarweb"
                  name="SimilarWeb 月度排名"
                  stroke={swColor}
                  strokeWidth={1.8}
                  strokeDasharray="4 3"
                  dot={{ r: 2.6, strokeWidth: 0, fill: swColor }}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", paddingTop: 6 }}>
            {rankLegend.map((item) => (
              <span key={item.name} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--text-3)" }}>
                <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: item.color, flexShrink: 0 }} />
                {item.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
