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
  /** 徽标短文案（总览表站点列用） */
  text: string;
  /** 悬停明细 */
  title: string;
}

/** 人气摘要徽标：优先月访问量，其次 Telegram 群/频道人数，最后全网排名；都没有返回 null。 */
export function popularityBadge(popularity?: SitePopularity | null): PopularityBadge | null {
  if (!popularity) return null;
  const traffic = popularity.traffic ?? {};
  const telegram = (popularity.groups ?? []).find((group) => group.type === "telegram" && group.members);
  const kind = telegram ? groupKindLabel(telegram) : "";
  const parts: string[] = [];
  if (traffic.monthly_visits) parts.push(`月访问量约 ${formatCompactCn(traffic.monthly_visits)}（第三方估算）`);
  if (telegram?.members) parts.push(`Telegram ${kind} ${formatCompactCn(telegram.members)} 人`);
  if (traffic.rank) parts.push(`全网排名约 ${formatCompactCn(traffic.rank)}`);
  if (parts.length === 0) return null;
  const text = traffic.monthly_visits
    ? `${formatCompactCn(traffic.monthly_visits)}/月`
    : telegram?.members
      ? `${kind} ${formatCompactCn(telegram.members)} 人`
      : `排名 ${formatCompactCn(traffic.rank ?? 0)}`;
  return { text, title: parts.join("；") };
}

/** 人气明细文本（管理台图标悬停用）：逐行列出交流群、访问量与排名。 */
export function popularityTip(popularity?: SitePopularity | null): string {
  if (!popularity) return "";
  const lines: string[] = [];
  const groups = popularity.groups ?? [];
  if (groups.length > 0) {
    const text = groups
      .map((group) => `${group.label}${group.members != null ? `（${formatCompactCn(group.members)} 人）` : ""}`)
      .join("、");
    lines.push(`交流群：${text}`);
  }
  const traffic = popularity.traffic ?? {};
  if (traffic.monthly_visits != null) lines.push(`月访问量约 ${formatCompactCn(traffic.monthly_visits)}（第三方估算）`);
  if (traffic.rank != null) lines.push(`全网排名约 ${formatCompactCn(traffic.rank)}（Tranco 榜）`);
  return lines.length > 0 ? `站点人气（公开数据）\n${lines.join("\n")}` : "";
}
