"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DataTable, type DColumn } from "./DataTable";
import { Btn, Empty, Input } from "./ui";
import { IconChevronDown, IconSearch } from "./icons";
import { DajuSit } from "./DajuArt";
import { ToneTag } from "./ToneTag";
import { RiskLink } from "./RiskLink";
import { TermTip } from "./TermTip";
import { getSiteInfo, type SiteHomepages } from "@/lib/sites";
import { effectiveCnyCachePrice, effectiveCnyPrice, formatDiscount, formatIsoMinute, formatTime, noticeExcerpt, recordStatusKey, rowReason, statusMeta } from "@/lib/format";
import { planOf, type ModelGroupMeta } from "@/lib/modelGroups";
import { smartOrderRows } from "@/lib/priceRows";
import { rowRankScore, rowScore, type SiteRanking, type SiteScore } from "@/lib/siteRanking";
import { popularityBadge, popularitySortValue, type SitePopularityMap } from "@/lib/popularity";
import { modelOrderCompare, type ModelOrderEntry } from "@/lib/modelOrder";
import { rankingHit, type RankingHit } from "@/lib/rankings";
import { CollectAlerts } from "./CollectAlerts";
import { DiscountBars } from "./DiscountBars";
import { LazyChannelDots } from "./LazyChannelDots";
import { PriceCell, CachePriceCell } from "./PriceCell";
import type { OverviewData, OverviewRecord } from "@/lib/types";

/** 行唯一键：同站点同模型不再折叠，不同分组/单位各占一行。 */
const rowKeyOf = (row: OverviewRecord) =>
  `${row.site_id}:${row.model}:${row.unit}:${row.metadata?.group ?? ""}`;

/** 订阅套餐行（套餐制站）：行代表套餐本身，无 token 价，套餐信息跨列渲染。 */

/** 订阅套餐统一入口的模型分组键与展示名：所有套餐行归并到这一个下拉项里。 */

/** 定价页当前模型：只存在这台浏览器里，刷新后还停在上次选的那个。 */
const ACTIVE_MODEL_KEY = "overview-active-model";

/** 行综合分悬停明细：总分 + 五项分项（0–100）+ 数据滞后扣分。 */
function siteScoreTitle(score: SiteScore): string {
  const pct = (value: number) => Math.round(value * 100);
  return [
    `行综合分 ${score.score.toFixed(1)} / 100`,
    `价格 ${pct(score.price)} · 渠道稳定 ${pct(score.stability)} · 人气 ${pct(score.popularity)} · 配置完整 ${pct(score.completeness)} · 公告新鲜 ${pct(score.notice)}`,
    ...(score.stale > 0 ? [`数据滞后扣 ${score.stale.toFixed(1)} 分（价格是沿用旧快照的）`] : []),
    "价格在本模型内比（越低分越高），分项越接近 100 越好；人气看交流群人数、月访问量与全网排名。",
  ].join("\n");
}

