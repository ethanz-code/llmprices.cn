/** 站点人气：交流群链接/群人数、月访问量估算与全网排名（后端定时采集，公开只读）。
 *
 * 数据来自站点公开信息：群链接读站点 /api/status 与首页，Telegram 人数读 t.me 预览页，
 * 月访问量是第三方估算（hypestat，小站无数据），排名是 Tranco 全网榜。页面按来源如实标注，
 * 拿不到就显示"暂无公开数据"，不编数字。 */

import { apiGet } from "./api";

export interface SiteGroup {
  /** telegram / qq / wechat / discord */
  type: string;
  url: string;
  /** 展示名，如 "@cun_ai"、"QQ 群 465298675" */
  label: string;
  /** Telegram 群/频道成员数（t.me 公开预览页，真实数字） */
  members?: number;
  /** 成员数口径：members = 群成员，subscribers = 频道订阅（t.me 预览页原词） */
  members_kind?: "members" | "subscribers";
  online?: number;
  title?: string;
}

export interface SiteTraffic {
  /** 第三方估算的月访问量 */
  monthly_visits?: number;
  visits_source?: string;
  /** Tranco 全网排名（覆盖前 100 万域名） */
  rank?: number;
  rank_source?: string;
  updated_at?: number;
}

export interface SitePopularity {
  groups?: SiteGroup[];
  traffic?: SiteTraffic;
  /** 最近一次采集时间（秒级时间戳） */
  checked_at?: number;
}

export type SitePopularityMap = Record<string, SitePopularity>;

/** 服务端读取全部站点人气；拉不到返回空表（人气区块整体不渲染），不阻塞页面。 */
export async function loadSitePopularity(): Promise<SitePopularityMap> {
  try {
    const data = await apiGet<{ popularity?: SitePopularityMap }>("/api/sites/popularity");
    return data.popularity ?? {};
  } catch {
    return {};
  }
}

/** 中文习惯的数字缩写：134700 → 13.5万，1200000 → 120万，9500 → 9,500。 */
export function formatCompactCn(value: number): string {
  if (value >= 10_000) {
    const wan = value / 10_000;
    return `${wan >= 100 ? Math.round(wan) : Math.round(wan * 10) / 10}万`;
  }
  return value.toLocaleString("en-US");
}

/** 群平台展示名。 */
export function groupPlatformLabel(type: string): string {
  if (type === "telegram") return "Telegram";
  if (type === "qq") return "QQ";
  if (type === "wechat") return "微信";
  if (type === "discord") return "Discord";
  return "交流群";
}

/** 群形态展示名：t.me 预览页把频道人数写作 subscribers、群写作 members。 */
export function groupKindLabel(group: SiteGroup): string {
  if (group.type === "telegram" && group.members_kind === "subscribers") return "频道";
  return "群";
}

export interface PopularityBadge {
  /** 人气列显示段（每段一行，不拼接）：访问量 / TG群(TG频道)人数 / 排名 */
  lines: string[];
  /** 悬停明细 */
  title: string;
}

/** 人气摘要：固定「访问量 / TG群(TG频道)人数 / 排名」三段，有哪段显示哪段，每段一行——
 *  同一列内格式统一，不做"挑最强信号"的取舍。全空返回 null。 */
export function popularityBadge(popularity?: SitePopularity | null): PopularityBadge | null {
  if (!popularity) return null;
  const traffic = popularity.traffic ?? {};
  const telegram = (popularity.groups ?? []).find((group) => group.type === "telegram" && group.members);
  const kind = telegram ? groupKindLabel(telegram) : "";
  const lines = [
    traffic.monthly_visits ? `访问量：${formatCompactCn(traffic.monthly_visits)}/月` : null,
    telegram?.members ? `TG${kind}：${formatCompactCn(telegram.members)} 人` : null,
    traffic.rank ? `排名：${formatCompactCn(traffic.rank)}` : null,
  ].filter((line): line is string => line !== null);
  if (lines.length === 0) return null;
  const parts = [
    traffic.monthly_visits ? `访问量：每月约 ${formatCompactCn(traffic.monthly_visits)}（SimilarWeb 公开数据估算，每月更新）` : null,
    telegram?.members ? `Telegram ${kind}：${formatCompactCn(telegram.members)} 人（公开页面统计）` : null,
    traffic.rank ? `全网排名：约第 ${formatCompactCn(traffic.rank)} 名（Tranco 榜）` : null,
  ].filter((part): part is string => part !== null);
  return { lines, title: parts.join("\n") };
}

/** 人气列的排序值：与 siteRanking 的 popularity 分项同口径（月访问量/群人数/排名取最优，0–1），
 *  让表格的列排序与综合分排序一致。 */
export function popularitySortValue(popularity?: SitePopularity | null): number {
  if (!popularity) return 0;
  const traffic = popularity.traffic ?? {};
  const telegram = (popularity.groups ?? []).find((group) => group.type === "telegram" && group.members);
  const signals: number[] = [];
  if (traffic.monthly_visits) signals.push(traffic.monthly_visits / 50_000);
  if (telegram?.members) signals.push(telegram.members / 500);
  if (traffic.rank) signals.push(1_000_000 / traffic.rank);
  return signals.length === 0 ? 0 : Math.min(1, Math.max(...signals));
}
