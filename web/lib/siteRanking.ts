/**
 * 站点综合分：模型数据页（/overview）的站点行排序依据。
 *
 * 综合分 = 价格 45% + 渠道稳定 25% + 配置完整 15% + 公告新鲜 15%（各分项 0–1，权重写死在此）。
 * 目标是「价格越低、配置越全、公告越新、渠道越稳的站点越靠前」。
 *
 * 价格一项按**缓存加权实付成本**算：用花费计算器同款 AI Agent 口径（输入里约 96% 从缓存读取、
 * 输出占 0.4%），缓存读写价直接决定成本——没给缓存读取价的站点按「无缓存优惠」计（读价回落输入价），
 * 不因缺数据而被算便宜。同一模型内按 log 尺度归一（不同模型不混比），站点取各模型得分的中位数。
 *
 * 纯函数 + 显式输入，便于单测；渠道稳定从 SiteViews（lib/statusData 的口径）取。
 */
import { DEFAULT_HIT_RATE, DEFAULT_OUTPUT_SHARE, calcCost } from "./calculator";
import { effectiveCnyCachePrice, effectiveCnyPrice } from "./format";
import { canonicalModel } from "./modelOrder";
import { hasUsablePrice } from "./priceRows";
import type { SiteViews } from "./channelStatus";
import type { OverviewRecord, SiteFlags } from "./types";

/** 四项权重（写死；改口径改这里）。 */
export const SITE_RANK_WEIGHTS = {
  price: 45,
  stability: 25,
  completeness: 15,
  notice: 15,
} as const;

/** 「配置完整」清单：逐项已配置记 1 分，取命中比例。 */
export const SITE_RANK_CHECKLIST: (keyof SiteFlags)[] = [
  "network",
  "status",
  "notice",
  "networks",
  "token_refresh",
  "homepage",
];

/** 公告新鲜度分档：≤7 天满分，之后线性衰减，≥60 天为 0。 */
const NOTICE_FRESH_DAYS = 7;
const NOTICE_STALE_DAYS = 60;

/** 缺数据的默认分（中性，既不奖励也不重罚）。 */
const NEUTRAL = 0.5;

export interface SiteScore {
  /** 综合分 0–100 */
  score: number;
  /** 价格项 0–1（1 = 同模型里最便宜） */
  price: number;
  /** 渠道稳定项 0–1 */
  stability: number;
  /** 配置完整项 0–1 */
  completeness: number;
  /** 公告新鲜项 0–1 */
  notice: number;
}

