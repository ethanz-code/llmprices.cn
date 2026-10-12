/**
 * 站点综合分：模型数据页（/overview）每个站点行的排序依据。
 *
 * 综合分 = 价格 50% + 渠道稳定 20% + 配置完整 15% + 公告新鲜 15%（各分项 0–1，权重写死在此），
 * 再减去「数据滞后扣分」（价格沿用旧快照时最多扣 10 分，见 stalenessPenalty）。
 * 目标是「价格越低越靠前，同时看配置/公告/渠道的配比」。
 *
 * 关键口径：**价格在当前这张表（当前模型）里比**——同一模型下各站的实付成本横向归一，
 * 谁最便宜谁价格分最高；不拿站点跨模型的中位数，否则会出现「本模型里最便宜的站却排在后面」。
 * 其余三项是站点级的：渠道稳定（近 7 天可用率/成功率）、配置完整（六项清单）、公告新鲜（距今分档）。
 *
 * 价格一项按**缓存加权实付成本**算：花费计算器同款 AI Agent 口径（输入里约 96% 从缓存读取、
 * 输出占 0.4%），缓存读写价直接决定成本——没给缓存读取价的站点按「无缓存优惠」计（读价回落输入价），
 * 不因缺数据被算便宜。
 *
 * 纯函数 + 显式输入，便于单测；渠道稳定从 SiteStats（lib/statusData 的口径）取。
 */
import { DEFAULT_HIT_RATE, DEFAULT_OUTPUT_SHARE, calcCost } from "./calculator";
import { effectiveCnyCachePrice, effectiveCnyPrice } from "./format";
import { canonicalModel } from "./modelOrder";
import { hasUsablePrice } from "./priceRows";
import type { SiteStats } from "./channelStatus";
import type { OverviewRecord, SiteFlags } from "./types";

