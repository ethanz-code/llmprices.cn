import { apiGet } from "@/lib/api";
import type { FeedData, HistoryListData } from "@/lib/types";
import { PageDigest } from "@/components/PageDigest";
import { SiteAlert } from "@/components/SiteAlert";
import { HistoryView } from "@/components/HistoryView";
import { loadSiteLinks, type SiteHomepages, type SiteOrigins } from "@/lib/sites";
import { alerts } from "@/lib/copy";
import { formatCount } from "@/lib/format";
import { pageMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

export const metadata = pageMetadata(
  "事件追踪",
  "各站点价格调整与公告变动的时间线：什么模型、什么时候、涨了还是降了，都有存档。",
  "/history",
);

export default async function HistoryPage() {
  let feed: FeedData | null = null;
  let history: HistoryListData | null = null;
  let error: string | null = null;
  // 站点首页覆盖表与主域名后备表：事件卡站名外链用。公告事件没有来源地址，
  // 没有覆盖配置的站靠 origins 兜底；拉取失败退回内置映射/来源域名后备
  let siteHomepages: SiteHomepages = {};
  let siteOrigins: SiteOrigins = {};
  try {
    // 事件流已由 /api/feed 统一合并（价格+公告），历史记录独立取
    const [feedData, historyData, links] = await Promise.all([
      apiGet<FeedData>("/api/feed?events_limit=300&notice_limit=100"),
      apiGet<HistoryListData>("/api/history?limit=500"),
      loadSiteLinks(),
    ]);
    feed = feedData;
    history = historyData;
    siteHomepages = links.homepages;
    siteOrigins = links.origins;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  return (
    <div className="page">
      <h1 className="sr-only">事件追踪</h1>
      {error && <SiteAlert title={alerts.loadData.title} detail={error} fix={alerts.loadData.fix} />}
      {feed && (
        <PageDigest
          items={[
            { label: "价格事件", value: formatCount(feed.price_total) },
            { label: "公告", value: formatCount(feed.notice_total) },
          ]}
        />
      )}
      {feed && history && (
        <HistoryView
          feed={feed.events}
          history={history}
          siteHomepages={siteHomepages}
          siteOrigins={siteOrigins}
        />
      )}
    </div>
  );
}
