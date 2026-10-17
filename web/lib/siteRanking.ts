/**
 * 站点综合分：模型数据页（/overview）每个站点行的排序依据，也是站点卡（首页站点墙、
 * /sites 全部站点页）的排序依据（站点级版本见 buildSiteQuality）。
 *
 * 综合分 = 价格 35% + 渠道稳定 20% + 人气 30% + 配置完整 10% + 公告新鲜 5%（各分项 0–1，
 * 权重写死在此），再减去「数据滞后扣分」（价格沿用旧快照时最多扣 10 分，见 stalenessPenalty）。
 * 目标是「价格低、人气旺、渠道稳的站靠前」：价格与人气是两项大头，渠道稳定次之，
 * 配置完整与公告新鲜只做小幅修正。
 *
 * 关键规则：**价格在当前这张表（当前模型）里比**——同一模型下各站的实付成本横向归一，
 * 谁最便宜谁价格分最高；不拿站点跨模型的中位数，否则会出现「本模型里最便宜的站却排在后面」。
 * 其余四项是站点级的：渠道稳定（近 7 天可用率/成功率）、人气（交流群人数 + 月访问量 +
 * 全网排名，公开数据）、配置完整（六项清单）、公告新鲜（距今分档）。
 *
 * 价格一项按**按重缓存用量折算的实付成本**算：固定按一套「重缓存 Agent 用量」（输入里约 96% 从缓存读取、
 * 输出占 0.4%，见 RANKING_* 常量）折算，缓存读写价直接决定成本——没给缓存读取价的站点按
 * 「无缓存优惠」计（读价回落输入价），不因缺数据被算便宜。
 * 这套规则只服务「站点之间横向比价」，与花费计算器的估算默认值**刻意解耦**：
 * 两边都变了就等于排序变了，而这张表的排序不该被别处的默认值悄悄挪动。
 *
 * 纯函数 + 显式输入，便于单测；渠道稳定从 SiteStats（lib/statusData 的标准）取。
 */
import { calcCost } from "./calculator";
import { effectiveCnyCachePrice, effectiveCnyPrice } from "./format";
import { canonicalModel } from "./modelOrder";
import { hasUsablePrice } from "./priceRows";
import type { OverviewData, OverviewRecord, SiteChannelSummary, SiteFlags } from "./types";
import type { SitePopularityMap } from "./popularity";

/** 五项权重（写死；改规则改这里）。价格仍是第一权重，人气作为平台规模与跑路风险的
 *  独立信号与价格接近（30%），渠道稳定看当下能不能用，配置完整与公告新鲜只做小幅修正。 */
export const SITE_RANK_WEIGHTS = {
  price: 35,
  stability: 20,
  popularity: 30,
  completeness: 10,
  notice: 5,
} as const;

/** 价格项折算成本的用量结构（与花费计算器的默认值无关，见文件头）：输入 96% 命中缓存、
 *  输出占 0.4%。改这两个数等于改榜单排序，动之前先看排序会不会翻盘。 */
const RANKING_HIT_RATE = 96;
const RANKING_OUTPUT_SHARE = 0.4;

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
  /** 人气项 0–1（群人数 + 月访问量 + 排名） */
  popularity: number;
  /** 配置完整项 0–1 */
  completeness: number;
  /** 公告新鲜项 0–1 */
  notice: number;
  /** 数据滞后扣分（已从 score 里扣掉），0–10；价格沿用旧快照时才有值 */
  stale: number;
}

/** 站点级的四项（价格随模型变，不进这里）。 */
export type SiteSideScore = Pick<SiteScore, "stability" | "popularity" | "completeness" | "notice">;

