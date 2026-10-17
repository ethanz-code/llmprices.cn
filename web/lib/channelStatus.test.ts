/** 非对话渠道过滤：生图/生视频渠道不并入状态列表，先钉住。 */
import { describe, expect, it } from "vitest";

import { buildMonitoredSets, buildSiteViews, cacheMetricText, channelDotsBySite } from "@/lib/channelStatus";

/** 造一条状态记录：items 里的渠道条目带 name + status。 */
function record(siteId: string, items: { name: string; status: string }[]) {
  return {
    site_id: siteId,
    captured_at: 1760000000,
    data: { items },
  };
}

describe("channelDotsBySite 非对话渠道过滤", () => {
  it("生图渠道（图像/生图/image 家族）不进列表", () => {
    const rows = channelDotsBySite([
      record("demo", [
        { name: "claude 满血", status: "up" },
        { name: "生图", status: "up" },
        { name: "grok生图", status: "down" },
        { name: "香蕉4k生图", status: "up" },
        { name: "image-4k", status: "up" },
        { name: "ImageGen", status: "up" },
        { name: "绘图增强", status: "up" },
      ]),
    ])["demo"];
    expect(rows.map((row) => row.name)).toEqual(["claude 满血"]);
  });

  it("生视频渠道：通用词（视频）与模型名（veo/sora/seedence）都滤掉", () => {
    const rows = channelDotsBySite([
      record("demo", [
        { name: "gemini视频", status: "up" },
        { name: "grok视频", status: "up" },
        { name: "veo3.1", status: "up" },
        { name: "sora-v3-pro", status: "down" },
        { name: "seedence官key", status: "up" },
        { name: "专用gemini", status: "up" },
        { name: "企业gpt（不降智）", status: "up" },
      ]),
    ])["demo"];
    expect(rows.map((row) => row.name)).toEqual(["专用gemini", "企业gpt（不降智）"]);
  });

  it("过宽词根不误伤文本模型（seed/wan 词根不在名单里）", () => {
    const rows = channelDotsBySite([
      record("demo", [
        { name: "doubao-seed-1.6", status: "up" },
        { name: "gpt-5", status: "up" },
      ]),
    ])["demo"];
    expect(rows.map((row) => row.name)).toEqual(["doubao-seed-1.6", "gpt-5"]);
  });
});

describe("channelDotsBySite 指标型条目（无状态词，用成功率表达）", () => {
  it("sub2api v2 监控形态：成功率嵌在 metrics 里的 0-1 小数归一为百分数", () => {
    const rows = channelDotsBySite([
      {
        site_id: "demo",
        captured_at: 1760000000,
        data: { items: [
          { platform: "openai", model: "gpt-5.6-sol", metrics: { success_rate: 1 } },
          { platform: "openai", model: "gpt-5.6-terra", metrics: { success_rate: 0.7527 } },
          { platform: "openai", model: "__other__", metrics: { success_rate: 0.5 } },
        ] },
      },
    ])["demo"];
    // __other__ 是汇总桶不是渠道；0.7527 → 75.27%（异常行排前）；1 → 100%
    expect(rows.map((row) => [row.name, row.status])).toEqual([
      ["gpt-5.6-terra", "75.27%"],
      ["gpt-5.6-sol", "100.00%"],
    ]);
    expect(rows[0].ok).toBe(false);
    expect(rows[1].ok).toBe(true);
  });

  it("无样本行跳过：成功率与错误率双零是没流量，不当 0% 异常", () => {
    const rows = channelDotsBySite([
      { site_id: "demo", captured_at: 1760000000, data: { items: [
        { platform: "openai", model: "gpt-5.6-sol", metrics: { success_rate: 0.87, error_rate: 0.13, ttft: { avg_ms: 16800 } } },
        { platform: "openai", model: "claude-opus-4-6", metrics: { success_rate: 0, error_rate: 0 } },
        { platform: "openai", model: "gpt-5.2", metrics: {} },
      ] } },
    ])["demo"];
    expect(rows.map((row) => [row.name, row.status])).toEqual([["gpt-5.6-sol", "87.00%"]]);
    // 24h 汇总同样归一为百分数；首字耗时取 metrics.ttft.avg_ms
    expect(rows[0].successRate24h).toBeCloseTo(87);
    expect(rows[0].dots[0].latency).toBe(16800);
  });

  it("顶层百分数形态（perf-metrics 系）照旧按百分数判定，不受归一影响", () => {
    const rows = channelDotsBySite([
      { site_id: "demo", captured_at: 1760000000, data: { items: [{ name: "claude", success_rate: 97 }] } },
    ])["demo"];
    expect(rows.map((row) => [row.name, row.status, row.ok])).toEqual([["claude", "97.00%", true]]);
  });
});

