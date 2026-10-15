/** 渠道检测数据统一取数入口：凡是要展示渠道统计的页面（首页、总览、站点详情）都从这里取，
 *  标准只有一份——每站最近 400 条、近 7 天。
 *
 *  列表页（首页/总览）走 /api/status/views：后端一次把各站的渠道行（不含点阵）、可用率序列与
 *  时段分桶算好返回。曾经是逐站拉最近 400 条原始快照（21 站合计约 49MB，内含站点上游整包 JSON）
 *  再在 Node 里解析——瓶颈是这 49MB 的传输与解析，不是请求个数，所以把解析搬到后端、原始 JSON
 *  一步不出后端。解析规则与 lib/channelStatus.ts 由 llm_price_monitor/status_views.py 对齐，
 *  两边数字一致（后端 tests/test_status_views.py 与前端 channelStatus.test.ts 用例一一对应）。
 *  详情页仍拉单站原始快照、前端解析（fetchSiteStatus），因为详情页要画点阵与延迟趋势。 */
import { apiGet } from "./api";
import { type SiteStats } from "./channelStatus";
import type { StatusSnapshot } from "./types";

/** 与站点详情页同款：每站最近 400 条。 */
export const STATUS_PER_SITE_LIMIT = 400;

/** 窗口固定近 7 天。 */
const STATUS_WINDOW_SECONDS = 7 * 86_400;

/** since 对齐到分钟：URL 稳定便于日志排查（原首页/详情页同款表达式，收拢到这里）。 */
export function statusSince(): number {
  return Math.floor((Date.now() / 1000 - STATUS_WINDOW_SECONDS) / 60) * 60;
}

/** 单站拉取：参数与站点详情页逐字相同，是「详情页标准」的本体。
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

/** 列表页渠道视图：一个请求拿全站算好的可用率/时段分桶/渠道成功率。
 *
 *  进程内缓存 + stale-while-revalidate：渠道按采集周期（分钟级）才更新，几分钟内没必要重拉。
 *  有旧结果时永远直接给旧结果、后台刷新（刷新在飞时也不再重复开），于是任何一次访问都不等后端
 *  现算，最坏只差一个周期的新鲜度；只有进程刚起、还没有任何结果时才等一次。
 *  缓存的是「一次计算结果」而非 HTTP 响应，失败即弃缓存，不会把页面钉在旧数据上。
 *  第二个参数仅为兼容旧调用签名（在售模型与分组集合改由后端内部构建），此处忽略。 */
export async function loadStatusViews(headers?: HeadersInit, _overview?: unknown): Promise<SiteStats> {
  const now = Date.now();
  if ((now - viewsCache.at >= STATUS_VIEWS_TTL_MS || viewsCache.value === null) && !viewsCache.refreshing) {
    viewsCache.refreshing = true;
    const pending = computeStatusViews(headers);
    viewsCache.pending = pending;
    pending.then(
      (views) => {
        viewsCache.value = views;
        viewsCache.at = Date.now();
        viewsCache.refreshing = false;
        viewsCache.pending = null;
      },
      () => {
        // 现算失败就弃掉这条缓存，下次访问重新算；也不让 reject 冒泡成 unhandled rejection
        viewsCache.refreshing = false;
        viewsCache.pending = null;
        viewsCache.value = null;
      },
    );
  }
  // 有旧结果就给旧结果（不阻塞）；首次冷启动才等这一趟
  return viewsCache.value ?? viewsCache.pending!;
}

/** 渠道视图缓存寿命：远小于采集周期，肉眼无感却省掉绝大多数重复拉取。 */
const STATUS_VIEWS_TTL_MS = 5 * 60_000;

interface ViewsCacheEntry {
  /** 上次算好的时间戳；决定何时该后台刷新 */
  at: number;
  /** 已算好的结果；有值时请求直接拿它，永不阻塞 */
  value: SiteStats | null;
  /** 是否有一次刷新在飞，避免同一周期重复发起 */
  refreshing: boolean;
  /** 在飞的刷新；仅冷启动（还没有 value）时被等待 */
  pending: Promise<SiteStats> | null;
}

const viewsCache: ViewsCacheEntry = { at: 0, value: null, refreshing: false, pending: null };

async function computeStatusViews(headers?: HeadersInit): Promise<SiteStats> {
  return apiGet<SiteStats>("/api/status/views", headers);
}
