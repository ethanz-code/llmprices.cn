/** 检测点阵懒加载的服务端点：列表页不再内嵌渠道数据，行进入视口后由浏览器来这儿按需取。
 *  只拉「够画点阵」的条数（每站最近 45 条），按 站点+分组 短缓存，避免翻页/回退时反复拉。
 *  点名查行（group 来自列表行的价格分组名，必在监测范围内），不做站级过滤。 */
import { NextResponse, type NextRequest } from "next/server";
import { fetchSiteStatus } from "@/lib/statusData";
import { channelDotsBySite, dotsOfGroup, type ChannelDot } from "@/lib/channelStatus";

export const dynamic = "force-dynamic";

/** 点阵只画最近 45 个点（3 行 × 15 列，与 ChannelDotMatrix 的规格一致）。 */
const DOTS_PER_CHANNEL = 45;

/** 结果缓存寿命：状态按采集周期（分钟级）更新，一分钟内的重复取数直接命中。 */
const TTL_MS = 60_000;

const cache = new Map<string, { at: number; dots: ChannelDot[] | null }>();

export async function GET(request: NextRequest) {
  const site = request.nextUrl.searchParams.get("site")?.trim() ?? "";
  const group = request.nextUrl.searchParams.get("group")?.trim() ?? "";
  if (!site || !group) return NextResponse.json({ dots: null });

  const key = `${site}\u0000${group}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return NextResponse.json({ dots: hit.dots });

  let dots: ChannelDot[] | null = null;
  try {
    const records = await fetchSiteStatus(site, undefined, DOTS_PER_CHANNEL);
    const rows = channelDotsBySite(records)[site];
    dots = dotsOfGroup(rows, group)?.slice(-DOTS_PER_CHANNEL) ?? null;
  } catch {
    dots = null;
  }
  // 只缓存成功结果：失败（如后端瞬断）不缓存，下一次请求可立即重试
  if (dots) cache.set(key, { at: now, dots });
  return NextResponse.json({ dots });
}
