import { apiGetOptional } from "@/lib/api";
import type { RankingsData } from "@/lib/types";
import { PageDigest } from "@/components/PageDigest";
import { SiteAlert } from "@/components/SiteAlert";
import { RankingsTable } from "@/components/RankingsTable";
import { alerts } from "@/lib/copy";
import { formatCount } from "@/lib/format";
import { pageMetadata } from "@/lib/seo";
import { pageOffset, parseTableQuery } from "@/lib/tableParams";

export const dynamic = "force-dynamic";

/** 榜单默认每页条数（前端与后端共用一个值，写在这里同步）。 */
export const RANKINGS_PAGE_SIZE = 100;

/** 可排序字段（前端列 dataIndex）；与后端 /api/rankings 的白名单一致。 */
const RANKINGS_SORT_KEYS = [
  "rank",
  "intelligence_index",
  "median_output_tokens_per_second",
  "latency_first_chunk_seconds",
] as const;

export const metadata = pageMetadata(
  "模型榜单",
  "模型智能指数榜单，先看模型能力档位，再对照各站价格挑性价比。",
  "/rankings",
);

export default async function RankingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = parseTableQuery(await searchParams, {
    defaultSize: RANKINGS_PAGE_SIZE,
    sortKeys: RANKINGS_SORT_KEYS,
  });
  const params = new URLSearchParams({
    limit: String(query.size),
    offset: String(pageOffset(query)),
  });
  if (query.q) params.set("q", query.q);
  if (query.sortKey) {
    params.set("sort", query.sortKey);
    params.set("dir", query.dir);
  }

  let data: RankingsData | null = null;
  let error: string | null = null;
  try {
    data = await apiGetOptional<RankingsData>(`/api/rankings?${params.toString()}`);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  return (
    <div className="page">
      <h1 className="sr-only">模型榜单</h1>
      {data && (
        <PageDigest
          items={[
            { label: "上榜模型", value: formatCount(data.total ?? data.models.length) },
            { label: "评测厂商", value: formatCount(data.creator_total ?? 0) },
          ]}
        />
      )}
      {error && (
        <SiteAlert title={alerts.rankings.title} detail={error} fix={alerts.rankings.fix} />
      )}
      {data && (
        <RankingsTable
          data={data}
          page={query.page}
          size={query.size}
          query={query.q}
          sortKey={query.sortKey}
          dir={query.dir}
          total={data.filtered_total ?? data.models.length}
        />
      )}
    </div>
  );
}
