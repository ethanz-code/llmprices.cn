/** 厂商定价页「全量渠道」视图的分页契约：接口 URL 与页面 URL 的拼法，服务端与客户端共用。

这份目录 8000+ 条、整份约 8 MB，原先整页下发再在浏览器里筛选排序；现在筛选、排序、分页
都在后端做（llm_price_monitor/catalog/all_page.py），页面只取当前页，参数留在 URL 里可分享。
*/

import { pageOffset, tableQueryString, type TableQuery } from "./tableParams";
import type { CatalogEntry } from "./types";

/** 每页条数：单条目约 1 KB，一页 100 条约 100 KB（原先整份 8 MB 是它的 80 倍）。 */
export const CATALOG_ALL_PAGE_SIZE = 100;

/** 可排序的列键（与后端 SORT_KEYS 白名单一致）：价格、上下文、发布日期。 */
export const CATALOG_ALL_SORT_KEYS = ["list", "limit", "release_date"] as const;

/** 全量渠道目录的分页响应（/api/catalog/all 带 limit/offset 时的形态）。
 *  不带任何参数时该接口仍返回整份文档（含 providers），老调用方的行为不变。 */
export interface CatalogAllPage {
  generated_at?: number;
  generated_at_iso: string;
  source?: string;
  source_url?: string;
  usd_cny_rate: number;
  rate_source: string;
  /** 本页条目：目录键 → 条目 */
  models: Record<string, CatalogEntry>;
  /** 目录里带价条目的总数（不受筛选影响，抬头「共 N 条」用它） */
  total: number;
  /** 当前筛选后的条数（分页器按它算页数） */
  filtered_total: number;
  /** 全部厂商名（按表格块序），筛选下拉用；不随筛选变化 */
  vendors: string[];
}

/** 服务端取数用的接口 URL：只取当前页（size 传 0 时只回计数与厂商清单）。 */
export function catalogAllApiUrl(query: TableQuery, vendor: string, size = query.size): string {
  const params = new URLSearchParams();
  params.set("limit", String(size));
  params.set("offset", String(pageOffset(query)));
  if (query.q) params.set("q", query.q);
  if (vendor) params.set("vendor", vendor);
  if (query.sortKey) {
    params.set("sort", query.sortKey);
    params.set("dir", query.dir);
  }
  return `/api/catalog/all?${params.toString()}`;
}

/** 客户端改筛选/排序/翻页时的页面 URL：view=all 与厂商筛选都留在地址里。 */
export function catalogAllPageUrl(next: {
  page: number;
  size: number;
  q: string;
  vendor: string;
  sortKey: string | null;
  dir: "ascend" | "descend";
}): string {
  const search = tableQueryString(
    { page: next.page, size: next.size, q: next.q, sortKey: next.sortKey, dir: next.dir },
    { defaultSize: CATALOG_ALL_PAGE_SIZE, extra: { view: "all", vendor: next.vendor } },
  );
  return search ? `/catalog?${search}` : "/catalog";
}