export interface SiteRankInput {
  records: OverviewRecord[];
  /** 展示汇率（USD→CNY）；与总览表同一口径，缺省回落原币 */
  rate: number | null;
  /** 渠道检测视图（每站可用率/渠道成功率）；缺省该项取中性分 */
  views?: SiteViews | null;
  /** 各站配置标志（后端 /api/overview 下发）；缺省该项取中性分 */
  siteFlags?: Record<string, SiteFlags> | null;
  /** 各站最新公告时间（秒级时间戳）；缺省 = 无公告 */
  noticeAt?: Record<string, number | null | undefined> | null;
  /** 当前时间（秒级）；单测注入用，缺省取 now */
  now?: number;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 单条记录按 AI Agent 用量口径折算的实付成本（CNY / 100 万 token 混合用量）；
 *  缓存读价缺失按输入价计（无缓存优惠），不把没报缓存价的站点算便宜。两档价都缺返回 null。 */
export function effectiveCostCny(row: OverviewRecord, rate: number | null): number | null {
  const input = effectiveCnyPrice(row, "input_price", rate);
  const output = effectiveCnyPrice(row, "output_price", rate);
  if (input == null && output == null) return null;
  const base = input ?? output ?? 0;
  const prices = {
    input: base,
    output: output ?? base,
    cacheRead: effectiveCnyCachePrice(row, "cache_read_price", rate) ?? base,
    cacheWrite: effectiveCnyCachePrice(row, "cache_create_price", rate) ?? base,
  };
  const { total } = calcCost(prices, {
    total: 1_000_000,
    hitRate: DEFAULT_HIT_RATE,
    outputShare: DEFAULT_OUTPUT_SHARE,
  });
  return total > 0 ? total : null;
}

/** 各站价格项 0–1：同模型内按 log 尺度归一后取中位数；只有一个站点在售的模型不参与（没有比较）。 */
function priceScores(records: OverviewRecord[], rate: number | null): Map<string, number> {
  // 模型 → 站点 → 该模型下最便宜的成本（同站多分组取最低，等价于用户会挑的那档）
  const byModel = new Map<string, Map<string, number>>();
  for (const row of records) {
    if (!hasUsablePrice(row)) continue;
    const cost = effectiveCostCny(row, rate);
    if (cost == null) continue;
    const model = canonicalModel(row.model);
    const sites = byModel.get(model) ?? new Map<string, number>();
    byModel.set(model, sites);
    const prev = sites.get(row.site_id);
    if (prev == null || cost < prev) sites.set(row.site_id, cost);
  }
  const perSite = new Map<string, number[]>();
  for (const sites of byModel.values()) {
    if (sites.size < 2) continue; // 单站模型没有横向比较，不给分
    const costs = [...sites.values()];
    const lo = Math.min(...costs);
    const hi = Math.max(...costs);
    for (const [site, cost] of sites) {
      // log 尺度：价格跨几个数量级时才不至于被一个离群值压平
      const ratio = hi > lo ? clamp01((Math.log(cost) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) : 0;
      const list = perSite.get(site) ?? [];
      list.push(1 - ratio); // 最便宜 = 1
      perSite.set(site, list);
    }
  }
  const result = new Map<string, number>();
  for (const [site, scores] of perSite) {
    const value = median(scores);
    if (value != null) result.set(site, value);
  }
  return result;
}

/** 各站渠道稳定项 0–1：近 7 天在售渠道平均可用率（时段桶按次数加权）与渠道成功率取均值；
 *  两项都拿不到时返回 null（调用方给中性分）。 */
function stabilityOf(views: SiteViews | null | undefined, siteId: string): number | null {
  const buckets = views?.uptimeBuckets?.[siteId] ?? [];
  let weighted = 0;
  let count = 0;
  for (const bucket of buckets) {
    if (!bucket) continue;
    weighted += bucket.avg * bucket.count;
    count += bucket.count;
  }
  const availability = count > 0 ? weighted / count : null;

  const rates = (views?.channels?.[siteId] ?? [])
    .map((channel) => channel.successRate24h)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const success = rates.length > 0 ? rates.reduce((sum, value) => sum + value, 0) / rates.length : null;

  if (availability != null && success != null) return clamp01((availability + success) / 2 / 100);
  if (availability != null) return clamp01(availability / 100);
  if (success != null) return clamp01(success / 100);
  return null;
}

/** 配置完整项：清单命中比例；无配置标志（未采集/未配置）返回 null。 */
function completenessOf(flags: SiteFlags | undefined): number | null {
  if (!flags) return null;
  const hit = SITE_RANK_CHECKLIST.filter((key) => flags[key]).length;
  return hit / SITE_RANK_CHECKLIST.length;
}

/** 公告新鲜项：距今天数分档（≤7 天 1、≥60 天 0，中间线性）；无公告 0。 */
function noticeFreshness(at: number | null | undefined, now: number): number {
  if (at == null) return 0;
  const days = (now - at) / 86_400;
  if (days <= NOTICE_FRESH_DAYS) return 1;
  if (days >= NOTICE_STALE_DAYS) return 0;
  return (NOTICE_STALE_DAYS - days) / (NOTICE_STALE_DAYS - NOTICE_FRESH_DAYS);
}

/** 汇总各站综合分；站点集合 = 价格记录涉及的站 ∪ 有配置标志的站。 */
export function computeSiteScores(input: SiteRankInput): Record<string, SiteScore> {
  const now = input.now ?? Date.now() / 1000;
  const siteIds = new Set<string>();
  for (const row of input.records) siteIds.add(row.site_id);
  for (const id of Object.keys(input.siteFlags ?? {})) siteIds.add(id);

  const prices = priceScores(input.records, input.rate);
  const weightSum =
    SITE_RANK_WEIGHTS.price +
    SITE_RANK_WEIGHTS.stability +
    SITE_RANK_WEIGHTS.completeness +
    SITE_RANK_WEIGHTS.notice;

  const result: Record<string, SiteScore> = {};
  for (const siteId of siteIds) {
    const price = prices.get(siteId) ?? 0;
    const stability = stabilityOf(input.views, siteId) ?? NEUTRAL;
    const completeness = completenessOf(input.siteFlags?.[siteId]) ?? NEUTRAL;
    const notice = noticeFreshness(input.noticeAt?.[siteId], now);
    const score =
      (SITE_RANK_WEIGHTS.price * price +
        SITE_RANK_WEIGHTS.stability * stability +
        SITE_RANK_WEIGHTS.completeness * completeness +
        SITE_RANK_WEIGHTS.notice * notice) /
      weightSum;
    result[siteId] = { score: score * 100, price, stability, completeness, notice };
  }
  return result;
}

/** 站点分排序键：分数高者在前；无分视为最低。 */
export function siteScoreRank(scores: Record<string, SiteScore> | undefined, siteId: string): number {
  return scores?.[siteId]?.score ?? -1;
}
