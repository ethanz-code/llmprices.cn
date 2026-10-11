/** 非对话渠道过滤：生图/生视频渠道不并入状态列表，先钉住。 */
import { describe, expect, it } from "vitest";

import { buildMonitoredSets, buildSiteViews, channelDotsBySite } from "@/lib/channelStatus";

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

describe("buildMonitoredSets 在售监测集", () => {
  it("模型名 ∪ 计价分组名都收，归一去空格忽略大小写", () => {
    const sets = buildMonitoredSets([
      { site_id: "demo", model: "Claude-Opus-5", metadata: { group: "满血CC Max分组" } },
      { site_id: "demo", model: "gpt-5.5", metadata: { group: null } },
      { site_id: "other", model: "m1" },
    ]);
    expect([...sets["demo"]].sort()).toEqual(["claude-opus-5", "gpt-5.5", "满血cc max分组"]);
    expect(sets["other"]).toEqual(new Set(["m1"]));
  });
});

describe("channelDotsBySite 在售口径过滤", () => {
  const items = [
    { name: "GPT Pro", status: "up" },
    { name: "gpt-5.5", status: "down" },
    { name: "福利gpt", status: "up" },
    { name: "科研组", status: "up" },
  ];

  it("只保留对得上监测集的行（大小写/空格不敏感），异常行仍排前", () => {
    const monitored = buildMonitoredSets([
      { site_id: "demo", model: "gpt-5.5", metadata: { group: "gpt pro" } },
    ]);
    const rows = channelDotsBySite([record("demo", items)], monitored)["demo"];
    expect(rows.map((row) => row.name)).toEqual(["gpt-5.5", "GPT Pro"]);
  });

  it("零命中回退全量：状态页产品线与在售完全错开时不滤成白板", () => {
    const monitored = buildMonitoredSets([
      { site_id: "demo", model: "aws-gpt", metadata: { group: "在售分组" } },
    ]);
    const rows = channelDotsBySite([record("demo", items)], monitored)["demo"];
    expect([...rows.map((row) => row.name)].sort()).toEqual(items.map((item) => item.name).sort());
  });

  it("监测集缺失的站不受影响（按站隔离）", () => {
    const monitored = buildMonitoredSets([
      { site_id: "other", model: "m1", metadata: { group: "g" } },
    ]);
    const rows = channelDotsBySite([record("demo", items)], monitored)["demo"];
    expect([...rows.map((row) => row.name)].sort()).toEqual(items.map((item) => item.name).sort());
  });

  it("buildSiteViews 透传：可用率按时段只算过滤后的渠道", () => {
    // 全量口径四渠道三好 = 75%；在售只留 GPT Pro（好）= 100%
    const records = [record("demo", items)];
    const monitored = buildMonitoredSets([
      { site_id: "demo", model: "不在售模型", metadata: { group: "gpt pro" } },
    ]);
    const full = buildSiteViews(records).availability["demo"];
    const filtered = buildSiteViews(records, monitored).availability["demo"];
    expect(full.at(-1)?.pct).toBe(75);
    expect(filtered.at(-1)?.pct).toBe(100);
  });
});
