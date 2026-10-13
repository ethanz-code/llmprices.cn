/** 公告正文按需取：事件流为省体积只下发摘要，详情弹窗打开时来这儿取该条事件的完整正文。
 *  走服务端转发（带内网令牌），生产开读接口封锁时浏览器侧也能取到——与 app/api/channel-dots 同一套路。 */
import { NextResponse, type NextRequest } from "next/server";
import { apiGetOptional } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const site = request.nextUrl.searchParams.get("site_id")?.trim() ?? "";
  // 事件流里带的是同一份浮点时间戳，直接原样回传后端定位（详见 store.notice_event_content）
  const rawDetectedAt = request.nextUrl.searchParams.get("detected_at");
  const detectedAt = rawDetectedAt === null ? Number.NaN : Number(rawDetectedAt);
  if (!site || !Number.isFinite(detectedAt)) {
    return NextResponse.json({ content: null }, { status: 400 });
  }
  const body = await apiGetOptional<{ content: string }>(
    `/api/notice/event?site_id=${encodeURIComponent(site)}&detected_at=${detectedAt}`,
  );
  if (!body?.content) return NextResponse.json({ content: null }, { status: 404 });
  return NextResponse.json({ content: body.content });
}
