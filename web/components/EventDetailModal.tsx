"use client";

/** 事件详情弹窗：价格事件展示前后完整价格与采集信息，公告事件展示全文。 */

import { useEffect, useState } from "react";
import { Modal } from "./ui";
import { ToneTag } from "./ToneTag";
import { RiskLink } from "./RiskLink";
import { NoticeBody } from "./NoticeBody";
import { apiGet } from "@/lib/api";
import { noticeText } from "@/lib/events";
import { getSiteInfo, type SiteHomepages } from "@/lib/sites";
import {
  CACHE_PRICE_LABELS,
  cachePriceText,
  currencySymbol,
  eventMeta,
  formatPrice,
  formatTime,
  isNoticeEvent,
  recordStatusKey,
  statusMeta,
  tieredPriceText,
  toCnyPrice,
  type CachePriceField,
} from "@/lib/format";
import type { FeedEvent, NoticeEvent, PriceRecord } from "@/lib/types";

interface ChangeLike {
  current?: { input_price: number | null; output_price: number | null; unit?: string; metadata?: PriceRecord["metadata"] } | null;
  previous?: { input_price: number | null; output_price: number | null; unit?: string; metadata?: PriceRecord["metadata"] } | null;
}

/** 参与变化比对的价格字段：输入/输出价 + 缓存读/写价 + 计价单位/分组（后两者参与价格口径指纹）。 */
type PricedField = "input_price" | "output_price" | CachePriceField | "unit" | "group";

const PRICED_FIELDS = ["input_price", "output_price", "cache_read_price", "cache_create_price", "cache_create_1h_price", "unit", "group"] as const satisfies readonly PricedField[];

function pricedValue(record: PriceRecord, field: PricedField): string | number | null {
  if (field === "input_price" || field === "output_price") return record[field];
  if (field === "unit") return record.unit ?? null;
  return record.metadata?.[field] ?? null;
}

/** 前后记录都在时，列出价格口径上有差异的字段；任一侧缺记录（新增/下线）无从比对，返回空集。 */
function changedPriceFields(previous?: PriceRecord | null, current?: PriceRecord | null): Set<PricedField> {
  const changed = new Set<PricedField>();
  if (!previous || !current) return changed;
  for (const field of PRICED_FIELDS) {
    if (pricedValue(previous, field) !== pricedValue(current, field)) changed.add(field);
  }
  return changed;
}

/** 事件摘要（前后价格一行带出），卡片与详情弹窗共用。 */
export function describeChange(event: ChangeLike, rate?: number | null): string {
  const unit = event.current?.unit ?? event.previous?.unit ?? "";
  // 事件摘要统一按 RMB 展示：USD 价乘汇率折算，无法折算回落原币
  const converted = toCnyPrice(event.current?.input_price, unit, rate) !== null;
  const symbol = converted ? "¥" : currencySymbol(unit);
  const price = (record: ChangeLike["current"], field: "input_price" | "output_price") => {
    const tierText = tieredPriceText(record, field, rate);
    if (tierText) return tierText;
    const value = converted ? toCnyPrice(record?.[field], unit, rate) : record?.[field];
    return `${symbol}${formatPrice(value ?? null)}`;
  };
  const pair = (record: ChangeLike["current"]) =>
    record ? `${price(record, "input_price")} / ${price(record, "output_price")}` : null;
  const suffix = unit ? ` · ${converted ? "CNY/1M tokens（折算）" : unit}` : "";
  // 输入/输出没变而缓存价变了时，摘要在价对后面补上变化项（如"缓存读 ¥0.25 → ¥1"），一眼看出差异
  const cacheSummary = event.previous
    ? (Object.keys(CACHE_PRICE_LABELS) as CachePriceField[])
        .map((field) => {
          const before = cachePriceText(event.previous, field, rate);
          const after = cachePriceText(event.current, field, rate);
          return before === after ? null : `${CACHE_PRICE_LABELS[field]} ${before ?? "—"} → ${after ?? "—"}`;
        })
        .filter((segment): segment is string => segment !== null)
        .join("、")
    : "";
  const current = pair(event.current) ?? "无价格";
  const previous = pair(event.previous);
  if (!previous) return `新增 ${current}${suffix}`;
  return `${previous} → ${current}${cacheSummary ? ` · ${cacheSummary}` : ""}${suffix}`;
}