describe("channelDotsBySite 缓存读取/写入指标", () => {
  it("指标型站点（sub2api v2 监控）：metrics 里的读取/写入 token 数与 0-1 命中率归一为百分数", () => {
    const rows = channelDotsBySite([
      { site_id: "demo", captured_at: 1760000000, data: { items: [
        { platform: "openai", model: "gpt-5.6-sol", metrics: {
          success_rate: 0.87,
          cache_read_tokens: 1_280_000,
          cache_creation_tokens: 48_000,
          cache_rate: 0.8366,
        } },
      ] } },
    ])["demo"];
    const dot = rows[0].dots[0];
    expect(dot.cacheRead).toBe(1_280_000);
    expect(dot.cacheWrite).toBe(48_000);
    expect(dot.cacheRate).toBeCloseTo(83.66);
    // 行级同样带上，供不必逐点取用的展示
    expect(rows[0].cacheRead).toBe(1_280_000);
  });

  it("状态词型站点（1for channel-monitors）：顶层百分数命中率，无读写拆分", () => {
    const rows = channelDotsBySite([
      { site_id: "demo", captured_at: 1760000000, data: { items: [
        { id: 48, name: "ChatGPT-Plus", provider: "openai", primary_status: "degraded", cache_rate: 68.24 },
      ] } },
    ])["demo"];
    const dot = rows[0].dots[0];
    expect(dot.cacheRate).toBeCloseTo(68.24);
    expect(dot.cacheRead).toBeUndefined();
    expect(dot.cacheWrite).toBeUndefined();
  });

  it("站点未上报缓存指标时不凭空造值", () => {
    const rows = channelDotsBySite([
      record("demo", [{ name: "claude", status: "up" }]),
    ])["demo"];
    const dot = rows[0].dots[0];
    expect(dot.cacheRead).toBeUndefined();
    expect(dot.cacheWrite).toBeUndefined();
    expect(dot.cacheRate).toBeUndefined();
  });

  it("展示文本：报了非零读写就展示「读 X · 写 Y」，否则退回命中率", () => {
    expect(cacheMetricText({ status: "up", ok: true, cacheRead: 1_280_000, cacheWrite: 48_000, cacheRate: 84 }))
      .toBe("读 1.3M · 写 48k");
    // 只报读取没报写入时只展示读取
    expect(cacheMetricText({ status: "up", ok: true, cacheRead: 2000 })).toBe("读 2k");
    // token 数恒为 0 占位（2btocken 实测）时退回命中率
    expect(cacheMetricText({ status: "up", ok: true, cacheRead: 0, cacheWrite: 0, cacheRate: 68.24 }))
      .toBe("命中 68%");
    // 1for 只报命中率
    expect(cacheMetricText({ status: "deg" as string, ok: false, cacheRate: 92.5 })).toBe("命中 93%");
    expect(cacheMetricText({ status: "up", ok: true })).toBeNull();
    expect(cacheMetricText(undefined)).toBeNull();
  });
});

