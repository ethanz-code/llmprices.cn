/** 模型数据页的分组口径：索引在服务端算一次、行按 key 取（页面 / 接口 / 组件三处共用同一把键）。 */
import { describe, expect, it } from "vitest";

import {
  SUBSCRIPTION_GROUP_KEY,
  buildModelIndex,
  rowsOfGroup,
  subsetNotices,
} from "@/lib/modelGroups";
import type { OverviewRecord } from "@/lib/types";

function row(over: Partial<OverviewRecord>): OverviewRecord {
  return {
    site_id: "s1",
    model: "m",
    input_price: 1,
    output_price: 2,
    unit: "USD/1M tokens",
    price_status: "confirmed",
    requires_auth: false,
    source_url: "",
    captured_at: 0,
    discount: null,
    ...over,
  } as OverviewRecord;
}

describe("buildModelIndex / rowsOfGroup", () => {
  it("写法差异归一张表：展示名取出现最多的写法，其余记为别名", () => {
    const records = [
      row({ site_id: "a", model: "GLM-5.3" }),
      row({ site_id: "b", model: "GLM-5.3" }),
      row({ site_id: "c", model: "glm_5.3" }),
    ];
    const index = buildModelIndex(records);
    expect(index).toHaveLength(1);
    expect(index[0]).toMatchObject({ key: "glm5.3", model: "GLM-5.3", aliases: ["glm_5.3"], sites: 3 });
    // 取行用同一把键：别名写法也回同一张表
    expect(rowsOfGroup(records, "glm5.3")).toHaveLength(3);
    expect(rowsOfGroup(records, "别的模型")).toHaveLength(0);
  });

  it("订阅套餐行归并成一个条目、固定排最后", () => {
    const records = [
      row({ model: "GLM-5.3" }),
      row({ model: "订阅·月付", metadata: { plan: { price_usd: 20 } } }),
      row({ model: "订阅·季付", metadata: { plan: { price_usd: 50 } } }),
    ];
    const index = buildModelIndex(records);
    expect(index.at(-1)).toMatchObject({ key: SUBSCRIPTION_GROUP_KEY, model: "订阅套餐", sites: 1, priced: true });
    expect(rowsOfGroup(records, SUBSCRIPTION_GROUP_KEY)).toHaveLength(2);
  });

  it("公告只带当前行的站点", () => {
    const records = [row({ site_id: "a" }), row({ site_id: "b" })];
    const notices = { a: { excerpt: "甲" }, c: { excerpt: "丙" } };
    expect(Object.keys(subsetNotices(notices, rowsOfGroup(records, "m")) ?? {})).toEqual(["a"]);
    expect(subsetNotices(undefined, records)).toEqual({});
  });
});