function Row({ label, highlight, children }: { label: string; highlight?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
      <span style={{ color: "var(--text-3)", fontSize: 12, flexShrink: 0, width: 64 }}>{label}</span>
      <span
        className="mono"
        style={{ color: highlight ? "var(--tone-red-text)" : "var(--text-1)", fontSize: 13, minWidth: 0, wordBreak: "break-all" }}
      >
        {children}
      </span>
    </div>
  );
}

/** 单条价格记录的完整信息：价格 + 采集来源等上下文。changes 是与另一侧记录比对出的变化字段，命中标红。 */
function RecordBlock({
  title,
  record,
  changes,
  rate,
  empty,
}: {
  title: string;
  record: PriceRecord | null | undefined;
  changes: Set<PricedField>;
  rate?: number | null;
  empty: string;
}) {
  if (!record) {
    return (
      <div style={{ display: "grid", gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-2)" }}>{title}</div>
        <div style={{ color: "var(--text-3)", fontSize: 13 }}>{empty}</div>
      </div>
    );
  }
  const unit = record.unit;
  const converted = toCnyPrice(record.input_price, unit, rate) !== null;
  const symbol = converted ? "¥" : currencySymbol(unit);
  const price = (field: "input_price" | "output_price") => {
    const tierText = tieredPriceText(record, field, rate);
    if (tierText) return tierText;
    const value = converted ? toCnyPrice(record[field], unit, rate) : record[field];
    return `${symbol}${formatPrice(value ?? null)}`;
  };
  const status = statusMeta(recordStatusKey(record));
  const group = record.metadata?.group;
  const confidence = record.metadata?.confidence;
  const notes = record.metadata?.notes;
  // 1h 写价极少有站点提供：本侧有值或本次有变化才出该行，其余两侧都省
  const show1hWrite = record.metadata?.cache_create_1h_price != null || changes.has("cache_create_1h_price");
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-2)" }}>{title}</div>
      <Row label="输入价" highlight={changes.has("input_price")}>
        {price("input_price")}
      </Row>
      <Row label="输出价" highlight={changes.has("output_price")}>
        {price("output_price")}
      </Row>
      <Row label="缓存读" highlight={changes.has("cache_read_price")}>
        {cachePriceText(record, "cache_read_price", rate) ?? "—"}
      </Row>
      <Row label="缓存写" highlight={changes.has("cache_create_price")}>
        {cachePriceText(record, "cache_create_price", rate) ?? "—"}
      </Row>
      {show1hWrite && (
        <Row label="缓存写(1h)" highlight={changes.has("cache_create_1h_price")}>
          {cachePriceText(record, "cache_create_1h_price", rate) ?? "—"}
        </Row>
      )}
      {unit && <Row label="计价单位" highlight={changes.has("unit")}>{unit}</Row>}
      <Row label="价格状态">
        <ToneTag tone={status.tone}>{status.label}</ToneTag>
      </Row>
      {group && <Row label="分组" highlight={changes.has("group")}>{group}</Row>}
      {typeof confidence === "number" && <Row label="置信度">{Math.round(confidence * 100)}%</Row>}
      {notes && <Row label="备注">{String(notes)}</Row>}
      <Row label="采集时间">{formatTime(record.captured_at)}</Row>
      <Row label="数据来源">
        <RiskLink href={record.source_url} variant="muted">
          查看原始页面
        </RiskLink>
      </Row>
    </div>
  );
}

/** 公告正文：事件流不再随列表下发正文（一份十几 KB，几十条就上兆），弹窗打开时按需取全文；
 *  取不到就退回列表摘要，不让弹窗空着。 */