/** 四项权重（写死；改口径改这里）。价格占一半，其余三项共一半。 */
export const SITE_RANK_WEIGHTS = {
  price: 50,
  stability: 20,
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

/** 数据滞后扣分上限：价格沿用旧快照（一般说明 token 过期、没取到新数据）的站点最多往下压这么多分。
 *  从综合分里直接扣，不占权重比例——滞后是「数据可信度」问题，不该挤掉价格/稳定这些正向分项。 */
export const STALE_PENALTY_MAX = 10;
/** 滞后 1 天以内不扣（采集节奏本身有误差），滞后满 4 天扣满。 */
const STALE_GRACE_DAYS = 1;
const STALE_FULL_DAYS = 3;

/** 缺数据的默认分（中性，既不奖励也不重罚）。 */
const NEUTRAL = 0.5;

export interface SiteScore {
  /** 综合分 0–100 */
  score: number;
  /** 价格项 0–1（1 = 当前模型里最便宜） */
  price: number;
  /** 渠道稳定项 0–1 */
  stability: number;
  /** 配置完整项 0–1 */
  completeness: number;
  /** 公告新鲜项 0–1 */
  notice: number;
  /** 数据滞后扣分（已从 score 里扣掉），0–10；价格沿用旧快照时才有值 */
  stale: number;
}

/** 站点级的三项（价格随模型变，不进这里）。 */
export type SiteSideScore = Pick<SiteScore, "stability" | "completeness" | "notice">;

export interface SiteRankInput {
  records: OverviewRecord[];
  /** 展示汇率（USD→CNY）；与总览表同一口径，缺省回落原币 */
  rate: number | null;
  /** 渠道检测视图（每站可用率/渠道成功率）；缺省该项取中性分 */
  views?: SiteStats | null;
  /** 各站配置标志（后端 /api/overview 下发）；缺省该项取中性分 */
  siteFlags?: Record<string, SiteFlags> | null;
  /** 各站最新公告时间（秒级时间戳）；缺省 = 无公告 */
  noticeAt?: Record<string, number | null | undefined> | null;
  /** 当前时间（秒级）；单测注入用，缺省取 now */
  now?: number;
}

export interface SiteRanking {
  /** 站点级三项（价格除外），0–1 */
  site: Record<string, SiteSideScore>;
  /** canonicalModel → 站点 → 该模型内归一后的价格分（0–1，1 = 该模型里最便宜） */
  priceByModel: Record<string, Record<string, number>>;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
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
  // 真免费档（0/0 confirmed）就是 0，算最便宜；只有两档价都缺才 null（上面已挡）
  return total;
}

/** 逐模型算价格分：同一模型下各站取最便宜那一档成本，再按 log 尺度归一。
 *  0 成本（真免费档）按「最低正价」同档处理——免费就是最便宜，不给它记成最贵。 */
function priceByModel(records: OverviewRecord[], rate: number | null): Record<string, Record<string, number>> {
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
  const result: Record<string, Record<string, number>> = {};
  for (const [model, sites] of byModel) {
    const costs = [...sites.values()];
    const positive = costs.filter((cost) => cost > 0);
    // 免费档（0 成本）按「最低正价的 1/10」处理：既让它压过一切付费档，又不把付费档全压成一片。
    // 没有正价（全免费）时取 1/10 兜底，下面走「同价全给 1」分支，不会算出 NaN。
    const freeFloor = (positive.length > 0 ? Math.min(...positive) : 1) / 10;
    const hasFree = positive.length < costs.length;
    const lo = hasFree ? freeFloor : Math.min(...costs);
    const hi = Math.max(...costs);
    const logOf = (cost: number) => Math.log(Math.max(cost, freeFloor));
    const scores: Record<string, number> = {};
    for (const [site, cost] of sites) {
      // log 尺度：价格跨几个数量级时才不至于被一个离群值压平；全站同价算 1
      scores[site] = hi > lo ? 1 - clamp01((logOf(cost) - logOf(lo)) / (logOf(hi) - logOf(lo))) : 1;
    }
    result[model] = scores;
  }
  return result;
}

/** 站点渠道稳定项 0–1：近 7 天在售渠道平均可用率（时段桶按次数加权）与渠道成功率取均值；
 *  两项都拿不到时返回 null（调用方给中性分）。 */
function stabilityOf(views: SiteStats | null | undefined, siteId: string): number | null {
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

/** 数据滞后扣分（0–10）：价格是沿用上次快照的（last_price_at 落后 captured_at），
 *  多半是 token 过期没取到新数据；滞后超 1 天开始扣，满 4 天扣满。 */
function stalenessPenalty(row: OverviewRecord): number {
  const staleSeconds = row.captured_at - (row.last_price_at ?? row.captured_at);
  const over = Math.max(0, staleSeconds / 86_400 - STALE_GRACE_DAYS);
  return STALE_PENALTY_MAX * Math.min(1, over / STALE_FULL_DAYS);
}

/** 汇总：站点级三项 + 逐模型价格分。站点集合 = 价格记录涉及的站 ∪ 有配置标志的站。 */
export function buildSiteRanking(input: SiteRankInput): SiteRanking {
  const now = input.now ?? Date.now() / 1000;
  const siteIds = new Set<string>();
  for (const row of input.records) siteIds.add(row.site_id);
  for (const id of Object.keys(input.siteFlags ?? {})) siteIds.add(id);

  const site: Record<string, SiteSideScore> = {};
  for (const siteId of siteIds) {
    site[siteId] = {
      stability: stabilityOf(input.views, siteId) ?? NEUTRAL,
      completeness: completenessOf(input.siteFlags?.[siteId]) ?? NEUTRAL,
      notice: noticeFreshness(input.noticeAt?.[siteId], now),
    };
  }
  return { site, priceByModel: priceByModel(input.records, input.rate) };
}

/** 单行综合分（0–100）：价格取「当前模型内」的归一值，另外三项取站点级，数据滞后另扣。
 *  传整行而不是 (站点, 模型)：滞后扣分要看这一行自己的 last_price_at。 */
export function rowScore(ranking: SiteRanking, row: OverviewRecord): SiteScore {
  const side = ranking.site[row.site_id] ?? { stability: NEUTRAL, completeness: NEUTRAL, notice: 0 };
  const price = ranking.priceByModel[canonicalModel(row.model)]?.[row.site_id] ?? 0;
  const weightSum =
    SITE_RANK_WEIGHTS.price +
    SITE_RANK_WEIGHTS.stability +
    SITE_RANK_WEIGHTS.completeness +
    SITE_RANK_WEIGHTS.notice;
  const weighted =
    (SITE_RANK_WEIGHTS.price * price +
      SITE_RANK_WEIGHTS.stability * side.stability +
      SITE_RANK_WEIGHTS.completeness * side.completeness +
      SITE_RANK_WEIGHTS.notice * side.notice) /
    weightSum;
  const stale = stalenessPenalty(row);
  const score = Math.max(0, weighted * 100 - stale);
  return { score, price, ...side, stale };
}

/** 行排序键：综合分越高越靠前；站点不在评分表里视为最低。 */
export function rowRankScore(ranking: SiteRanking | undefined, row: OverviewRecord): number {
  return ranking ? rowScore(ranking, row).score : -1;
}
