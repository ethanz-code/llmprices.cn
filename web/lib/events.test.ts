/** 事件折叠规则：首页侧栏与事件追踪页共用，同站同模型同类 120s 内折一张卡、公告不折叠。 */
import { describe, expect, it } from "vitest";

import { foldEvents, noticeText } from "@/lib/events";
import type { EventRow, NoticeEvent } from "@/lib/types";

function priceEvent(over: Partial<EventRow>): EventRow {
  return { site_id: "s1", model: "m1", kind: "changed", detected_at: 1000, ...over };
}

function notice(over: Partial<NoticeEvent>): NoticeEvent {
  return { site_id: "s1", kind: "notice_changed", detected_at: 1000, content: "公告", ...over };
}

describe("foldEvents", () => {
  it("同站同模型同类 120s 内相邻事件折成一组", () => {
    const groups = foldEvents([
      priceEvent({ detected_at: 1000 }),
      priceEvent({ detected_at: 1100 }),
      priceEvent({ detected_at: 1180 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });

  it("跨 120s、不同模型/站点/类型不折叠；公告事件永不折叠", () => {
    const groups = foldEvents([
      priceEvent({ detected_at: 1000 }),
      priceEvent({ detected_at: 1201 }), // 超窗
      priceEvent({ model: "m2", detected_at: 1202 }),
      priceEvent({ site_id: "s2", detected_at: 1203 }),
      priceEvent({ kind: "recovered", detected_at: 1204 }),
      notice({ detected_at: 1205 }),
      notice({ detected_at: 1206, site_id: "s2" }),
    ]);
    expect(groups).toHaveLength(7);
  });
});

/** 列表侧的公告文本来源：后端只随列表下发摘要（excerpt），正文按需取；
 *  摘要缺失时要回落到前端摘要规则，两种来源渲染出来必须一致。 */
describe("noticeText", () => {
  it("有后端摘要时直接用摘要", () => {
    expect(noticeText({ excerpt: "后端摘要", content: "<p>很长的正文</p>" })).toBe("后端摘要");
  });

  it("没有摘要时回落到正文摘要规则", () => {
    expect(noticeText({ content: "<p>正文摘要</p>" })).toBe("正文摘要");
  });

  it("两者都缺时给空串，不抛错", () => {
    expect(noticeText({})).toBe("");
  });
});
