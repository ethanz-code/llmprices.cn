/** 站点人气趋势图：月访问量与全网排名两条小图（纯 SVG、无状态，服务端与客户端都能渲染）。
 *
 * 数据点由后端 popularity_points 逐次采集积累（一天一个、同天覆盖）；SimilarWeb 自带的
 * 月度排名历史在首次采集时补种，所以排名图一开始就有几个月的历史。两个信号分开画、
 * 图例如实标注来源（访问量是 SimilarWeb 公开估算，排名是 Tranco 全网榜 / SimilarWeb 月度），
 * 不混源；没有点的信号整块不渲染。
 *
 * 日期刻度用点自带的 day 字符串（后端按本地时区生成），不在这里做时间格式化——
 * 服务端与浏览器时区不一致会让日期标签对不上（本项目踩过 8 小时偏移的坑）。 */

import { formatCompact } from "@/lib/format";
import type { PopularityPoint } from "@/lib/popularity";

interface SeriesPoint {
  at: number;
  day: string;
  value: number;
}

interface Series {
  name: string;
  color: string;
  dashed?: boolean;
  points: SeriesPoint[];
}

const CHART_W = 640;
const PLOT_H = 78;
const PAD = { top: 10, right: 10, bottom: 20, left: 52 };
const PLOT_W = CHART_W - PAD.left - PAD.right;
const VISITS_COLOR = "var(--accent)";
const TRANCO_COLOR = "var(--chart-ok)";
const SW_RANK_COLOR = "var(--chart-warn)";

function plotPoints(points: PopularityPoint[], pick: (point: PopularityPoint) => number | null): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (const point of points) {
    const value = pick(point);
    if (value == null) continue;
    out.push({ at: point.at, day: point.day, value });
  }
  return out;
}

/** 时间轴（按采集时刻线性分布）：只有一个点就摆中间，多个点铺满绘图区。 */
function timeScale(all: SeriesPoint[]): (at: number) => number {
  const times = all.map((point) => point.at);
  const start = Math.min(...times);
  const end = Math.max(...times);
  if (end === start) return () => PLOT_W / 2;
  return (at) => ((at - start) / (end - start)) * PLOT_W;
}

function valueScale(all: SeriesPoint[], invert: boolean): (value: number) => number {
  const values = all.map((point) => point.value);
  const low = Math.min(...values);
  const high = Math.max(...values);
  if (high === low) return () => PLOT_H / 2;
  return (value) => {
    const ratio = (value - low) / (high - low);
    // 排名越靠前数字越小：invert=true 时把"更好"画在上面
    return (invert ? ratio : 1 - ratio) * PLOT_H;
  };
}

function linePath(points: SeriesPoint[], x: (at: number) => number, y: (value: number) => number): string {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${x(point.at).toFixed(1)} ${y(point.value).toFixed(1)}`)
    .join(" ");
}

function MiniChart({
  title,
  hint,
  series,
  invert,
  format,
}: {
  title: string;
  hint: string;
  series: Series[];
  invert: boolean;
  format: (value: number) => string;
}) {
  const all = series.flatMap((item) => item.points);
  if (all.length === 0) return null;
  const x = timeScale(all);
  const y = valueScale(all, invert);
  const first = all.reduce((a, b) => (a.at <= b.at ? a : b));
  const last = all.reduce((a, b) => (a.at >= b.at ? a : b));
  const values = all.map((point) => point.value);
  const top = invert ? Math.min(...values) : Math.max(...values);
  const bottom = invert ? Math.max(...values) : Math.min(...values);
  const grid = [0, 0.5, 1].map((ratio) => PAD.top + ratio * PLOT_H);
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", fontSize: 12.5 }}>
        <span style={{ color: "var(--text-2)", fontWeight: 550 }}>{title}</span>
        <span style={{ color: "var(--text-3)", fontSize: 12 }}>{hint}</span>
      </div>
      <svg viewBox={`0 0 ${CHART_W} ${PAD.top + PLOT_H + PAD.bottom}`} width="100%" role="img" aria-label={`${title}趋势图`}>
        {grid.map((line) => (
          <line key={line} x1={PAD.left} y1={line} x2={PAD.left + PLOT_W} y2={line} stroke="var(--border)" strokeWidth={1} />
        ))}
        <text x={PAD.left - 6} y={PAD.top + 4} textAnchor="end" fontSize={10.5} fill="var(--text-3)">
          {format(top)}
        </text>
        <text x={PAD.left - 6} y={PAD.top + PLOT_H + 4} textAnchor="end" fontSize={10.5} fill="var(--text-3)">
          {format(bottom)}
        </text>
        <g transform={`translate(${PAD.left}, ${PAD.top})`}>
          {series.map((item) =>
            item.points.length > 1 ? (
              <path
                key={`${item.name}-line`}
                d={linePath(item.points, x, y)}
                fill="none"
                stroke={item.color}
                strokeWidth={1.6}
                strokeDasharray={item.dashed ? "4 3" : undefined}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ) : null,
          )}
          {series.map((item) =>
            item.points.map((point) => (
              <circle key={`${item.name}-${point.at}`} cx={x(point.at)} cy={y(point.value)} r={2.4} fill={item.color}>
                <title>{`${item.name} · ${point.day}：${format(point.value)}`}</title>
              </circle>
            )),
          )}
        </g>
        <text x={PAD.left} y={PAD.top + PLOT_H + 15} fontSize={10.5} fill="var(--text-3)">
          {first.day}
        </text>
        {last.day !== first.day && (
          <text x={PAD.left + PLOT_W} y={PAD.top + PLOT_H + 15} textAnchor="end" fontSize={10.5} fill="var(--text-3)">
            {last.day}
          </text>
        )}
      </svg>
      {series.length > 1 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 14px", fontSize: 11.5, color: "var(--text-3)" }}>
          {series.map((item) => (
            <span key={item.name} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span
                aria-hidden
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: item.color,
                  opacity: item.dashed ? 0.75 : 1,
                  flexShrink: 0,
                }}
              />
              {item.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** 站点人气趋势（两个信号各一张小图）；没有任何数据点时返回 null，由调用方决定整块不渲染。 */
export function PopularityTrendChart({ points }: { points: PopularityPoint[] }) {
  const visits = plotPoints(points, (point) => point.visits);
  const tranco = plotPoints(points, (point) => (point.rank_source === "similarweb" ? null : point.rank));
  const swRank = plotPoints(points, (point) => (point.rank_source === "similarweb" ? point.rank : null));
  if (visits.length === 0 && tranco.length === 0 && swRank.length === 0) return null;
  const rankSeries: Series[] = [];
  if (tranco.length > 0) rankSeries.push({ name: "Tranco 全网排名", color: TRANCO_COLOR, points: tranco });
  if (swRank.length > 0) rankSeries.push({ name: "SimilarWeb 月度排名", color: SW_RANK_COLOR, dashed: true, points: swRank });
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <MiniChart
        title="月访问量"
        hint="SimilarWeb 公开估算 · 每轮采集记一个点"
        series={[{ name: "月访问量", color: VISITS_COLOR, points: visits }]}
        invert={false}
        format={(value) => formatCompact(value)}
      />
      <MiniChart
        title="全网排名"
        hint="越靠上越热 · 每轮采集记一个点"
        series={rankSeries}
        invert
        format={(value) => formatCompact(value)}
      />
    </div>
  );
}
