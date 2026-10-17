/** 模型数据页的模型分组口径：页面一次只展示一个模型，分组索引由服务端按全量记录算好随首屏下发，
 *  行数据按模型按需拉（web/app/api/model-rows）——列表页不再携带全站几千行（2026-10-16 载荷瘦身）。
 *
 *  索引、取行、接口过滤三处共用同一把归组键（canonicalModel + 订阅套餐统一键），不会分叉。 */
import { modelOrderCompare, type ModelOrderEntry } from "./modelOrder";
import { canonicalModel, hasUsablePrice } from "./priceRows";
import type { OverviewData, OverviewRecord } from "./types";

/** 订阅套餐行统一归并成一个条目：套餐名（几十个）不进模型下拉刷屏，点进这一项后的表里才逐行展开 */
export const SUBSCRIPTION_GROUP_KEY = "__subscription__";
export const SUBSCRIPTION_LABEL = "订阅套餐";

/** 订阅套餐行（metadata.plan）的套餐元数据；非套餐行为 null。 */
export function planOf(row: OverviewRecord) {
  return row.metadata?.plan ?? null;
}

/** 一个模型分组（只有元数据，行数据按 key 另取）：下拉展示与表头用它。 */
export interface ModelGroupMeta {
  /** 归一后的分组键：大小写/连字符等写法差异不产生重复的表 */
  key: string;
  /** 展示名：该组内出现次数最多的写法 */
  model: string;
  /** 其余写法（语义相同、字符不同），在表头标注 */
  aliases: string[];
  sites: number;
  priced: boolean;
}

/** 归组键：订阅套餐行归到统一键，其余按 canonicalModel。 */
export function groupKeyOf(row: OverviewRecord): string {
  return planOf(row) ? SUBSCRIPTION_GROUP_KEY : canonicalModel(row.model);
}

/** 按模型归组出索引：排序与页面历史口径逐字一致（目录排序，订阅套餐条目固定垫底）。 */
export function buildModelIndex(
  records: OverviewRecord[],
  modelOrder?: Record<string, ModelOrderEntry>,
): ModelGroupMeta[] {
  const byModel = new Map<string, { rows: OverviewRecord[]; names: Map<string, number> }>();
  let subscriptionRows: OverviewRecord[] | null = null;
  for (const row of records) {
    if (planOf(row)) {
      subscriptionRows = [...(subscriptionRows ?? []), row];
      continue;
    }
    const key = canonicalModel(row.model);
    let entry = byModel.get(key);
    if (!entry) {
      entry = { rows: [], names: new Map() };
      byModel.set(key, entry);
    }
    entry.rows.push(row);
    entry.names.set(row.model, (entry.names.get(row.model) ?? 0) + 1);
  }
  const groups: ModelGroupMeta[] = [...byModel.entries()].map(([key, entry]) => {
    // 展示名取出现最多的一种写法，其余写法记为别名
    const ranked = [...entry.names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return {
      key,
      model: ranked[0][0],
      aliases: ranked.slice(1).map(([name]) => name),
      sites: new Set(entry.rows.map((row) => row.site_id)).size,
      priced: entry.rows.some(hasUsablePrice),
    };
  });
  if (subscriptionRows) {
    groups.push({
      key: SUBSCRIPTION_GROUP_KEY,
      model: SUBSCRIPTION_LABEL,
      aliases: [],
      sites: new Set(subscriptionRows.map((row) => row.site_id)).size,
      priced: true,
    });
  }
  const compare = modelOrderCompare(modelOrder ?? {});
  groups.sort((a, b) => compare({ key: a.key, name: a.model }, { key: b.key, name: b.model }));
  groups.sort((a, b) => Number(a.key === SUBSCRIPTION_GROUP_KEY) - Number(b.key === SUBSCRIPTION_GROUP_KEY));
  return groups;
}

/** 取某个分组的行：与 buildModelIndex 同一把归组键。 */
export function rowsOfGroup(records: OverviewRecord[], key: string): OverviewRecord[] {
  return records.filter((row) => groupKeyOf(row) === key);
}

/** 公告只带当前行的站点：表里只有站点首行渲染公告，其余站的整份公告不必跟着走。 */
export function subsetNotices(
  notices: OverviewData["notices"],
  rows: OverviewRecord[],
): OverviewData["notices"] {
  if (!notices) return {};
  const sites = new Set(rows.map((row) => row.site_id));
  return Object.fromEntries(Object.entries(notices).filter(([siteId]) => sites.has(siteId)));
}
