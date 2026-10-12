import { cookies } from "next/headers";
import { apiGet } from "@/lib/api";
import { buildRankingIndex, type RankingHit } from "@/lib/rankings";
import { loadSiteHomepages, type SiteHomepages } from "@/lib/sites";
import { catalogModelOrderIndex, type ModelOrderEntry } from "@/lib/modelOrder";
import type { CatalogData, OverviewData, RankingsData } from "@/lib/types";
import { alerts } from "@/lib/copy";
import { formatCount } from "@/lib/format";
import { PageDigest } from "@/components/PageDigest";
import { OverviewTable } from "@/components/OverviewTable";
import { SiteAlert } from "@/components/SiteAlert";
import { pageMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

export const metadata = pageMetadata(
  "中转站定价",
  "各家中转站的模型输入输出价格与折扣对照，附渠道可用率，每条价格都附来源链接，点开就能核对。",
  "/overview",
);

// collect_status（需要关注的站点）仅管理员可见：服务端请求必须带上会话 cookie。
// 因此本页取数带会话 cookie 且保持 no-store——管理员与匿名访客的取数结果不能共享
const SESSION_COOKIE = "ppm_session";

// 本页只取「列表本身」：价格行 + 排序/徽标索引。渠道点阵不再随列表下发（整轮 40MB+），
// 改由每行的懒加载组件进入视口后按需向后端要（见 app/api/channel-dots）。
export default async function OverviewPage() {
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  const headers = session ? { Cookie: `${SESSION_COOKIE}=${session}` } : undefined;
  let data: OverviewData | null = null;
  // AA 榜单匹配索引：给当前选中模型挂排名徽标；拉取失败只影响徽标
  let rankingsIndex: Record<string, RankingHit> = {};
  // 目录排序索引（模型归一键 → 厂商序+发布日期）：模型下拉按「厂商分块+发布倒序」排的依据；
  // 只传这份轻量映射而非整个目录，拉取失败只影响排序口径（退化为按名称）
  let modelOrder: Record<string, ModelOrderEntry> = {};
  // 站点首页覆盖表：站名外链用；拉取失败退回内置映射/来源域名兜底（loadSiteHomepages 自带兜底）
  let siteHomepages: SiteHomepages = {};
  let error: string | null = null;
  try {
    const [overview, rankings, catalog, homepages] = await Promise.all([
      apiGet<OverviewData>("/api/overview", headers),
      apiGet<RankingsData>("/api/rankings").catch(() => null),
      apiGet<CatalogData>("/api/catalog").catch(() => null),
      loadSiteHomepages(),
    ]);
    data = overview;
    rankingsIndex = buildRankingIndex(rankings);
    modelOrder = catalogModelOrderIndex(catalog?.models ?? {});
    siteHomepages = homepages;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  return (
    <div className="page">
      {/* 数据页不设可见页头（当前页由导航标识），仅给搜索引擎与读屏留隐藏 h1 */}
      <h1 className="sr-only">中转站定价</h1>
      {error && <SiteAlert title={alerts.loadData.title} detail={error} fix={alerts.loadData.fix} />}
      {data && (
        <PageDigest
          items={[
            { label: "站点", value: formatCount(new Set(data.records.map((row) => row.site_id)).size) },
            { label: "模型", value: formatCount(new Set(data.records.map((row) => row.model)).size) },
            { label: "价格记录", value: formatCount(data.records.length) },
          ]}
        />
      )}
      {data && (
        <OverviewTable
          data={data}
          rankingsIndex={rankingsIndex}
          modelOrder={modelOrder}
          siteHomepages={siteHomepages}
        />
      )}
    </div>
  );
}
