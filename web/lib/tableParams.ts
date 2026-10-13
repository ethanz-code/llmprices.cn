/** 列表页真分页的 URL 参数读写：服务端组件按 searchParams 取 limit/offset，
 *  客户端表组件按同一份参数改 URL 触发服务端重取。参数名与默认值集中在这里，避免两边写岔。 */

export const PAGE_SIZE_MAX = 500;

export interface TableQuery {
  /** 当前页（1 起） */
  page: number;
  /** 每页条数 */
  size: number;
  /** 搜索关键词（空串表示无筛选） */
  q: string;
  /** 排序字段（null 表示按后端自然顺序） */
  sortKey: string | null;
  dir: "ascend" | "descend";
}

type RawParams = Record<string, string | string[] | undefined>;

function one(params: RawParams, key: string): string | undefined {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/** 从 searchParams 解析表格分页参数；sort 只接受 sortKeys 白名单里的字段。 */
export function parseTableQuery(
  params: RawParams,
  options: { defaultSize: number; sortKeys?: readonly string[]; allowSearch?: boolean },
): TableQuery {
  const size = clampInt(one(params, "size"), options.defaultSize, 1, PAGE_SIZE_MAX);
  const page = clampInt(one(params, "page"), 1, 1, 1_000_000);
  const rawQ = options.allowSearch === false ? undefined : one(params, "q");
  const rawSort = one(params, "sort");
  const sortKey = rawSort && options.sortKeys?.includes(rawSort) ? rawSort : null;
  const dir = one(params, "dir") === "descend" ? "descend" : "ascend";
  return { page, size, q: rawQ?.trim() ?? "", sortKey, dir };
}

/** offset = (page-1)*size，供后端 limit/offset 用。 */
export function pageOffset(query: TableQuery): number {
  return (query.page - 1) * query.size;
}

/** 由分页参数拼回查询串（省略默认值与空值，URL 干净）；客户端改参数时用。 */
export function tableQueryString(next: Partial<TableQuery>, options: { defaultSize: number }): string {
  const params = new URLSearchParams();
  if (next.page && next.page > 1) params.set("page", String(next.page));
  if (next.size && next.size !== options.defaultSize) params.set("size", String(next.size));
  if (next.q) params.set("q", next.q);
  if (next.sortKey) {
    params.set("sort", next.sortKey);
    params.set("dir", next.dir === "descend" ? "descend" : "ascend");
  }
  return params.toString();
}