export function OverviewTable({
  data,
  modelIndex,
  initialKey,
  rankingsIndex = {},
  siteHomepages,
  siteRanking,
  sitePopularity,
}: {
  data: OverviewData;
  /** 模型分组索引（服务端按全量记录算好，见 lib/modelGroups）：一次只展示一个模型，行数据按需拉 */
  modelIndex: ModelGroupMeta[];
  /** 首屏已随 data 带行的模型归一键（页面算好的默认模型） */
  initialKey: string | null;
  /** AA 榜单匹配索引：给当前选中模型挂排名徽标；榜单未生成时缺省不显示 */
  rankingsIndex?: Record<string, RankingHit>;
  /** 站点首页覆盖表（管理台为站点配置的首页地址）：站名链接优先用它 */
  siteHomepages?: SiteHomepages;
  /** 站点评分（服务端算好，见 lib/siteRanking）：行排序主键，缺省退回按价格排 */
  siteRanking?: SiteRanking;
  /** 站点人气（服务端读好，见 lib/popularity）：站点列挂月访问量/群人数徽标，缺省不显示 */
  sitePopularity?: SitePopularityMap;
}) {
  const records = data.records;
  const router = useRouter();
  // 站点价统一按 RMB 展示与排序：USD 记录乘厂商价快照汇率，CNY 记录原样；无汇率回落原币
  const rate = data.catalog.usd_cny_rate ?? null;

  // 按模型拆表：一个模型一张表；默认选中排序后的第一个，用户切换后写入本地，刷新还停在这个模型
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const [modelReady, setModelReady] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(ACTIVE_MODEL_KEY);
      if (saved) setActiveModel(saved);
    } catch {
      // 隐私模式读不到就维持默认，不影响看价格
    }
    setModelReady(true);
  }, []);

  // 分组索引由服务端按全量记录算好（lib/modelGroups.buildModelIndex）：首屏只随 data 带默认模型的行，
  // 其余模型切到时按需拉（web/app/api/model-rows），不再把全站几千行塞进首屏 HTML。
  const models = modelIndex;
  const [rowsByKey, setRowsByKey] = useState<Record<string, OverviewRecord[]>>(() =>
    initialKey ? { [initialKey]: data.records } : {},
  );
  const [notices, setNotices] = useState<NonNullable<OverviewData["notices"]>>(() => data.notices ?? {});
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  // 请求代号：setLoadingKey 会让本 effect 因依赖变化重跑，不能用 cleanup 的取消标记
  // 丢掉进行中的请求（那会把 loadingKey 永久留在原地，表一直停在「正在加载」）。
  // 只有最后一次发起的请求能落库，切走再切回会重新发起。
  const requestRef = useRef(0);

  const active = models.find((group) => group.key === activeModel) ?? models[0];
  const activeRows = active ? rowsByKey[active.key] ?? null : null;

  // 切到还没带行的模型：按需取该模型的行与公告（服务端按同一把归组键过滤）。失败停在失败态，
  // 由表内空态的重试按钮手动重来，避免依赖变化时无限重试
  useEffect(() => {
    const key = active?.key;
    if (!key || rowsByKey[key] || loadingKey === key || failedKey === key) return;
    const requestId = ++requestRef.current;
    setLoadingKey(key);
    fetch(`/api/model-rows?key=${encodeURIComponent(key)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{ rows: OverviewRecord[]; notices: OverviewData["notices"] }>;
      })
      .then((payload) => {
        if (requestRef.current !== requestId) return;
        setRowsByKey((prev) => ({ ...prev, [key]: payload.rows ?? [] }));
        setNotices((prev) => ({ ...prev, ...(payload.notices ?? {}) }));
      })
      .catch(() => {
        if (requestRef.current === requestId) setFailedKey(key);
      })
      .finally(() => {
        if (requestRef.current === requestId) setLoadingKey(null);
      });
  }, [active?.key, rowsByKey, loadingKey, failedKey]);

  // 切换模型：顺手把 ?model=<归一键> 写进 URL（首个模型清掉参数），刷新/分享/爬虫都落到同一张表
  const selectModel = useCallback(
    (key: string) => {
      setActiveModel(key);
      try {
        const url = new URL(window.location.href);
        if (key === models[0]?.key) url.searchParams.delete("model");
        else url.searchParams.set("model", key);
        window.history.replaceState(null, "", url.toString());
      } catch {
        // 环境不支持改 URL 只影响分享，不影响切换
      }
    },
    [models],
  );

  // 订阅套餐行跨列：从「输入价」列起合并 5 列（输入/输出/缓存/分组/折扣），一张卡讲清套餐；
  // 站点/人气列与渠道/公告列照常。模型列（表头即套餐名）不重复，卡里放价与额度等关键信息。
  const subscriptionSpan = useCallback(
    (row: OverviewRecord) => {
      const plan = planOf(row);
      if (!plan) return null;
      const fmtUsd = (value: number) => `$${value % 1 === 0 ? value.toFixed(0) : value.toFixed(2)}`;
      const parts: string[] = [];
      if (plan.quota_usd != null) parts.push(`${fmtUsd(plan.quota_usd)} 额度`);
      if (plan.validity) parts.push(plan.validity);
      const priceBit = plan.price_usd != null ? (
        <strong style={{ fontWeight: 600 }}>{fmtUsd(plan.price_usd)}</strong>
      ) : null;
      const perQuota = plan.per_quota_usd != null ? ` ≈ ${fmtUsd(plan.per_quota_usd)}/1U` : null;
      const scopes = plan.model_scopes?.length ? plan.model_scopes.join(" · ") : null;
      const listPrice =
        plan.list_price_usd != null && plan.price_usd != null && plan.list_price_usd > plan.price_usd
          ? <s title="站方未折价挂牌价">{fmtUsd(plan.list_price_usd)}</s>
          : null;
      return {
        startKey: "input_price",
        span: 5,
        render: () => (
          <span
            style={{ display: "inline-flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", fontSize: 13, lineHeight: 1.6 }}
            title={[plan.description, scopes ? `适用：${scopes}` : null].filter(Boolean).join("\n") || undefined}
          >
            <span style={{ display: "inline-flex", alignItems: "baseline", gap: 6, whiteSpace: "nowrap" }}>
              {priceBit}
              {listPrice}
            </span>
            {perQuota && (
              <span className="mono" style={{ color: "var(--text-2)", whiteSpace: "nowrap" }}>{perQuota}</span>
            )}
            <span style={{ color: "var(--text-3)", whiteSpace: "nowrap" }}>
              {parts.join(" · ")}
            </span>
            {scopes && (
              <span style={{ color: "var(--text-3)", fontSize: 12, whiteSpace: "nowrap" }}>{scopes}</span>
            )}
            <TermTip term="subscription_plan" />
          </span>
        ),
      };
    },
    [],
  );

  // 记住选择：所选模型仍在列表里才写回本地；已下架（记忆里是旧模型名）就清掉坏键并回到默认，
  // 免得每次进来先跳到一个不存在的模型再回落
  useEffect(() => {
    if (!modelReady || !activeModel) return;
    try {
      if (models.some((group) => group.key === activeModel)) {
        localStorage.setItem(ACTIVE_MODEL_KEY, activeModel);
      } else if (models.length > 0) {
        localStorage.removeItem(ACTIVE_MODEL_KEY);
        setActiveModel(null);
      }
    } catch {
      // 隐私模式读写失败只影响下次刷新，当前选择仍然有效
    }
  }, [activeModel, modelReady, models]);

  // 默认行序：行综合分（价格按本模型内归一 + 站点级渠道稳定/配置完整/公告新鲜 − 数据滞后扣分；
  // 见 lib/siteRanking）高者在前，同站或同分再按加权单价、折扣、抓取时间破平。
  // 点表头排序循环回"无排序"即回到此序。
  const parentRows = useMemo(
    () =>
      smartOrderRows(
        activeRows ?? [],
        // 数据滞后已并入行综合分（siteRanking.stalenessPenalty），这里不再重复扣，按纯加权单价破平
        () => 0,
        rate,
        (row) => rowRankScore(siteRanking, row),
      ),
    [activeRows, rate, siteRanking],
  );

  // 每站首行的行键：站点综合分与公告都只在首行展示——同站点多分组行贴的是同一个分/同一份公告，
  // 逐行重复只会制造噪音
  const firstRowKeys = useMemo(() => {
    const seenSites = new Set<string>();
    const keys = new Set<string>();
    for (const row of parentRows) {
      if (!seenSites.has(row.site_id)) {
        seenSites.add(row.site_id);
        keys.add(rowKeyOf(row));
      }
    }
    return keys;
  }, [parentRows]);

  const columns: DColumn<OverviewRecord>[] = [
    {
      title: (
        <>
          站点
          <TermTip term="site_score" />
        </>
      ),
      key: "site",
      dataIndex: "site_id",
      // 固定宽度贴住内容（站名+分），不设宽会在 fixed 布局里与公告列平分剩余空间、
      // 站名后面拖出一大段空白；富余宽度让公告列（文本）吸收，手机端由 mobileScrollX 回退
      width: 150,
      render: (v: string, row) => {
        const site = getSiteInfo(v, row.source_url, siteHomepages);
        // 状态列已去掉：确认/候选/推算价是常态不挂标签；需认证/无数据挂标签
        const statusKey = recordStatusKey(row);
        const showTag = statusKey === "auth_required" || statusKey === "unavailable";
        const meta = statusMeta(statusKey);
        const reason = rowReason(row);
        const tip = [reason, row.last_price_at != null ? `上次拿到数据：${formatTime(row.last_price_at)}` : null]
          .filter(Boolean)
          .join("\n") || undefined;
        // 行综合分只在每站首行显示：整表一次只展示一个模型，同站各分组行的分必然相同，
        // 逐行重复是噪音（与公告列同一套规则）
        const score =
          siteRanking && firstRowKeys.has(rowKeyOf(row)) ? rowScore(siteRanking, row) : null;
        return (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, maxWidth: "100%", flexWrap: "wrap" }}>
            <RiskLink href={site.homepage || row.source_url} variant="site" title={site.name}>
              {/* 列宽固定后长名靠省略号截断，完整名字走悬停提示 */}
              <span
                className="mono"
                style={{ display: "inline-block", maxWidth: 100, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", verticalAlign: "bottom" }}
              >
                {site.name}
              </span>
            </RiskLink>
            {score && (
              <span className="mono" title={siteScoreTitle(score)} style={{ fontSize: 11, color: "var(--text-3)" }}>
                {score.score.toFixed(1)}
              </span>
            )}
            {showTag && (
              <span title={tip}>
                <ToneTag tone={meta.tone}>{meta.label}</ToneTag>
              </span>
            )}
          </span>
        );
      },
      sorter: (a, b) => a.site_id.localeCompare(b.site_id),
    },
    {
      title: (
        <>
          人气<TermTip term="site_popularity" />
        </>
      ),
      key: "popularity",
      dataIndex: "site_id",
      // 每段一行竖排（用户 2026-10-14 定：不用 · 分隔，换行显示）——列宽只按最长一段给
      width: 130,
      mobileHide: true,
      // 每行都显示；排序键 = 人气摘要值
      sorter: (a, b) => popularitySortValue(sitePopularity?.[a.site_id]) - popularitySortValue(sitePopularity?.[b.site_id]),
      render: (v: string) => {
        const badge = popularityBadge(sitePopularity?.[v]);
        if (!badge) return <span style={{ color: "var(--text-3)", fontSize: 12.5 }}>—</span>;
        return (
          <span className="mono" title={badge.title} style={{ display: "grid", gap: 2, fontSize: 12.5, whiteSpace: "nowrap" }}>
            {badge.lines.map((line, index) => (
              <span key={`${index}:${line}`}>{line}</span>
            ))}
          </span>
        );
      },
    },
    {
      title: (
        <>
          输入价<TermTip term="input_price" />
          <span className="thead-unit thead-unit-block">CNY / 1M tokens</span>
        </>
      ),
      dataIndex: "input_price",
      align: "right",
      width: 120,
      sorter: (a, b) => (effectiveCnyPrice(a, "input_price", rate) ?? -1) - (effectiveCnyPrice(b, "input_price", rate) ?? -1),
      render: (_v: number | null, row) => <PriceCell row={row} field="input_price" rate={rate} />,
    },
    {
      title: (
        <>
          输出价<TermTip term="output_price" />
          <span className="thead-unit thead-unit-block">CNY / 1M tokens</span>
        </>
      ),
      dataIndex: "output_price",
      align: "right",
      width: 120,
      sorter: (a, b) => (effectiveCnyPrice(a, "output_price", rate) ?? -1) - (effectiveCnyPrice(b, "output_price", rate) ?? -1),
      render: (_v: number | null, row) => <PriceCell row={row} field="output_price" rate={rate} />,
    },
    {
      title: (
        <>
          缓存价<TermTip term="cache_price" />
          <span className="thead-unit thead-unit-block">CNY / 1M tokens</span>
        </>
      ),
      key: "cache_price",
      align: "right",
      width: 120,
      mobileHide: true,
      sorter: (a, b) =>
        (effectiveCnyCachePrice(a, "cache_read_price", rate) ?? -1) -
        (effectiveCnyCachePrice(b, "cache_read_price", rate) ?? -1),
      render: (_v: unknown, row) => <CachePriceCell row={row} rate={rate} />,
    },
    {
      title: "分组",
      key: "group",
      width: 110,
      mobileHide: true,
      render: (_v: unknown, row) => {
        const group = row.metadata?.group;
        return group ? (
          <span className="mono" style={{ fontSize: 12.5, color: "var(--text-2)" }}>
            {group}
          </span>
        ) : (
          <span style={{ color: "var(--text-3)" }}>—</span>
        );
      },
    },
    {
      title: (
        <>
          厂商价折扣
          <TermTip term="discount" />
        </>
      ),
      key: "discount",
      width: 150,
      mobileHide: true,
      sorter: (a, b) => (a.discount?.input ?? 9) - (b.discount?.input ?? 9),
      render: (_, row) => <DiscountBars discount={row.discount} />,
    },
    {
      title: (
        <>
          渠道
          <TermTip term="channels" />
        </>
      ),
      key: "channels",
      width: 200,
      mobileHide: true,
      render: (_v: unknown, row) => (
        <LazyChannelDots
          site={row.site_id}
          group={row.metadata?.group}
          href={`/overview/status/${encodeURIComponent(row.site_id)}`}
        />
      ),
    },
    {
      title: "公告",
      key: "notice",
      // 唯一不设宽的列：吸收全部剩余宽度（文本越宽越好读）；最多 2 行，悬停看更长摘要
      mobileHide: true,
      render: (_v: unknown, row) => {
        const notice = notices[row.site_id];
        if (!notice?.excerpt || !firstRowKeys.has(rowKeyOf(row))) return <span style={{ color: "var(--text-3)" }}>—</span>;
        const tip = [
          notice.excerpt,
          notice.captured_at ? `发布于 ${formatTime(notice.captured_at)}` : null,
        ]
          .filter(Boolean)
          .join("\n");
        return (
          <Link
            href={`/overview/status/${encodeURIComponent(row.site_id)}`}
            title={tip}
            style={{ color: "var(--text-2)" }}
          >
            <span
              style={{
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                whiteSpace: "normal",
                lineHeight: 1.55,
              }}
            >
              {noticeExcerpt(notice.excerpt, 2)}
            </span>
          </Link>
        );
      },
    },
  ];

  return (
    <>
      <CollectAlerts alerts={data.collect_alerts ?? []} />
      {models.length > 0 && <ModelPicker models={models} activeKey={active?.key} onSelect={selectModel} />}
      <div className="panel rise-in" style={{ overflow: "hidden" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
            padding: "14px 20px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 550, fontSize: 15 }}>
              {active ? <span className="mono">{active.model}</span> : "最新价格"}
            </span>
            {active && (() => {
              const hit = rankingHit(rankingsIndex, active.model);
              if (!hit) return null;
              return (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <span className="mono" style={{ fontSize: 12, color: "var(--text-3)" }}>
                    评测排名 #{hit.rank}
                    {hit.intelligence_index != null && ` · 综合评分 ${hit.intelligence_index}/100`}
                  </span>
                  <TermTip term="aa_rank" />
                </span>
              );
            })()}
          </span>
          {data.catalog.enabled && (
            <span style={{ color: "var(--text-2)", fontSize: 13 }}>
              数据时间 <span className="mono" title={data.catalog.generated_at_iso ?? undefined}>{formatIsoMinute(data.catalog.generated_at_iso)}</span> · 汇率{" "}
              <span className="mono">{data.catalog.usd_cny_rate ?? "—"}</span>
            </span>
          )}
        </div>
        <DataTable<OverviewRecord>
          rowKey={rowKeyOf}
          columns={columns}
          rows={parentRows}
          paginated
          scrollX={870}
          mobileScrollX={390}
          dense
          rowSpanOf={subscriptionSpan}
          onRowClick={(row) => router.push(`/overview/status/${encodeURIComponent(row.site_id)}`)}
          empty={
            activeRows === null ? (
              failedKey === active?.key ? (
                <Empty
                  icon={<DajuSit width={30} />}
                  title="这个模型的价格没加载出来"
                  description="网络或服务波动导致的，重试一下就好。"
                  action={<Btn onClick={() => setFailedKey(null)}>重试</Btn>}
                />
              ) : (
                <Empty
                  icon={<DajuSit width={30} />}
                  title="正在加载这个模型的价格…"
                  description="只拉当前要看的这张表，稍等一下。"
                />
              )
            ) : (
              <Empty
                icon={<DajuSit width={30} />}
                title="还没有价格数据"
                description="我们采完一轮数据后，这里就会展示各站点的最新价格。"
              />
            )
          }
        />
      </div>
    </>
  );
}

/** 模型选择下拉：可搜索、显示各模型的站点数；模型多时靠输入过滤，不再平铺一排 tab。 */
function ModelPicker({
  models,
  activeKey,
  onSelect,
}: {
  models: ModelGroupMeta[];
  activeKey?: string;
  onSelect: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const rootRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const active = models.find((group) => group.key === activeKey);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 打开时把选中项滚进可视区
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open]);

  const keyword = filter.trim().toLowerCase();
  const matched = keyword
    ? models.filter(
        (group) =>
          group.model.toLowerCase().includes(keyword) ||
          group.aliases.some((alias) => alias.toLowerCase().includes(keyword)),
      )
    : models;

  return (
    // rise-in 的 both 填充让本容器与下方 panel 同为层叠上下文，展开时必须抬高，否则菜单被表格盖住
    <div className="rise-in" style={{ marginBottom: 16, position: "relative", zIndex: open ? 70 : undefined }}>
    <span className="sel-wrap" ref={rootRef} style={{ width: 300, maxWidth: "100%" }}>
      <button
        type="button"
        className="sel pick-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {active ? (
          <span style={{ display: "inline-flex", alignItems: "baseline", gap: 8 }}>
            <span className="mono">{active.model}</span>
            <span style={{ color: "var(--text-3)", fontSize: 12 }}>{active.sites}</span>
          </span>
        ) : (
          "选择模型"
        )}
      </button>
      <IconChevronDown size={13} className={`chev${open ? " is-flip" : ""}`} />
      {open && (
        <div className="pick-menu" style={{ maxWidth: "min(360px, 90vw)" }} ref={menuRef} role="listbox">
          <div style={{ padding: "4px 4px 8px", marginBottom: 4 }}>
            <Input
              value={filter}
              onChange={setFilter}
              placeholder="搜索模型"
              prefix={<IconSearch size={13} />}
              style={{ width: "100%" }}
            />
          </div>
          {matched.length === 0 && (
            <span style={{ display: "block", padding: "8px 10px", color: "var(--text-3)", fontSize: 13 }}>
              没有匹配的模型
            </span>
          )}
          {matched.map((group) => (
            <button
              key={group.key}
              type="button"
              role="option"
              aria-selected={group.key === activeKey}
              data-active={group.key === activeKey}
              className={`pick-item${group.key === activeKey ? " on" : ""}`}
              title={group.aliases.length > 0 ? `合并了不同写法：${[group.model, ...group.aliases].join("、")}` : undefined}
              onClick={() => {
                onSelect(group.key);
                setOpen(false);
                setFilter("");
              }}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}
            >
              <span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                {group.model}
              </span>
              <span style={{ color: "var(--text-3)", fontSize: 12 }}>{group.sites}</span>
            </button>
          ))}
        </div>
      )}
    </span>
    </div>
  );
}
