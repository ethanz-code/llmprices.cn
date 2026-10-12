/** 渠道检测数据统一取数入口：凡是要展示渠道统计的页面（首页、总览、站点详情）
 *  都从这里取，口径只有一份——每站最近 400 条、近 7 天。
 *  曾经三个页面三种取法：首页全局 max_records 抽样、总览全局最近 600 条，
 *  抽样按总 id 取模不保站内密度，会丢渠道、漂移最新可用率
 *  （134-175-71 实测：首页比详情页少 grok-4.6 渠道、可用率 86% vs 75%）。
 *  现在逐站按详情页同参数拉取，数据同源，数字不可能再分叉。 */
import { apiGet } from "./api";
import { buildMonitoredSets, buildSiteViews, type SiteViews } from "./channelStatus";
import type { OverviewData, StatusSnapshot } from "./types";

/** 与站点详情页同款：每站最近 400 条。 */
export const STATUS_PER_SITE_LIMIT = 400;

/** 窗口固定近 7 天。 */
const STATUS_WINDOW_SECONDS = 7 * 86_400;

/** since 对齐到分钟：URL 稳定便于日志排查（原首页/详情页同款表达式，收拢到这里）。 */
export function statusSince(): number {
  return Math.floor((Date.now() / 1000 - STATUS_WINDOW_SECONDS) / 60) * 60;
}

/** 单站拉取：参数与站点详情页逐字相同，是「详情页口径」的本体。
 *  limit 可调小：只画最近几十个点的场景（总览点阵懒加载）没必要拉满 400 条。 */
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

/** 全站视图：站点清单取 /api/status/latest（只含采过状态的站），逐站并发拉详情页口径，
 *  单站失败只缺该站、不拖垮整页；合并后跑一次 buildSiteViews，各站视图共享同一份输入。
 *  overview 传同页已在拉取的 /api/overview 在飞 Promise（并行不重复请求），由它构建各站
 *  「在售监测集」，渠道视图只保留对得上在售模型/分组的行（零命中回退全量）；不传则自己拉一份。 */
export async function loadStatusViews(
  headers?: HeadersInit,
  overview?: Promise<OverviewData | null>,
): Promise<SiteViews> {
  // 进程内缓存 + stale-while-revalidate：这份数据每次要拉 21 站全量快照（合计 40MB+，逐条内含
  // 站点上游原始 JSON），现算渠道点阵约 1.5 秒；而渠道按采集周期（分钟级）才更新，几分钟内没必要
  // 重拉。有旧结果时永远直接给旧结果、后台刷新（刷新在飞时也不再重复开），于是任何一次访问都不等
  // 现算，最坏只差一个周期的新鲜度；只有进程刚起、还没有任何结果时才会等一次。
  // 缓存的是「一次计算结果」而非 HTTP 响应，失败即弃缓存，不会像 fetch 的 next.revalidate
  // 那样把页面钉在旧数据上。
  const key = headers ? "auth" : "anon";
  const now = Date.now();
  const entry = viewsCache.get(key) ?? { at: 0, value: null, refreshing: false, pending: null };
  viewsCache.set(key, entry);
  if ((now - entry.at >= STATUS_VIEWS_TTL_MS || entry.value === null) && !entry.refreshing) {
    entry.refreshing = true;
    const pending = computeStatusViews(headers, overview);
    entry.pending = pending;
    pending.then(
      (views) => {
        entry.value = views;
        entry.at = Date.now();
        entry.refreshing = false;
        entry.pending = null;
      },
      () => {
        // 现算失败就弃掉这条缓存，下次访问重新算；也不让 reject 冒泡成 unhandled rejection
        entry.refreshing = false;
        entry.pending = null;
        viewsCache.delete(key);
      },
    );
  }
  // 有旧结果就给旧结果（不阻塞）；首次冷启动才等这一趟
  return entry.value ?? entry.pending!;
}

/** 渠道视图缓存寿命：远小于采集周期，肉眼无感却省掉绝大多数重复拉取。 */
const STATUS_VIEWS_TTL_MS = 5 * 60_000;

interface ViewsCacheEntry {
  /** 上次算好的时间戳；决定何时该后台刷新 */
  at: number;
  /** 已算好的结果；有值时请求直接拿它，永不阻塞 */
  value: SiteViews | null;
  /** 是否有一次刷新在飞，避免同一周期重复发起 */
  refreshing: boolean;
  /** 在飞的刷新；仅冷启动（还没有 value）时被等待 */
  pending: Promise<SiteViews> | null;
}

const viewsCache = new Map<string, ViewsCacheEntry>();

async function computeStatusViews(
  headers?: HeadersInit,
  overview?: Promise<OverviewData | null>,
): Promise<SiteViews> {
  const latest = await apiGet<Record<string, unknown>>("/api/status/latest", headers).catch(
    () => ({} as Record<string, unknown>),
  );
  const siteIds = Object.keys(latest);
  const [batches, overviewData] = await Promise.all([
    Promise.all(
      siteIds.map((siteId) => fetchSiteStatus(siteId, headers).catch(() => [] as StatusSnapshot[])),
    ),
    (overview ?? apiGet<OverviewData>("/api/overview", headers)).catch(() => null),
  ]);
  const monitored = overviewData ? buildMonitoredSets(overviewData.records) : undefined;
  return buildSiteViews(batches.flat(), monitored);
}