describe("buildMonitoredSets 渠道监测集", () => {
  it("模型名 ∪ 计价分组名都收，归一去空格忽略大小写", () => {
    const sets = buildMonitoredSets([
      { site_id: "demo", model: "Claude-Opus-5", metadata: { group: "满血CC Max分组" } },
      { site_id: "demo", model: "gpt-5.5", metadata: { group: null } },
      { site_id: "other", model: "m1" },
    ]);
    expect([...sets["demo"]].sort()).toEqual(["claude-opus-5", "gpt-5.5", "满血cc max分组"]);
    expect(sets["other"]).toEqual(new Set(["m1"]));
  });

  it("监控模型列表收进每站集合；siteIds 里的站即使没有价格行也建基线", () => {
    const sets = buildMonitoredSets(
      [{ site_id: "demo", model: "gpt-5.5", metadata: { group: "gpt pro" } }],
      ["claude-opus-5-5", "GPT-6-Sol"],
      ["demo", "no-price"],
    );
    expect([...sets["demo"]].sort()).toEqual(["claude-opus-5-5", "gpt pro", "gpt-5.5", "gpt-6-sol"]);
    expect([...sets["no-price"]].sort()).toEqual(["claude-opus-5-5", "gpt-6-sol"]);
  });
});

describe("buildSiteViews 监测范围过滤", () => {
  const items = [
    { name: "GPT Pro", status: "up" },
    { name: "gpt-5.5", status: "down" },
    { name: "福利gpt", status: "up" },
    { name: "科研组", status: "up" },
  ];
  const filteredNames = (records: ReturnType<typeof record>[], monitored: Parameters<typeof buildSiteViews>[1]) =>
    (buildSiteViews(records, monitored).channels["demo"] ?? []).map((row) => row.name);

  it("只保留对得上监测集的行（大小写/空格不敏感），异常行仍排前", () => {
    const monitored = buildMonitoredSets([
      { site_id: "demo", model: "gpt-5.5", metadata: { group: "gpt pro" } },
    ]);
    expect(filteredNames([record("demo", items)], monitored)).toEqual(["gpt-5.5", "GPT Pro"]);
  });

  it("零命中返回空：状态页全是非监测范围的名字时清空，而不是回退全量", () => {
    const monitored = buildMonitoredSets([
      { site_id: "demo", model: "aws-gpt", metadata: { group: "在售分组" } },
    ]);
    expect(filteredNames([record("demo", items)], monitored)).toEqual([]);
  });

  it("站方全站模型池：非监控列表的老模型滤掉，列表内精确同名保留（routekey 场景）", () => {
    const poolItems = [
      { name: "gemini-2.5-flash", status: "down" },
      { name: "gpt-4o", status: "down" },
      { name: "gpt-5.6-luna", status: "up" },
    ];
    const monitored = buildMonitoredSets([], ["gpt-5.6-luna"], ["demo"]);
    expect(filteredNames([record("demo", poolItems)], monitored)).toEqual(["gpt-5.6-luna"]);
  });

  it("严格归一匹配：站方变体名（日期版本尾、thinking 后缀）不做兼容，对不上就是空", () => {
    const poolItems = [
      { name: "gpt-5.6-luna-2026-07-09", status: "up" },
      { name: "claude-opus-5-5-thinking", status: "up" },
    ];
    const monitored = buildMonitoredSets([], ["gpt-5.6-luna", "claude-opus-5-5"], ["demo"]);
    expect(filteredNames([record("demo", poolItems)], monitored)).toEqual([]);
  });

  it("无监测集的站展示为空：不因缺过滤依据回退全量", () => {
    const monitored = buildMonitoredSets([
      { site_id: "other", model: "m1", metadata: { group: "g" } },
    ]);
    expect(filteredNames([record("demo", items)], monitored)).toEqual([]);
  });

  it("buildSiteViews 透传：可用率按时段只算过滤后的渠道", () => {
    // 监测范围只留 GPT Pro（好）= 100%
    const records = [record("demo", items)];
    const monitored = buildMonitoredSets([
      { site_id: "demo", model: "不在售模型", metadata: { group: "gpt pro" } },
    ]);
    const filtered = buildSiteViews(records, monitored).availability["demo"];
    expect(filtered.at(-1)?.pct).toBe(100);
  });
});
