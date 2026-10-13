/** 真分页 URL 参数口径单测：解析（钳位/白名单）与回写（省略默认值与空值）两边必须一致，
 *  写岔了就会出现「翻页丢筛选」或「URL 里挂一堆废话参数」。 */
import { describe, expect, it } from "vitest";

import { PAGE_SIZE_MAX, pageOffset, parseTableQuery, tableQueryString } from "@/lib/tableParams";

const SORT_KEYS = ["rank", "intelligence_index"] as const;

describe("parseTableQuery", () => {
  it("缺省值：第 1 页、默认每页条数、无搜索无排序、升序", () => {
    const query = parseTableQuery({}, { defaultSize: 100, sortKeys: SORT_KEYS });
    expect(query).toEqual({ page: 1, size: 100, q: "", sortKey: null, dir: "ascend" });
  });

  it("非法与越界值一律钳回合法区间", () => {
    expect(parseTableQuery({ page: "0" }, { defaultSize: 100 }).page).toBe(1);
    expect(parseTableQuery({ page: "-3" }, { defaultSize: 100 }).page).toBe(1);
    expect(parseTableQuery({ page: "abc" }, { defaultSize: 100 }).page).toBe(1);
    // 小数向下取整，不产生半页偏移
    expect(parseTableQuery({ page: "2.9" }, { defaultSize: 100 }).page).toBe(2);
    expect(parseTableQuery({ size: "9999" }, { defaultSize: 100 }).size).toBe(PAGE_SIZE_MAX);
    expect(parseTableQuery({ size: "0" }, { defaultSize: 100 }).size).toBe(1);
  });

  it("数组参数取第一个值，搜索词去空白", () => {
    const query = parseTableQuery({ q: ["  glm  ", "ignored"], page: ["3", "9"] }, { defaultSize: 35 });
    expect(query.q).toBe("glm");
    expect(query.page).toBe(3);
  });

  it("sort 只认白名单，否则当没排序；dir 只认 descend", () => {
    const ok = parseTableQuery({ sort: "rank", dir: "descend" }, { defaultSize: 100, sortKeys: SORT_KEYS });
    expect([ok.sortKey, ok.dir]).toEqual(["rank", "descend"]);
    // 不在白名单的字段丢弃（避免把任意字段透传给后端排序）
    expect(parseTableQuery({ sort: "price" }, { defaultSize: 100, sortKeys: SORT_KEYS }).sortKey).toBeNull();
    expect(parseTableQuery({ sort: "rank", dir: "up" }, { defaultSize: 100, sortKeys: SORT_KEYS }).dir).toBe("ascend");
  });

  it("allowSearch=false 的表格忽略 q", () => {
    expect(parseTableQuery({ q: "glm" }, { defaultSize: 100, allowSearch: false }).q).toBe("");
  });
});

describe("pageOffset", () => {
  it("offset = (page-1) × size", () => {
    expect(pageOffset({ page: 1, size: 100, q: "", sortKey: null, dir: "ascend" })).toBe(0);
    expect(pageOffset({ page: 3, size: 35, q: "", sortKey: null, dir: "ascend" })).toBe(70);
  });
});

describe("tableQueryString", () => {
  it("省略默认值与空值，URL 保持干净", () => {
    expect(tableQueryString({ page: 1, size: 100 }, { defaultSize: 100 })).toBe("");
    expect(tableQueryString({}, { defaultSize: 100 })).toBe("");
  });

  it("页码 > 1 与改过的每页条数才写进参数", () => {
    const search = tableQueryString({ page: 4, size: 50 }, { defaultSize: 100 });
    expect(search).toBe("page=4&size=50");
  });

  it("搜索与排序一起带上，排序必带 dir", () => {
    const search = tableQueryString(
      { page: 1, size: 100, q: "glm 4.6", sortKey: "rank", dir: "descend" },
      { defaultSize: 100 },
    );
    const params = new URLSearchParams(search);
    expect(params.get("q")).toBe("glm 4.6");
    expect(params.get("sort")).toBe("rank");
    expect(params.get("dir")).toBe("descend");
  });

  it("往返一致：写出去的参数再解析回来是同一份查询", () => {
    const next = { page: 7, size: 50, q: "deepseek", sortKey: "intelligence_index", dir: "descend" as const };
    const back = parseTableQuery(
      Object.fromEntries(new URLSearchParams(tableQueryString(next, { defaultSize: 100 }))),
      { defaultSize: 100, sortKeys: SORT_KEYS },
    );
    expect(back).toEqual(next);
  });
});
