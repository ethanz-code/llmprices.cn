"use client";

/** 站点人气趋势图（recharts，与首页/统计页同一套图表库与主题）：月访问量与全网排名分开画。
 *
 * 数据点由后端 popularity_points 逐次采集积累（一天一个、同天覆盖）；SimilarWeb 自带的
 * 访问量与排名是同一个来源（SimilarWeb 站内接口），月度排名历史在首次采集时补种。
 *
 * 点稀疏（月级/日级）不做平滑：直线相连就是「两次观测之间没有数据」的诚实画法。
 *
 * 导出三块：两个单图（详情页把「值 + 变化 + 来源」当标题行，紧贴各自的图）与一个带默认标题
 * 的整块（管理页趋势弹窗用，弹窗里没有外层标题行）。横轴用数值域 + 线性刻度：种子点按月、
 * 常规点按天，分类轴会把不均匀的间隔画成等距；`scale="time"` 在单点序列上会把量程算到数据外。
 * 刻度文字只在浏览器里生成（ResponsiveContainer 之下），用本地时区格式化不会引发水合差异。 */

import { useMemo, useState } from "react";
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
import { dayKey, formatCompact, formatTime } from "@/lib/format";
import type { PopularityPoint } from "@/lib/popularity";

/** recharts 的数据行：访问量与排名各占一列（缺的留空，线自动断开）。 */
export interface PopularityTrendRow {
  at: number;
  day: string;
  visits: number | null;
  rank: number | null;
}

/** 后端的人气点摊成 recharts 数据行。
 *  排名只认 SimilarWeb 来源：它是访问量与排名的唯一外部源，历史里若留着别的来源的点（旧数据）
 *  一律不进图，避免两条不同口径的排名线画在一起。 */
export function popularityRows(points: PopularityPoint[]): PopularityTrendRow[] {
  return points.map((point) => ({
    at: point.at,
    day: point.day,
    visits: point.visits,
    rank: point.rank_source === "tranco" ? null : point.rank,
  }));
}

/** 刻度文案：跨度小于一周时带上时分（不然同一天的两个刻度会显示成同一个 MM-DD，看着像重复）。 */
function tickLabeler(rows: PopularityTrendRow[]): (at: number) => string {
  const times = rows.map((row) => row.at);
  const span = Math.max(...times) - Math.min(...times);
  if (span < 7 * 86_400) return (at: number) => formatTime(at);
  return (at: number) => dayKey(at).slice(5); // MM-DD
}

/** 横轴量程：直接用数据里的最早/最晚时刻，不交给 recharts 的 dataMin/dataMax。 */
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

