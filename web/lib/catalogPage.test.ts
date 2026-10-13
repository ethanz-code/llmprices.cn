/** 全量渠道目录分页的 URL 契约：客户端写出去的 URL，服务端必须能解回同一份参数。
 *  写岔了的表现是「翻页丢筛选」「筛选没生效」，而且只在服务端渲染时才发现——所以这里两边都测。 */
import { describe, expect, it } from "vitest";

import { CATALOG_ALL_PAGE_SIZE, CATALOG_ALL_SORT_KEYS, catalogAllApiUrl, catalogAllPageUrl } from "@/lib/catalogPage";
import { parseTableQuery } from "@/lib/tableParams";

const base = { page: 1, size: CATALOG_ALL_PAGE_SIZE, q: "", sortKey: null, dir: "ascend" as const };

function paramsOf(url: string): Record<string, string> {
  const query = url.split("?")[1] ?? "";
  return Object.fromEntries(new URLSearchParams(query));
}

describe("catalogAllApiUrl", () => {
  it("默认只带 limit/offset，空筛选不写进 URL", () => {
    expect(catalogAllApiUrl(base, "")).toBe("/api/catalog/all?limit=100&offset=0");
  });

  it("翻页按 size 换算 offset", () => {
    expect(catalogAllApiUrl({ ...base, page: 3 }, "")).toContain("offset=200");
  });

  it("关键词、厂商、排序都带上（厂商名带空格要编码）", () => {
    const url = catalogAllApiUrl({ ...base, q: "glm", sortKey: "list", dir: "descend" }, "Zhipu AI");
    const params = paramsOf(url);
    expect(params.q).toBe("glm");
    expect(params.vendor).toBe("Zhipu AI");
    expect(params.sort).toBe("list");
    expect(params.dir).toBe("descend");
  });

  it("size=0 只取计数（官方定价视图拿总条数用，不下发明细）", () => {
    expect(catalogAllApiUrl(base, "", 0)).toBe("/api/catalog/all?limit=0&offset=0");
  });
});

describe("catalogAllPageUrl", () => {
  it("默认参数写回干净 URL，只留 view=all", () => {
    expect(catalogAllPageUrl({ ...base, q: "", vendor: "" })).toBe("/catalog?view=all");
  });

  it("服务端能解回同一份参数（视图、厂商、搜索、排序、页码）", () => {
    const url = catalogAllPageUrl({
      page: 4,
      size: 20,
      q: "glm",
      vendor: "Zhipu AI",
      sortKey: "list",
      dir: "descend",
    });
    const params = paramsOf(url);
    expect(params.view).toBe("all");
    expect(params.vendor).toBe("Zhipu AI");
    expect(parseTableQuery(params, { defaultSize: CATALOG_ALL_PAGE_SIZE, sortKeys: CATALOG_ALL_SORT_KEYS })).toEqual({
      page: 4,
      size: 20,
      q: "glm",
      sortKey: "list",
      dir: "descend",
    });
  });

  it("白名单外的排序键会被服务端丢掉，不会透传给后端", () => {
    const url = catalogAllPageUrl({ ...base, q: "", vendor: "", sortKey: "secret", dir: "ascend" });
    const parsed = parseTableQuery(paramsOf(url), { defaultSize: CATALOG_ALL_PAGE_SIZE, sortKeys: CATALOG_ALL_SORT_KEYS });
    expect(parsed.sortKey).toBeNull();
  });
});
