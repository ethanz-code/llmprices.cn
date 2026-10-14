/** 站点人气展示口径：数字缩写、徽标取舍（访问量 > 群人数 > 排名）与明细文本。 */
import { describe, expect, it } from "vitest";

import { formatCompactCn, groupPlatformLabel, popularityBadge, popularityTip, type SitePopularity } from "@/lib/popularity";

describe("formatCompactCn", () => {
  it("万以下用千分位，万以上用「万」（百位以上取整）", () => {
    expect(formatCompactCn(950)).toBe("950");
    expect(formatCompactCn(9500)).toBe("9,500");
    expect(formatCompactCn(134_700)).toBe("13.5万");
    expect(formatCompactCn(1_200_000)).toBe("120万");
    expect(formatCompactCn(969_713)).toBe("97万");
  });
});

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
  it("优先月访问量，其次群人数，最后排名", () => {
    const full: SitePopularity = {
      groups: [{ type: "telegram", url: "https://t.me/a", label: "@a", members: 705, members_kind: "members" }],
      traffic: { monthly_visits: 134_700, rank: 461_591 },
    };
    expect(popularityBadge(full)?.text).toBe("13.5万/月");
    expect(popularityBadge(full)?.title).toContain("Telegram 群 705 人");
    expect(popularityBadge({ groups: full.groups, traffic: {} })?.text).toBe("群 705 人");
    expect(popularityBadge({ groups: [], traffic: { rank: 969_713 } })?.text).toBe("排名 97万");
  });

  it("Telegram 频道（subscribers）文案叫「频道」不是「群」", () => {
    const channel: SitePopularity = {
      groups: [{ type: "telegram", url: "https://t.me/a", label: "@a", members: 705, members_kind: "subscribers" }],
      traffic: {},
    };
    expect(popularityBadge(channel)?.text).toBe("频道 705 人");
    expect(popularityBadge(channel)?.title).toContain("Telegram 频道 705 人");
  });

  it("没有任何数据返回 null（不挂空徽标）", () => {
    expect(popularityBadge(null)).toBeNull();
    expect(popularityBadge(undefined)).toBeNull();
    expect(popularityBadge({ groups: [], traffic: {} })).toBeNull();
    // QQ 群没有人数：只有群链接时不挂徽标（徽标只展示可量化的人气）
    expect(popularityBadge({ groups: [{ type: "qq", url: "", label: "QQ 群 123456" }], traffic: {} })).toBeNull();
  });
});

describe("popularityTip", () => {
  it("逐行列出交流群（含人数）、访问量与排名", () => {
    const tip = popularityTip({
      groups: [
        { type: "telegram", url: "https://t.me/a", label: "@a", members: 705 },
        { type: "qq", url: "", label: "QQ 群 123456" },
      ],
      traffic: { monthly_visits: 134_700, rank: 461_591 },
    });
    expect(tip).toContain("交流群：@a（705 人）、QQ 群 123456");
    expect(tip).toContain("月访问量约 13.5万（第三方估算）");
    expect(tip).toContain("全网排名约 46.2万（Tranco 榜）");
  });

  it("没有可用数据返回空串（管理台不挂图标）", () => {
    expect(popularityTip(null)).toBe("");
    expect(popularityTip({ groups: [], traffic: {} })).toBe("");
  });
});
