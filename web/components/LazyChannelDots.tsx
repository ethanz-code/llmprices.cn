"use client";

import { useEffect, useRef, useState } from "react";
import { ChannelDotMatrix } from "./ChannelDotMatrix";
import type { ChannelDot } from "@/lib/channelStatus";

/** 渠道点阵懒加载：列表先渲染，行滚进视口（含 200px 预取余量）才去服务端取该行分组的点阵。
 *  这样列表页不背渠道这块重数据——完整历史本就在站点详情页，这里只为「一眼看健康度」补点阵。 */
export function LazyChannelDots({
  site,
  group,
  href,
}: {
  site: string;
  group?: string | null;
  href: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  // undefined=还没拉、null=拉了但没有、数组=有数据
  const [dots, setDots] = useState<ChannelDot[] | null | undefined>(undefined);

  useEffect(() => {
    if (visible || !group) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible, group]);

  useEffect(() => {
    if (!visible || !group) return;
    let alive = true;
    fetch(`/api/channel-dots?site=${encodeURIComponent(site)}&group=${encodeURIComponent(group)}`)
      .then((res) => res.json())
      .then((data: { dots?: ChannelDot[] | null }) => {
        if (alive) setDots(data?.dots ?? null);
      })
      .catch(() => {
        if (alive) setDots(null);
      });
    return () => {
      alive = false;
    };
  }, [visible, group, site]);

  if (!group) return <span style={{ color: "var(--text-3)" }}>—</span>;

  return (
    <span ref={ref} style={{ display: "inline-block", minWidth: 96, minHeight: 12 }}>
      {dots === undefined ? (
        // 占位条：与点阵高度相当，避免加载完成时表格跳动
        <span
          aria-hidden
          style={{
            display: "inline-block",
            width: 96,
            height: 12,
            borderRadius: 3,
            background: "color-mix(in srgb, var(--text) 8%, transparent)",
          }}
        />
      ) : (
        <ChannelDotMatrix dots={dots} name={group} href={href} />
      )}
    </span>
  );
}
