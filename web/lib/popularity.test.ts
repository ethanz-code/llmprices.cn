/** 站点人气展示口径：平台展示名、每段一行格式与群人数行取舍。 */
import { describe, expect, it } from "vitest";

import { groupPlatformLabel, popularityBadge, type SitePopularity } from "@/lib/popularity";

describe("groupPlatformLabel", () => {
  it("已知平台给展示名，未知回退「交流群」", () => {
    expect(groupPlatformLabel("telegram")).toBe("Telegram");
    expect(groupPlatformLabel("qq")).toBe("QQ");
    expect(groupPlatformLabel("wechat")).toBe("微信");
    expect(groupPlatformLabel("discord")).toBe("Discord");
    expect(groupPlatformLabel("other")).toBe("交流群");
  });
});

describe("popularityBadge", () => {
  it("固定每段一行（不用 · 分隔），带「访问量/TG群/排名：」主语", () => {
    const full: SitePopularity = {
      groups: [{ type: "telegram", url: "https://t.me/a", label: "@a", members: 705, members_kind: "members" }],
      traffic: { monthly_visits: 134_700, rank: 461_591 },
    };
    expect(popularityBadge(full)?.lines).toEqual([
      "访问量：134.7k/月",
      "TG群：705 人",
      "排名：461.6k",
    ]);
    // 悬停逐条带来源与加群链接
    expect(popularityBadge(full)?.title).toContain("TG群：705 人，加群链接 https://t.me/a");
    expect(popularityBadge(full)?.title).toContain("访问量：每月约 134.7k（SimilarWeb");
    // 缺访问量：剩下的段照常显示
    expect(popularityBadge({ groups: full.groups, traffic: {} })?.lines).toEqual(["TG群：705 人"]);
    expect(popularityBadge({ groups: [], traffic: { rank: 969_713 } })?.lines).toEqual(["排名：969.7k"]);
    expect(popularityBadge({ groups: [], traffic: { monthly_visits: 134_700 } })?.lines).toEqual(["访问量：134.7k/月"]);
  });

  it("QQ/Discord 群有人数也各占一行，平台名做主语；只有链接的进悬停不占数字行", () => {
    const mixed: SitePopularity = {
      groups: [
        { type: "qq", url: "", label: "QQ 群 860119326", members: 1200 },
        { type: "discord", url: "https://discord.gg/x", label: "Discord", members: 340 },
        { type: "qq", url: "https://qm.qq.com/q/abc", label: "QQ 群" },
      ],
      traffic: { monthly_visits: 61_000 },
    };
    expect(popularityBadge(mixed)?.lines).toEqual([
      "访问量：61k/月",
      "QQ群：1.2k 人",
      "Discord：340 人",
    ]);
    // 悬停里能找到只有链接的 QQ 群
    expect(popularityBadge(mixed)?.title).toContain("QQ 群（QQ，无公开人数）");
  });

  it("Telegram 频道（subscribers）文案叫「TG频道」不是「群」", () => {
    const channel: SitePopularity = {
      groups: [{ type: "telegram", url: "https://t.me/a", label: "@a", members: 705, members_kind: "subscribers" }],
      traffic: {},
    };
    expect(popularityBadge(channel)?.lines).toEqual(["TG频道：705 人"]);
    expect(popularityBadge(channel)?.title).toContain("TG频道：705 人");
  });

  it("没有任何数据返回 null（不挂空徽标）", () => {
    expect(popularityBadge(null)).toBeNull();
    expect(popularityBadge(undefined)).toBeNull();
    expect(popularityBadge({ groups: [], traffic: {} })).toBeNull();
    // QQ 群没有人数：只有群链接时不挂徽标（徽标只展示可量化的人气）
    expect(popularityBadge({ groups: [{ type: "qq", url: "", label: "QQ 群 123456" }], traffic: {} })).toBeNull();
  });
});