export interface SiteRankInput {
  records: OverviewRecord[];
  /** 展示汇率（USD→CNY）；与总览表同一规则，缺省回落原币 */
  rate: number | null;
  /** 渠道摘要（每站最新可用率/成功率均值/时段分桶，/api/status/summary）；缺省该项取中性分 */
  channelSummary?: SiteChannelSummary | null;
  /** 各站配置标志（后端 /api/overview 下发）；缺省该项取中性分 */
  siteFlags?: Record<string, SiteFlags> | null;
  /** 各站最新公告时间（秒级时间戳）；缺省 = 无公告 */
  noticeAt?: Record<string, number | null | undefined> | null;
  /** 各站人气（交流群人数、月访问量、全网排名，/api/sites/popularity）；缺省该项取中性分 */
  sitePopularity?: SitePopularityMap | null;
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

/** 单条记录按 AI Agent 用量结构折算的实付成本（CNY / 100 万 token 混合用量）；
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
    hitRate: RANKING_HIT_RATE,
    outputShare: RANKING_OUTPUT_SHARE,
  });
  // 真零价（0/0 confirmed）就是 0，算最便宜；只有两档价都缺才 null（上面已挡）
  return total;
}

/** 逐模型算价格分：同一模型下各站取最便宜那一档成本，再按 log 尺度归一。
 *  0 成本（真零价）按「最低正价」同档处理——免费就是最便宜，不给它记成最贵。 */
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
    // 没有正价（全免费）时取 1/10 后备，下面走「同价全给 1」分支，不会算出 NaN。
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

/** 站点渠道稳定项 0–1：近 7 天在售渠道平均可用率（时段分桶按次数加权）与渠道成功率均值
 *  （后端在摘要里算好）取均值；两项都拿不到时返回 null（调用方给中性分）。 */
function stabilityOf(summary: SiteChannelSummary | null | undefined, siteId: string): number | null {
  const entry = summary?.sites?.[siteId];
  const buckets = entry?.buckets ?? [];
  let weighted = 0;
  let count = 0;
  for (const bucket of buckets) {
    if (!bucket) continue;
    weighted += bucket.avg * bucket.count;
    count += bucket.count;
  }
  const availability = count > 0 ? weighted / count : null;
  const success = entry?.success ?? null;

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

/** 人气项的分档锚点：月访问量 5 万/月、Telegram 群 500 人、SimilarWeb 全网排名 100 万为「达标」
 *  （1 分），线性封顶；三个信号取最优，一个都没有 = 0（确实查无公开人气），缺失的信号不奖不罚。
 *  排名是「越小越热」，与访问量/群人数方向相反，单独归一。 */
const POPULARITY_VISITS_ANCHOR = 50_000;
const POPULARITY_MEMBERS_ANCHOR = 500;
const POPULARITY_RANK_ANCHOR = 1_000_000;

export function popularityScoreOf(popularity: SitePopularityMap[string] | undefined): number {
  if (!popularity) return 0;
  const traffic = popularity.traffic ?? {};
  const telegram = (popularity.groups ?? []).find((group) => group.type === "telegram" && group.members);
  const signals: number[] = [];
  if (traffic.monthly_visits) signals.push(traffic.monthly_visits / POPULARITY_VISITS_ANCHOR);
  if (telegram?.members) signals.push(telegram.members / POPULARITY_MEMBERS_ANCHOR);
  if (traffic.rank) signals.push(POPULARITY_RANK_ANCHOR / traffic.rank);
  if (signals.length === 0) return 0;
  return clamp01(Math.max(...signals));
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
      stability: stabilityOf(input.channelSummary, siteId) ?? NEUTRAL,
      popularity: popularityScoreOf(input.sitePopularity?.[siteId]),
      completeness: completenessOf(input.siteFlags?.[siteId]) ?? NEUTRAL,
      notice: noticeFreshness(input.noticeAt?.[siteId], now),
    };
  }
  return { site, priceByModel: priceByModel(input.records, input.rate) };
}

