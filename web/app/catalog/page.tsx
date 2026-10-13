import { apiGetOptional } from "@/lib/api";
import type { CatalogData, RankingsData } from "@/lib/types";
import { buildRankingIndex } from "@/lib/rankings";
import { PageDigest } from "@/components/PageDigest";
import { SiteAlert } from "@/components/SiteAlert";
import { CatalogView } from "@/components/CatalogView";
import {
  CATALOG_ALL_PAGE_SIZE,
  CATALOG_ALL_SORT_KEYS,
  catalogAllApiUrl,
  type CatalogAllPage,
} from "@/lib/catalogPage";
import { alerts } from "@/lib/copy";
import { formatCount } from "@/lib/format";
import { pageMetadata } from "@/lib/seo";
import { paramValue, parseTableQuery } from "@/lib/tableParams";

export const dynamic = "force-dynamic";

export const metadata = pageMetadata(
  "厂商定价",
  "各家模型厂商的官方定价速查，官方价与全量渠道价并列对照，随官方页面同步更新。",
  "/catalog",
);

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const wantAll = paramValue(params, "view") === "all";
  const query = parseTableQuery(params, {
    defaultSize: CATALOG_ALL_PAGE_SIZE,
    sortKeys: CATALOG_ALL_SORT_KEYS,
  });
  const vendor = paramValue(params, "vendor")?.trim() ?? "";

  let official: CatalogData | null = null;
  let all: CatalogAllPage | null = null;
  let rankings: RankingsData | null = null;
  let error: string | null = null;
  try {
    // 全量渠道目录 8000+ 条（整份约 8 MB）：官方定价视图只要它的条数，用 limit=0 只取计数，
    // 明细只在「全量渠道」视图按页取——两个视图都不再整份下发。
    const allUrl = wantAll ? catalogAllApiUrl(query, vendor) : catalogAllApiUrl(query, "", 0);
    // 榜单用于给目录条目补 AA 排名徽标；拉不到只影响徽标，不阻塞目录
    [official, all, rankings] = await Promise.all([
      apiGetOptional<CatalogData>("/api/catalog"),
      apiGetOptional<CatalogAllPage>(allUrl),
      apiGetOptional<RankingsData>("/api/rankings").catch(() => null),
    ]);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const rankingsIndex = buildRankingIndex(rankings);

  return (
    <div className="page">
      <h1 className="sr-only">厂商定价</h1>
      {official && (
        <PageDigest
          items={[
            { label: "官方定价模型", value: formatCount(Object.keys(official.models).length) },
            ...(all ? [{ label: "全量渠道模型", value: formatCount(all.total) }] : []),
          ]}
        />
      )}
      {error && (
        <SiteAlert title={alerts.catalog.title} detail={error} fix={alerts.catalog.fix} />
      )}
      <CatalogView
        official={official}
        all={wantAll ? all : null}
        rankingsIndex={rankingsIndex}
        initialView={wantAll ? "all" : "official"}
        page={query.page}
        size={query.size}
        query={query.q}
        vendor={vendor}
        sortKey={query.sortKey}
        dir={query.dir}
      />
    </div>
  );
}