/** 横轴刻度：首尾两个标签向内对齐（长标签不顶出绘图区，状态页 canvas 图同款处理）。 */
function EdgeTick({
  x,
  y,
  payload,
  index,
  visibleTicksCount,
  format,
  fill,
}: {
  x?: number;
  y?: number;
  payload?: { value?: number };
  index?: number;
  visibleTicksCount?: number;
  format: (at: number) => string;
  fill: string;
}) {
  if (x == null || y == null || payload?.value == null) return <g />;
  const anchor = index === 0 ? "start" : index === (visibleTicksCount ?? 1) - 1 ? "end" : "middle";
  return (
    <text x={x} y={y} dy={10} textAnchor={anchor} fill={fill} fontSize={10.5}>
      {format(payload.value)}
    </text>
  );
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

/** 点数不足画线时的空态（照 HeroTrendChart 的「还在积累」写法）：说明在攒什么、还差几个。 */
function AccumulatingHint({ what, count }: { what: string; count: number }) {
  return (
    <p style={{ color: "var(--text-3)", fontSize: 12.5, lineHeight: 1.7, margin: 0 }}>
      {what}趋势还在积累：每轮采集记一个点，攒够两个就能画出第一条线（当前 {count} 个）。
    </p>
  );
}

/** 月访问量：单条面积线（SimilarWeb 公开估算）。没有访问量点时不出图。 */
export function PopularityVisitsChart({ points, height = 132 }: { points: PopularityPoint[]; height?: number }) {
  const { lineColor, axisColor, gridColor } = useChartTheme();
  const rows = useMemo(() => popularityRows(points), [points]);
  const count = rows.filter((row) => row.visits != null).length;
  if (count === 0) return null;
  if (count < 2) {
    return <AccumulatingHint what="月访问量" count={count} />;
  }
  const axis = { fill: axisColor, fontSize: 10.5 } as const;
  return (
    <div style={{ height, minWidth: 0 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 6, right: 10, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={gridColor} vertical={false} />
          <XAxis
            dataKey="at"
            type="number"
            scale="linear"
            domain={timeDomain(rows)}
            tickLine={false}
            axisLine={{ stroke: gridColor }}
            tickMargin={6}
            minTickGap={48}
            tick={<EdgeTick format={tickLabeler(rows)} fill={axisColor} />}
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
            type="linear"
            animationDuration={500}
            dataKey="visits"
            name="月访问量"
            stroke={lineColor}
            strokeWidth={1.8}
            fill="url(#pop-visits-fill)"
            dot={false}
            activeDot={{ r: 3.5, strokeWidth: 0 }}
            connectNulls
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** 全网排名：SimilarWeb 给的全球排名（月度历史 + 每轮采集的点）。 */
export function PopularityRankChart({ points, height = 132 }: { points: PopularityPoint[]; height?: number }) {
  const { axisColor, gridColor, palette } = useChartTheme();
  const rows = useMemo(() => popularityRows(points), [points]);
  const rankValues = rows.flatMap((row) => (row.rank == null ? [] : [row.rank]));
  if (rankValues.length === 0) return null;
  if (rankValues.length < 2) {
    return <AccumulatingHint what="排名" count={rankValues.length} />;
  }
  const color = palette[1]; // 与站点状态页多系列取色同一套色板
  const axis = { fill: axisColor, fontSize: 10.5 } as const;
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ height, minWidth: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 6, right: 10, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={gridColor} vertical={false} />
            <XAxis
              dataKey="at"
              type="number"
              scale="linear"
              domain={timeDomain(rows)}
              tickLine={false}
              axisLine={{ stroke: gridColor }}
              tickMargin={6}
              minTickGap={48}
              tick={<EdgeTick format={tickLabeler(rows)} fill={axisColor} />}
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
            <ReTooltip content={<TrendTooltip rows={[{ key: "rank", name: "全网排名", color }]} />} />
            <Line
              type="linear"
              animationDuration={500}
              dataKey="rank"
              name="全网排名"
              stroke={color}
              strokeWidth={1.8}
              dot={false}
              activeDot={{ r: 3.5, strokeWidth: 0 }}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** 带默认标题的整块（管理页趋势弹窗用）：标题行 + 两张图。 */
export function PopularityTrendChart({ points, height = 132 }: { points: PopularityPoint[]; height?: number }) {
  const rows = useMemo(() => popularityRows(points), [points]);
  const hasVisits = rows.some((row) => row.visits != null);
  const hasRank = rows.some((row) => row.rank != null);
  if (rows.length === 0 || (!hasVisits && !hasRank)) return null;
  const title = { color: "var(--text-2)", fontWeight: 550 } as const;
  const hint = { color: "var(--text-3)", fontSize: 12 } as const;
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {hasVisits && (
        <div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", fontSize: 12.5 }}>
            <span style={title}>月访问量</span>
            <span style={hint}>SimilarWeb 公开估算 · 每轮采集记一个点</span>
          </div>
          <div style={{ marginTop: 6 }}>
            <PopularityVisitsChart points={points} height={height} />
          </div>
        </div>
      )}
      {hasRank && (
        <div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", fontSize: 12.5 }}>
            <span style={title}>全网排名</span>
            <span style={hint}>SimilarWeb 全球排名 · 越靠上越热</span>
          </div>
          <div style={{ marginTop: 6 }}>
            <PopularityRankChart points={points} height={height} />
          </div>
        </div>
      )}
    </div>
  );
}