/** 五项加权（0–100，未扣滞后）：行分与站点级质量分共用同一套权重，改权重只改这里。 */
function weightedScore(price: number, side: SiteSideScore): number {
  const weightSum = Object.values(SITE_RANK_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
  return (
    ((SITE_RANK_WEIGHTS.price * price +
      SITE_RANK_WEIGHTS.stability * side.stability +
      SITE_RANK_WEIGHTS.popularity * side.popularity +
      SITE_RANK_WEIGHTS.completeness * side.completeness +
      SITE_RANK_WEIGHTS.notice * side.notice) /
      weightSum) *
    100
  );
}

/** 单行综合分（0–100）：价格取「当前模型内」的归一值，另外四项取站点级，数据滞后另扣。
 *  传整行而不是 (站点, 模型)：滞后扣分要看这一行自己的 last_price_at。 */
export function rowScore(ranking: SiteRanking, row: OverviewRecord): SiteScore {
  const side =
    ranking.site[row.site_id] ?? { stability: NEUTRAL, popularity: 0, completeness: NEUTRAL, notice: 0 };
  const price = ranking.priceByModel[canonicalModel(row.model)]?.[row.site_id] ?? 0;
  const stale = stalenessPenalty(row);
  return { score: Math.max(0, weightedScore(price, side) - stale), price, ...side, stale };
}

/** 行排序键：综合分越高越靠前；站点不在评分表里视为最低。 */
export function rowRankScore(ranking: SiteRanking | undefined, row: OverviewRecord): number {
  return ranking ? rowScore(ranking, row).score : -1;
}

/** 站点级质量分（0–100）：站点卡（首页站点墙、/sites 全部站点页）的排序依据。
 *  与行综合分同一套权重，差别只在「价格」一项：行分比的是「当前这个模型」内的相对价格，
 *  站点级没有单一模型可比，取该站在所售各模型内价格分的平均（每个模型等权），
 *  即「相对别家贵不贵」的跨模型平均——只卖个别便宜模型的站不会因此自动登顶。
 *  没有任何价格数据的站记 0（不是中性）：没有比价依据就不算「质量好」。
 *  数据滞后扣分取该站价行里最差的一行（一般全站同源，最差即「本站数据还新不新」）。 */
export interface SiteQualityScore extends SiteSideScore {
  /** 质量分 0–100 */
  score: number;
  /** 价格项 0–1：所售各模型内价格分的平均；无价格数据为 0 */
  price: number;
  /** 参与价格平均的模型数（0 = 没有任何价格数据） */
  priceModels: number;
  /** 数据滞后扣分（已从 score 里扣掉），取该站最差一行，0–10 */
  stale: number;
}

/** 一步算出全部站点的质量分（站点集合 = 有配置标志的站 ∪ 有价格记录的站）。 */
export function buildSiteQuality(
  ranking: SiteRanking,
  records: OverviewRecord[],
): Record<string, SiteQualityScore> {
  // 价格项：priceByModel 已是「逐模型内归一」，这里把各站所售模型的分数收集起来再平均
  const priceAcc = new Map<string, { sum: number; count: number }>();
  for (const modelScores of Object.values(ranking.priceByModel)) {
    for (const [siteId, score] of Object.entries(modelScores)) {
      const acc = priceAcc.get(siteId) ?? { sum: 0, count: 0 };
      acc.sum += score;
      acc.count += 1;
      priceAcc.set(siteId, acc);
    }
  }
  // 滞后扣分：逐站取最差一行（一般同站各行同源，取最差即「数据是否可信」）
  const staleBySite = new Map<string, number>();
  for (const row of records) {
    staleBySite.set(row.site_id, Math.max(staleBySite.get(row.site_id) ?? 0, stalenessPenalty(row)));
  }
  const out: Record<string, SiteQualityScore> = {};
  const siteIds = new Set([...Object.keys(ranking.site), ...priceAcc.keys(), ...staleBySite.keys()]);
  for (const siteId of siteIds) {
    const side =
      ranking.site[siteId] ?? { stability: NEUTRAL, popularity: 0, completeness: NEUTRAL, notice: 0 };
    const acc = priceAcc.get(siteId);
    const price = acc && acc.count > 0 ? acc.sum / acc.count : 0;
    const stale = staleBySite.get(siteId) ?? 0;
    out[siteId] = {
      score: Math.max(0, weightedScore(price, side) - stale),
      price,
      priceModels: acc?.count ?? 0,
      stale,
      ...side,
    };
  }
  return out;
}

/** 站点卡统一排序（首页站点墙与 /sites 页共用，规则只此一处）：启用的按质量分从高到低，
 *  停用的统一排最后；同分按名称（本地化序），顺序稳定。 */
export function orderSitesByQuality<T extends { id: string; name: string; enabled: boolean }>(
  sites: T[],
  quality: Record<string, SiteQualityScore>,
): T[] {
  return [...sites].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    const diff = (quality[b.id]?.score ?? -1) - (quality[a.id]?.score ?? -1);
    if (diff !== 0) return diff;
    return a.name.localeCompare(b.name, "zh");
  });
}

/** 从页面取到的原始数据一步算出站点质量分（首页站点墙与 /sites 页共用，口径只此一处）：
 *  overview 是 /api/overview 的响应（价格记录、站点配置标志、最新公告、汇率），
 *  channelSummary 是渠道摘要（lib/statusData 的标准取数），sitePopularity 是 /api/sites/popularity。 */
export function buildSiteQualityFromOverview(
  overview: OverviewData,
  channelSummary?: SiteChannelSummary | null,
  sitePopularity?: SitePopularityMap | null,
): Record<string, SiteQualityScore> {
  const records = overview.records;
  return buildSiteQuality(
    buildSiteRanking({
      records,
      rate: overview.catalog.usd_cny_rate ?? null,
      channelSummary,
      siteFlags: overview.site_flags,
      sitePopularity,
      noticeAt: Object.fromEntries(
        Object.entries(overview.notices ?? {}).map(([id, notice]) => [id, notice.captured_at ?? null]),
      ),
    }),
    records,
  );
}