function NoticeEventBody({ event }: { event: NoticeEvent }) {
  // 事件本身带了正文（别处构造的事件、老数据）就直接渲染，省一次往返
  const [content, setContent] = useState<string | null>(event.content ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (content !== null) return;
    let alive = true;
    apiGet<{ content: string | null }>(
      // 时间戳原样回传：后端按 站点 + 检出时间 定位这条事件
      `/api/notice-event?site_id=${encodeURIComponent(event.site_id)}&detected_at=${event.detected_at}`,
    )
      .then((data) => {
        if (!alive) return;
        if (data.content) setContent(data.content);
        else setFailed(true);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [content, event.site_id, event.detected_at]);

  const boxStyle: React.CSSProperties = {
    maxHeight: 360,
    overflowY: "auto",
    padding: 12,
    borderRadius: 10,
    background: "var(--panel-2)",
  };
  if (content !== null) return <NoticeBody content={content} style={boxStyle} />;
  return (
    <div style={boxStyle}>
      <p style={{ color: "var(--text-3)", fontSize: 12.5, margin: failed ? "0 0 8px" : 0 }}>
        {failed ? "公告原文没取到，先看摘要：" : "正在取公告原文…"}
      </p>
      {failed && <p style={{ margin: 0 }}>{noticeText(event)}</p>}
    </div>
  );
}

/** 详情弹窗：内容按事件类型区分；关闭后由 Modal 播完退出动画。 */
export function EventDetailModal({
  event,
  rate,
  onClose,
  siteHomepages,
}: {
  event: FeedEvent | null;
  /** 展示汇率（USD→CNY），价格折算用 */
  rate?: number | null;
  onClose: () => void;
  /** 站点首页覆盖表（管理台为站点配置的首页地址）：站名链接优先用它 */
  siteHomepages?: SiteHomepages;
}) {
  if (!event) return null;
  const meta = eventMeta(event.kind);
  // 公告事件没有价格行、拿不到来源地址；价格事件用最近一次的来源地址兜底官网
  const sourceUrl = isNoticeEvent(event) ? undefined : event.current?.source_url ?? event.previous?.source_url;
  const site = getSiteInfo(event.site_id, sourceUrl, siteHomepages);
  if (isNoticeEvent(event)) {
    return (
      <Modal open onClose={onClose} title="事件详情" width={520}>
        <div style={{ display: "grid", gap: 14 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <ToneTag tone={meta.tone}>{meta.label}</ToneTag>
            <RiskLink href={site.homepage} variant="site">
              {site.name || event.site_id}
            </RiskLink>
            <span className="mono" style={{ color: "var(--text-3)", fontSize: 12, marginLeft: "auto" }}>
              {formatTime(event.detected_at)}
            </span>
          </div>
          <NoticeEventBody event={event} />
        </div>
      </Modal>
    );
  }
  const changes = changedPriceFields(event.previous, event.current);
  return (
    <Modal open onClose={onClose} title="事件详情" width={520}>
      <div style={{ display: "grid", gap: 14 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <ToneTag tone={meta.tone}>{meta.label}</ToneTag>
          <RiskLink href={site.homepage} variant="site">
            {site.name || event.site_id}
          </RiskLink>
          <span className="mono" style={{ color: "var(--text-2)" }}>{event.model}</span>
          <span className="mono" style={{ color: "var(--text-3)", fontSize: 12, marginLeft: "auto" }}>
            {formatTime(event.detected_at)}
          </span>
        </div>
        <div className="mono" style={{ fontSize: 13, color: "var(--text-2)", padding: "8px 12px", borderRadius: 10, background: "var(--panel-2)" }}>
          {describeChange(event, rate)}
        </div>
        <div style={{ display: "grid", gap: 14 }}>
          <RecordBlock title="变化前" record={event.previous} changes={changes} rate={rate} empty="无前值（首次建档）" />
          <RecordBlock title="变化后" record={event.current} changes={changes} rate={rate} empty="无记录（模型可能已下线或未取到价）" />
        </div>
      </div>
    </Modal>
  );
}
