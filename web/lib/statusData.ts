/** 渠道检测数据统一取数入口：凡是要展示渠道统计的页面（首页、总览、站点详情）
 *  都从这里取，口径只有一份——每站最近 400 条、近 7 天。
 *  曾经三个页面三种取法：首页全局 max_records 抽样、总览全局最近 600 条，
 *  抽样按总 id 取模不保站内密度，会丢渠道、漂移最新可用率
 *  （134-175-71 实测：首页比详情页少 grok-4.6 渠道、可用率 86% vs 75%）。
 *  现在：详情页按详情页同参数拉全量；首页只拉每站「最新一条」算此刻健康度——
 *  完整历史（点阵、可用率趋势）是详情页与原站才需要的东西，不再塞进列表页。 */
import { apiGet } from "./api";
import { buildSiteViews } from "./channelStatus";
import type { StatusSnapshot } from "./types";

/** 与站点详情页同款：每站最近 400 条。 */
export const STATUS_PER_SITE_LIMIT = 400;

/** 窗口固定近 7 天。 */
const STATUS_WINDOW_SECONDS = 7 * 86_400;

/** since 对齐到分钟：URL 稳定便于日志排查（原首页/详情页同款表达式，收拢到这里）。 */
export function statusSince(): number {
  return Math.floor((Date.now() / 1000 - STATUS_WINDOW_SECONDS) / 60) * 60;
}

/** 单站拉取：参数与站点详情页逐字相同，是「详情页口径」的本体。
 *  limit 可调小：只画最近几十个点的场景（如总览点阵懒加载）没必要拉满 400 条。 */
export async function fetchSiteStatus(
  siteId: string,
  headers?: HeadersInit,
  limit: number = STATUS_PER_SITE_LIMIT,
): Promise<StatusSnapshot[]> {
  const data = await apiGet<{ records: StatusSnapshot[] }>(
    `/api/status?site_id=${encodeURIComponent(siteId)}&limit=${limit}&since=${statusSince()}`,
    headers,
  );
  return data.records ?? [];
}

/** 站点此刻健康状况：最新一次检测的正常渠道占比、异常渠道数、检测点数量。 */
export interface SiteLatestStatus {
  /** 最新可用率（0–100），无检测数据为 null */
  pct: number | null;
  /** 最新的异常渠道数 */
  down: number;
  /** 该站最新快照里的检测点数量 */
  checks: number;
  /** 最新检测点时间（秒级时间戳），无数据为 null */
  at: number | null;
}

/** 首页站点健康：只取每站最新一条状态快照（/api/status/latest，整轮约 200KB），
 *  算「此刻可用率」给站点墙与地球用。完整 7 天历史是详情页的事，不在列表页拉。
 *  整轮结果按 60 秒缓存——状态按采集周期（分钟级）更新，一分钟内没必要重算。 */
export async function loadLatestStatus(headers?: HeadersInit): Promise<Record<string, SiteLatestStatus>> {
  const key = headers ? "auth" : "anon";
  const now = Date.now();
  const cached = latestCache.get(key);
  if (cached && now - cached.at < LATEST_TTL_MS) return cached.value;

  const latest = await apiGet<Record<string, StatusSnapshot>>("/api/status/latest", headers).catch(
    () => ({}) as Record<string, StatusSnapshot>,
  );
  const records = Object.values(latest).filter((row) => row && typeof row === "object");
  const views = buildSiteViews(records);
  const out: Record<string, SiteLatestStatus> = {};
  for (const [site, points] of Object.entries(views.availability)) {
    const last = points[points.length - 1];
    out[site] = last
      ? { pct: last.pct, down: last.down.length, checks: points.length, at: last.at }
      : { pct: null, down: 0, checks: 0, at: null };
  }
  latestCache.set(key, { at: now, value: out });
  return out;
}

const LATEST_TTL_MS = 60_000;
const latestCache = new Map<string, { at: number; value: Record<string, SiteLatestStatus> }>();
