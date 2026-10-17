import { apiGet } from "@/lib/api";
import { buildRankingIndex, type RankingHit } from "@/lib/rankings";
import { buildSiteRanking, type SiteRanking } from "@/lib/siteRanking";
import { loadSiteChannelSummary } from "@/lib/statusData";
import { loadSiteHomepages, type SiteHomepages } from "@/lib/sites";
import { loadSitePopularity, type SitePopularityMap } from "@/lib/popularity";
import { buildModelIndex, rowsOfGroup, subsetNotices } from "@/lib/modelGroups";
import { catalogModelOrderIndex, type ModelOrderEntry } from "@/lib/modelOrder";
import type { CatalogData, OverviewData, RankingsData } from "@/lib/types";
import { alerts, risk } from "@/lib/copy";
import { formatCount } from "@/lib/format";
import { PageDigest } from "@/components/PageDigest";
import { OverviewTable } from "@/components/OverviewTable";
import { RiskNotice } from "@/components/RiskNotice";
import { SiteAlert } from "@/components/SiteAlert";
import { pageMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

export const metadata = pageMetadata(
  "中转站定价",
  "各家中转站的模型输入输出价格与折扣对照，附渠道可用率，每条价格都附来源链接，点开就能核对。",
  "/overview",
);

// 本页只取「列表本身」：价格行 + 排序/徽标索引。检测点阵不再随列表下发（整轮 40MB+），
// 改由每行的懒加载组件进入视口后按需向后端要（见 app/api/channel-dots）。
// 取数不带会话 cookie：/api/overview 对管理员与访客返回同一份数据（采集异常清单公开脱敏下发），
// 页面不随登录态分叉。
export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ model?: string }>;
}) {
  const params = await searchParams;
  let data: OverviewData | null = null;
  // 站点综合分：服务端算好（各模型内的价格 + 站点级渠道稳定/配置完整/公告新鲜），只把评分下发给表，
  // 不把渠道原始数据塞进列表（点阵仍是逐行懒加载）
  let siteRanking: SiteRanking | undefined;
  // AA 榜单匹配索引：给当前选中模型挂排名徽标；拉取失败只影响徽标
  let rankingsIndex: Record<string, RankingHit> = {};
  // 目录排序索引（模型归一键 → 厂商序+发布日期）：模型下拉按「厂商分块+发布倒序」排的依据；
  // 只传这份轻量映射而非整个目录，拉取失败只影响排序规则（退化为按名称）
  let modelOrder: Record<string, ModelOrderEntry> = {};
  // 站点首页覆盖表：站名外链用；拉取失败退回内置映射/来源域名后备（loadSiteHomepages 自带后备）
  let siteHomepages: SiteHomepages = {};
  // 站点人气：站点列的月访问量/群人数徽标用；拉取失败整体不挂徽标（loadSitePopularity 自带后备）
  let sitePopularity: SitePopularityMap = {};
  let error: string | null = null;
  try {
    // 渠道摘要（每站可用率/成功率）SWR 缓存，只服务排序，失败只让「渠道稳定」一项取中性分
    const [overview, rankings, catalog, homepages, channelSummary, popularity] = await Promise.all([
      apiGet<OverviewData>("/api/overview"),
      apiGet<RankingsData>("/api/rankings").catch(() => null),
      apiGet<CatalogData>("/api/catalog").catch(() => null),
      loadSiteHomepages(),
      loadSiteChannelSummary().catch(() => null),
      loadSitePopularity(),
    ]);
    data = overview;
    rankingsIndex = buildRankingIndex(rankings);
    modelOrder = catalogModelOrderIndex(catalog?.models ?? {});
    siteHomepages = homepages;
    sitePopularity = popularity;
    siteRanking = buildSiteRanking({
      records: overview.records,
      rate: overview.catalog.usd_cny_rate ?? null,
      channelSummary,
      siteFlags: overview.site_flags,
      sitePopularity: sitePopularity,
      noticeAt: Object.fromEntries(
        Object.entries(overview.notices ?? {}).map(([id, notice]) => [id, notice.captured_at ?? null]),
      ),
    });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  // 模型分组索引：服务端按全量记录算好（lib/modelGroups），首屏只把默认模型的行与这些站的公告
  // 摘要下发给客户端，其余模型切到时按需拉（/api/model-rows）——列表页不再携带全站几千行；
  // ?model=<归一键> 可深链到指定模型（页面 Digest 仍用全量记录统计）
  const modelIndex = data ? buildModelIndex(data.records, modelOrder) : [];
  const requestedKey = typeof params.model === "string" ? params.model : null;
  const initialKey = modelIndex.find((group) => group.key === requestedKey)?.key ?? modelIndex[0]?.key ?? null;
  const initialRows = data && initialKey ? rowsOfGroup(data.records, initialKey) : [];
  const initialNotices = data ? subsetNotices(data.notices, initialRows) : {};

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
      {/* 风险提示只放这一页（用户 2026-10-13 定）：试水建议 + 榜单规则 + 消费免责，表前一段说清 */}
      {data && (
        <RiskNotice title={risk.title}>
          {risk.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </RiskNotice>
      )}
      {data && (
        <OverviewTable
          data={{ ...data, records: initialRows, notices: initialNotices }}
          modelIndex={modelIndex}
          initialKey={initialKey}
          rankingsIndex={rankingsIndex}
          siteHomepages={siteHomepages}
          siteRanking={siteRanking}
          sitePopularity={sitePopularity}
        />
      )}
    </div>
  );
}
