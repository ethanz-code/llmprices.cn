import Link from "next/link";
import { chartToneVar, rateLevel } from "@/lib/channelStatus";
import { formatTimeAgo } from "@/lib/format";
import { home } from "@/lib/copy";
import type { SummaryBucket } from "@/lib/types";

/** 静态可用率色块条：与详情页 StatusUptimeBars 同一套分桶与三档色（chartToneVar），
 *  纯展示不带悬停——外层卡片本身可点进详情看交互版；不足 2 桶（数据太少）不渲染。 */
export function UptimeStrip({ buckets }: { buckets: (SummaryBucket | null)[] }) {
  if (buckets.length < 2) return null;
  return (
    <span className="uptime-strip" aria-hidden>
      {buckets.map((bucket, index) => (
        <span
          key={index}
          className={`uptime-strip-slot${bucket ? "" : " is-empty"}`}
          style={bucket ? { background: chartToneVar[rateLevel(bucket.avg)] } : undefined}
        />
      ))}
    </span>
  );
}

/** 站点卡状态色：正常档半强度（大面积绿不抢眼），异常全色；阈值与详情页共用 */
function levelColor(level: ReturnType<typeof rateLevel>): string {
  return level === "ok"
    ? "color-mix(in srgb, var(--chart-ok) 55%, transparent)"
    : level === "warn"
      ? "var(--chart-warn)"
      : "var(--chart-down)";
}

export interface SiteCardProps {
  /** 站点 id（决定检测档案页地址与展示名） */
  id: string;
  /** 展示名（getSiteInfo 的结果，调用方解析好传入） */
  name: string;
  enabled: boolean;
  /** 最新时段平均正常率（0–100）；无检测记录/停用传 null，卡片显示 “—” */
  pct: number | null;
  /** 最近一次检测时刻（秒级时间戳）；无记录传 null */
  checkedAt?: number | null;
  /** 近 7 天时段分桶摘要（停用站传空数组，色块条自动不渲染） */
  buckets: (SummaryBucket | null)[];
}

/** 站点检测卡：首页站点墙与 /sites 全部站点页共用同一张卡（状态点 + 可用率 + 7 天色块 + 最近检测），
 *  点卡片进该站的检测档案页。排序规则由调用方决定（见 lib/siteRanking 的 orderSitesByQuality）。 */
export function SiteCard({ id, name, enabled, pct, checkedAt, buckets }: SiteCardProps) {
  const level = pct != null ? rateLevel(pct) : null;
  const stateText =
    pct != null
      ? `最新正常 ${pct}%`
      : enabled
        ? home.empty.siteNoCheckRecord
        : home.empty.siteDisabled;
  return (
    <Link
      href={`/overview/status/${encodeURIComponent(id)}`}
      className={`site-card${enabled ? "" : " site-card--off"}`}
      title={`${name} · ${stateText}`}
    >
      <span className="site-card-head">
        <span
          aria-hidden
          className="site-card-dot"
          style={{ background: level != null ? levelColor(level) : "var(--text-3)" }}
        />
        <span className="site-card-name">{name}</span>
        <span
          className="site-card-avg mono num"
          style={level ? { color: levelColor(level) } : undefined}
        >
          {pct != null ? `${pct}%` : "—"}
        </span>
      </span>
      <UptimeStrip buckets={buckets} />
      <span className="site-card-meta">
        {checkedAt != null
          ? `${formatTimeAgo(checkedAt)}检测`
          : enabled
            ? home.empty.siteNoCheckRecord
            : home.empty.siteDisabled}
      </span>
    </Link>
  );
}
