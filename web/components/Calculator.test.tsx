/** 花费计算器的两处接线与渲染冒烟：
 *  1) 取价函数——候选模型的四档单价到底取自目录/站点记录的哪个字段；
 *  2) 服务端渲染——四档单价、三个用量输入、四个 KPI 是否都在位（不引 jsdom，用 renderToStaticMarkup）。 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { Calculator, optionFromCatalog, optionFromRecord } from "@/components/Calculator";
import { EMPTY_STATE } from "@/lib/calculator";
import type { CatalogData, CatalogEntry, OverviewData, OverviewRecord } from "@/lib/types";

/** 目录条目：只填取价关心的字段，其余用不到 */
function entry(over: Partial<CatalogEntry>): CatalogEntry {
  return { found: true, model: "m", vendor: "v", currency: "USD", ...over } as CatalogEntry;
}

/** 站点价记录：只填取价关心的字段 */
function record(over: Partial<OverviewRecord>): OverviewRecord {
  return {
    site_id: "s",
    model: "m",
    input_price: null,
    output_price: null,
    unit: "USD/1M tokens",
    price_status: "confirmed",
    requires_auth: false,
    source_url: "",
    captured_at: 0,
    fingerprint: "",
    ...over,
  } as OverviewRecord;
}

describe("optionFromCatalog 取价接线", () => {
  it("海外条目四档各取 list.input/output 与 cache.read/write", () => {
    const opt = optionFromCatalog("k", entry({
      currency: "USD",
      list: { input: 3, output: 15 },
      cache: { read: 0.3, write: 3.75 },
    }));
    expect(opt.prices).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    expect(opt.currency).toBe("USD");
  });

  it("国内条目取人民币原价 list_cny / cache_cny，不做汇率换算", () => {
    const opt = optionFromCatalog("k", entry({
      region: "cn",
      currency: "CNY",
      list: { input: 999, output: 999 }, // 美元价不该被用到
      list_cny: { input: 2, output: 8 },
      cache: { read: 9, write: 9 },
      cache_cny: { read: 0.2, write: 2.5 },
    }));
    expect(opt.prices).toEqual({ input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 });
    expect(opt.currency).toBe("CNY");
  });

  it("缺缓存价留空，不编估算值", () => {
    const opt = optionFromCatalog("k", entry({ list: { input: 1, output: 2 } }));
    expect(opt.prices.cacheRead).toBeNull();
    expect(opt.prices.cacheWrite).toBeNull();
  });

  it("缓存写入价为 0（站点标免费）照原样带出，不擅自抹成空", () => {
    // 真实样例：国内条目 glm-5.3-flashx 的 cache_cny.write 就是 0
    const opt = optionFromCatalog("glm5.3flashx", entry({
      region: "cn",
      list_cny: { input: 2, output: 7 },
      cache_cny: { read: 0.57, write: 0 },
    }));
    expect(opt.prices).toEqual({ input: 2, output: 7, cacheRead: 0.57, cacheWrite: 0 });
  });
});

describe("optionFromRecord 取价接线", () => {
  it("缓存读/写价取自记录 metadata，币种沿用 unit", () => {
    const opt = optionFromRecord(record({
      model: "gpt-6.1-sol",
      input_price: 2,
      output_price: 10,
      unit: "USD/1M tokens",
      metadata: { group: "默认", cache_read_price: 0.1, cache_create_price: 2.5 },
    }));
    expect(opt.prices).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
    expect(opt.currency).toBe("USD");
    // 分组进 value/sub，保证同模型同分组各占一项
    expect(opt.value).toBe("gpt-6.1-sol:默认");
  });

  it("站点没给缓存价时留空", () => {
    const opt = optionFromRecord(record({ input_price: 1, output_price: 2 }));
    expect(opt.prices.cacheRead).toBeNull();
    expect(opt.prices.cacheWrite).toBeNull();
  });
});

const catalog = {
  generated_at_iso: "2026-10-12T00:00:00+0800",
  source: "models.dev",
  usd_cny_rate: 7.1,
  rate_source: "test",
  models: {
    "claude-sonnet": entry({
      name: "Claude Sonnet",
      vendor: "Anthropic",
      list: { input: 3, output: 15 },
      cache: { read: 0.3, write: 3.75 },
    }),
  },
} as unknown as CatalogData;

const overview = {
  records: [record({
    site_id: "302",
    model: "gpt-6.1-sol",
    input_price: 2,
    output_price: 10,
    metadata: { cache_read_price: 0.1, cache_create_price: 2.5 },
  })],
  catalog: { enabled: true },
} as unknown as OverviewData;

describe("Calculator 渲染冒烟", () => {
  it("四档单价、三个用量输入、默认口径 96/2 都在位", () => {
    const html = renderToStaticMarkup(
      <Calculator catalog={catalog} overview={overview} initial={EMPTY_STATE} />,
    );
    for (const label of ["输入", "输出", "缓存读取", "缓存写入", "总用量", "缓存命中率", "输出占比"]) {
      expect(html).toContain(label);
    }
    // 默认口径直接落在两个输入框上：命中率 96%、输出占比 2%
    expect(html).toContain('value="96"');
    expect(html).toContain('value="2"');
    // 目录候选的挂牌价（$3 / $15）说明取价函数跑通
    expect(html).toContain("$3 / $15");
  });

  it("带浮点噪声的单价渲染成短小数", () => {
    const html = renderToStaticMarkup(
      <Calculator
        catalog={catalog}
        overview={overview}
        initial={{
          ...EMPTY_STATE,
          prices: {
            input: 0.5249999999999999,
            output: 14.399999999999999,
            cacheRead: 0.38457142857142856,
            cacheWrite: null,
          },
        }}
      />,
    );
    expect(html).toContain('value="0.525"');
    expect(html).toContain('value="14.4"');
    expect(html).toContain('value="0.384571"');
  });

  it("两个数据源都缺失时不抛错，落空态", () => {
    const html = renderToStaticMarkup(
      <Calculator catalog={null} overview={null} initial={EMPTY_STATE} />,
    );
    expect(html).toContain("花费结果");
  });
});
