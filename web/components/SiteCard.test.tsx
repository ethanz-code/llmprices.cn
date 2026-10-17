/** 站点卡渲染冒烟：状态点 / 可用率 / 7 天色块条 / 最近检测 / 检测档案链接都在位，
 *  停用站走暗化样式（不引 jsdom，用 renderToStaticMarkup，与 Calculator.test.tsx 同款）。 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { SiteCard } from "@/components/SiteCard";
import type { UptimeBucket } from "@/lib/channelStatus";

const BUCKETS: (UptimeBucket | null)[] = [
  { start: 0, end: 60, count: 10, avg: 98, worst: 80, down: [] },
  null,
  { start: 120, end: 180, count: 8, avg: 45, worst: 0, down: ["x"] },
];

describe("SiteCard", () => {
  it("正常站：名称、可用率、色块条与最近检测时间齐全，链接指向检测档案", () => {
    const checkedAt = Date.now() / 1000 - 2 * 3600;
    const html = renderToStaticMarkup(
      <SiteCard id="demo-site" name="Demo 中转" enabled pct={98} checkedAt={checkedAt} buckets={BUCKETS} />,
    );
    expect(html).toContain('href="/overview/status/demo-site"');
    expect(html).toContain("Demo 中转");
    expect(html).toContain("98%");
    expect(html).toContain("最新正常 98%"); // 悬停提示
    expect(html).toContain("2 小时前检测");
    // 三个时段色块：两个有色 + 一个空档
    expect(html.match(/uptime-strip-slot/g)).toHaveLength(3);
    expect(html).toContain("is-empty");
    expect(html).not.toContain("site-card--off");
  });

  it("无检测记录：显示占位符与说明；停用站暗化且不动用检测数据", () => {
    const idle = renderToStaticMarkup(
      <SiteCard id="idle" name="Idle" enabled pct={null} checkedAt={null} buckets={[]} />,
    );
    expect(idle).toContain("暂无渠道检测记录");
    expect(idle).toContain("—");
    expect(idle).not.toContain("uptime-strip-slot"); // 色块不足 2 桶不渲染

    const off = renderToStaticMarkup(
      <SiteCard id="off" name="Off" enabled={false} pct={null} checkedAt={null} buckets={[]} />,
    );
    expect(off).toContain("site-card--off");
    expect(off).toContain("已停用");
  });
});
