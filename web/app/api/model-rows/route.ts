/** 模型数据页切换模型时按需取行：服务端拉一次完整 overview（进程内缓存 60 秒，本机毫秒级），
 *  按模型归一键过滤出该模型的行与该批站点的公告摘要后下发。
 *
 *  为什么不让浏览器直接拉 /api/overview：生产开读接口封锁后浏览器拿不到数据接口；
 *  为什么不在首屏带全量行：一个模型一次只展示一张表，全站几千行（约 1.7MB）不该塞进首屏 HTML。
 *  归组键与页面/lib 同一实现（lib/modelGroups），三处不会分叉。 */
import { NextResponse, type NextRequest } from "next/server";
import { apiGet } from "@/lib/api";
import { rowsOfGroup, subsetNotices } from "@/lib/modelGroups";
import type { OverviewData } from "@/lib/types";

export const dynamic = "force-dynamic";

/** 完整 overview 的进程内短缓存：切模型是连续动作，60 秒内多次切换只拉一次后端。 */
const TTL_MS = 60_000;
let cache: { at: number; data: OverviewData } | null = null;

export async function GET(request: NextRequest) {
  const key = request.nextUrl.searchParams.get("key")?.trim() ?? "";
  if (!key) return NextResponse.json({ rows: [], notices: {} });
  const now = Date.now();
  try {
    if (!cache || now - cache.at >= TTL_MS) {
      cache = { at: now, data: await apiGet<OverviewData>("/api/overview") };
    }
    const rows = rowsOfGroup(cache.data.records, key);
    return NextResponse.json({ rows, notices: subsetNotices(cache.data.notices, rows) });
  } catch {
    return NextResponse.json({ rows: null, notices: null }, { status: 502 });
  }
}
