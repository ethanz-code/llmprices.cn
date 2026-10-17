import { apiGet } from "@/lib/api";
import { loadSiteChannelSummary } from "@/lib/statusData";
import { loadSitePopularity, type SitePopularityMap } from "@/lib/popularity";
import { buildSiteQualityFromOverview, orderSitesByQuality } from "@/lib/siteRanking";
import { getSiteInfo } from "@/lib/sites";
import { PageDigest } from "@/components/PageDigest";
import { PageHeader } from "@/components/PageHeader";
import { SiteAlert } from "@/components/SiteAlert";
import { SiteCard } from "@/components/SiteCard";
import { DajuNap } from "@/components/DajuArt";
import { JsonLd } from "@/components/JsonLd";
import { alerts, home, sitesPage } from "@/lib/copy";
import { formatCount } from "@/lib/format";
import { pageMetadata, siteOrigin } from "@/lib/seo";
import type { MetaData, OverviewData, SiteChannelSummary } from "@/lib/types";

export const dynamic = "force-dynamic";

export const metadata = pageMetadata(
  "检测中的站点",
  "全部检测站点的渠道可用率与最近检测时间一览，按综合情况排序；点开站点可进检测档案。",
  "/sites",
);

/** 全部站点页：首页「检测中的站点」区「查看全部」的落地页。
 *  卡片与排序规则和首页站点墙完全一致（components/SiteCard + lib/siteRanking），只这里是全集。
 *  概览（价格/配置/公告）拉取失败只影响排序口径，站点清单与检测数据照常展示。 */
export default async function SitesPage() {
  let meta: MetaData | null = null;
  let overview: OverviewData | null = null;
  let channelSummary: SiteChannelSummary = { sites: {} };
  let popularity: SitePopularityMap = {};
  let error: string | null = null;
  try {
    const [metaData, overviewData, summary, popularityData] = await Promise.all([
      apiGet<MetaData>("/api/meta"),
      apiGet<OverviewData>("/api/overview").catch(() => null),
      loadSiteChannelSummary().catch(() => ({ sites: {} })),
      loadSitePopularity(),
    ]);
    meta = metaData;
    overview = overviewData;
    channelSummary = summary;
    popularity = popularityData;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  const sites = (meta?.sites ?? []).map((site) => ({
    id: site.id,
    name: getSiteInfo(site.id, site.url).name,
    enabled: site.enabled,
  }));
  // 质量分装配与首页同一函数：概览缺失时为空表，排序退回名称序
  const quality = overview ? buildSiteQualityFromOverview(overview, channelSummary, popularity) : {};
  const orderedSites = orderSitesByQuality(sites, quality);
  const enabledCount = sites.filter((site) => site.enabled).length;

  const summarySites = channelSummary.sites;
  const origin = await siteOrigin();

  return (
    <div className="page">
      <PageHeader title={sitesPage.title} subtitle={sitesPage.sub} />
      {sites.length > 0 && (
        <PageDigest
          items={[
            { label: sitesPage.digest.sites, value: formatCount(sites.length) },
            { label: sitesPage.digest.enabled, value: formatCount(enabledCount) },
            { label: sitesPage.digest.disabled, value: formatCount(sites.length - enabledCount) },
          ]}
        />
      )}
      {error && <SiteAlert title={alerts.loadData.title} detail={error} fix={alerts.loadData.fix} />}
      {sites.length > 0 ? (
        <div className="site-grid">
          {orderedSites.map((site) => {
            const entry = summarySites[site.id];
            const pct = site.enabled && entry?.pct != null ? entry.pct : null;
            return (
              <SiteCard
                key={site.id}
                id={site.id}
                name={site.name}
                enabled={site.enabled}
                pct={pct}
                checkedAt={entry?.at ?? null}
                buckets={site.enabled ? (entry?.buckets ?? []) : []}
              />
            );
          })}
        </div>
      ) : (
        !error && (
          <div className="landing-empty">
            <DajuNap width={150} />
            <p>{home.empty.sites}</p>
          </div>
        )
      )}
      {/* 结构化数据：检测站点清单（名称 + 检测档案页地址），帮搜索引擎理解这页是一份站点目录 */}
      {sites.length > 0 && (
        <JsonLd
          data={{
            "@context": "https://schema.org",
            "@type": "ItemList",
            name: "检测中的中转站",
            numberOfItems: orderedSites.length,
            itemListElement: orderedSites.map((site, index) => ({
              "@type": "ListItem",
              position: index + 1,
              name: site.name,
              url: `${origin}/overview/status/${encodeURIComponent(site.id)}`,
            })),
          }}
        />
      )}
    </div>
  );
}
