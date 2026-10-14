"use client";

import Link from "next/link";
import { Alert } from "./ui";
import { ToneTag } from "./ToneTag";
import { getSiteInfo } from "@/lib/sites";
import { formatTime, statusMeta } from "@/lib/format";
import type { CollectAlert } from "@/lib/types";

/** 最多并排展示几个站点，其余折成「还有 N 个」——异常站多时不把首屏铺成一片告警色 */
const MAX_CHIPS = 6;

/**
 * 采集异常站点提示：价格表上方一行，说明「这几个站的价格可能停在上一轮」。
 * 清单只含站点与状态（原始报错只在管理台），点站名进它的检测档案核对细节。
 * 提示条本身走内容列宽：站名多了在条内换行，不学页面级通栏色带横穿内容区。
 */
export function CollectAlerts({ alerts }: { alerts: CollectAlert[] }) {
  if (alerts.length === 0) return null;
  const shown = alerts.slice(0, MAX_CHIPS);
  const rest = alerts.length - shown.length;

  return (
    <Alert
      tone="warn"
      className="rise-in collect-alerts"
      title={`有 ${alerts.length} 个站点本轮没更新价格，表里是它们上一轮的数据`}
    >
      <span className="collect-alert-chips">
        {shown.map((alert) => {
          const meta = statusMeta(alert.status);
          const name = getSiteInfo(alert.site_id).name || alert.site_id;
          const tip = [
            `查看 ${name} 的检测档案`,
            alert.checked_at ? `本轮检查：${formatTime(alert.checked_at)}` : null,
          ]
            .filter(Boolean)
            .join("\n");
          return (
            <Link
              key={alert.site_id}
              href={`/overview/status/${encodeURIComponent(alert.site_id)}`}
              className="collect-alert-chip"
              title={tip}
            >
              <span className="mono collect-alert-name">{name}</span>
              <ToneTag tone={meta.tone}>{meta.label}</ToneTag>
            </Link>
          );
        })}
        {rest > 0 && <span className="collect-alert-rest">还有 {rest} 个</span>}
      </span>
    </Alert>
  );
}
