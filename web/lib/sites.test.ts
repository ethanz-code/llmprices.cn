/** 站点信息解析：官网取「管理台配置的首页 > 内置映射 > 来源 URL 域名」三级后备。 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { getSiteInfo, loadSiteHomepages, loadSiteLinks } from "@/lib/sites";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getSiteInfo", () => {
  it("内置映射的站用映射里的名称与官网", () => {
    const info = getSiteInfo("cun");
    expect(info.name).toBe("CUN.AI");
    expect(info.homepage).toBe("https://www.cun.ai");
  });

  it("配置的首页优先于内置映射与来源域名", () => {
    const homepages = { cun: "https://cun.example.com/", "4aicode": "https://4aicode.com/" };
    expect(getSiteInfo("cun", undefined, homepages).homepage).toBe("https://cun.example.com/");
    // 非映射站配了首页：名称仍按 id，官网用配置值而不是来源域名
    const info = getSiteInfo("4aicode", "https://api.4aicode.com/api/billing/model-rates", homepages);
    expect(info.name).toBe("4aicode");
    expect(info.homepage).toBe("https://4aicode.com/");
  });

  it("没配置的站回退来源 URL 域名；无来源时官网为空串", () => {
    expect(getSiteInfo("4aicode", "https://api.4aicode.com/api/billing/model-rates").homepage).toBe(
      "https://api.4aicode.com",
    );
    expect(getSiteInfo("nobody").homepage).toBe("");
  });
});

describe("loadSiteHomepages", () => {
  it("取到覆盖表原样返回", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ homepages: { "4aicode": "https://4aicode.com/" } }), { status: 200 })),
    );
    await expect(loadSiteHomepages()).resolves.toEqual({ "4aicode": "https://4aicode.com/" });
  });

  it("接口失败退回空表，不抛错", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    await expect(loadSiteHomepages()).resolves.toEqual({});
  });
});

describe("loadSiteLinks", () => {
  it("一次拿到首页覆盖与全部站点的主域名后备", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              homepages: { h: "https://h.test/" },
              origins: { h: "https://h.test/", demo: "https://demo.test/" },
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(loadSiteLinks()).resolves.toEqual({
      homepages: { h: "https://h.test/" },
      origins: { h: "https://h.test/", demo: "https://demo.test/" },
    });
  });

  it("接口失败两张表都退回空表", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    await expect(loadSiteLinks()).resolves.toEqual({ homepages: {}, origins: {} });
  });
});
