"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DataTable, type DColumn } from "./DataTable";
import { Empty, Input } from "./ui";
import { IconChevronDown, IconSearch } from "./icons";
import { DajuSit } from "./DajuArt";
import { ToneTag } from "./ToneTag";
import { RiskLink } from "./RiskLink";
import { TermTip } from "./TermTip";
import { getSiteInfo, type SiteHomepages } from "@/lib/sites";
import { effectiveCnyCachePrice, effectiveCnyPrice, formatDiscount, formatIsoMinute, formatTime, noticeExcerpt, recordStatusKey, rowReason, statusMeta } from "@/lib/format";
import { canonicalModel, hasUsablePrice, smartOrderRows } from "@/lib/priceRows";
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
const planOf = (row: OverviewRecord) => row.metadata?.plan ?? null;

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

interface ModelGroup {
  /** 归一后的分组键：大小写/连字符等写法差异不产生重复的表 */
  key: string;
  /** 展示名：该组内出现次数最多的写法 */
  model: string;
  /** 其余写法（语义相同、字符不同），在表头标注 */
  aliases: string[];
  rows: OverviewRecord[];
  sites: number;
  priced: boolean;
}

export function OverviewTable({
  data,
  rankingsIndex = {},
  modelOrder = {},
  siteHomepages,
  siteRanking,
  sitePopularity,
}: {
  data: OverviewData;
  /** AA 榜单匹配索引：给当前选中模型挂排名徽标；榜单未生成时缺省不显示 */
  rankingsIndex?: Record<string, RankingHit>;
  /** 模型名归一键（canonicalModel）→ 目录排序依据（厂商序+发布日期）：模型下拉按
   *  「厂商分块+发布倒序」排的依据，与站点管理监控模型多选同一套（见 lib/modelOrder），
   *  页面服务端从 /api/catalog 提炼；缺省退化为按名称。 */
  modelOrder?: Record<string, ModelOrderEntry>;
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

  const models = useMemo<ModelGroup[]>(() => {
    const byModel = new Map<string, { rows: OverviewRecord[]; names: Map<string, number> }>();
    for (const row of records) {
      const key = canonicalModel(row.model);
      let entry = byModel.get(key);
      if (!entry) {
        entry = { rows: [], names: new Map() };
        byModel.set(key, entry);
      }
      entry.rows.push(row);
      entry.names.set(row.model, (entry.names.get(row.model) ?? 0) + 1);
    }
    const groups = [...byModel.entries()].map(([key, entry]) => {
      // 展示名取出现最多的一种写法，其余写法记为别名
      const ranked = [...entry.names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      return {
        key,
        model: ranked[0][0],
        aliases: ranked.slice(1).map(([name]) => name),
        rows: entry.rows,
        sites: new Set(entry.rows.map((row) => row.site_id)).size,
        priced: entry.rows.some(hasUsablePrice),
      };
    });
    // 目录口径排序（厂商分块+发布倒序，与站点管理监控模型多选同一套）：同厂商的模型
    // 挨在一起，目录没收录的模型（站点自有命名）垫底按名称；页面没传目录索引时退化为纯名称序
    const compare = modelOrderCompare(modelOrder);
    groups.sort((a, b) => compare({ key: a.key, name: a.model }, { key: b.key, name: b.model }));
    return groups;
  }, [records, modelOrder]);

  const active = models.find((group) => group.key === activeModel) ?? models[0];

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
  // 见 lib/siteRanking）高者在前，同站或同分再按综合价、折扣、抓取时间破平。
  // 点表头排序循环回"无排序"即回到此序。
  const parentRows = useMemo(
    () =>
      smartOrderRows(
        active?.rows ?? [],
        // 数据滞后已并入行综合分（siteRanking.stalenessPenalty），这里不再重复扣，按纯综合价破平
        () => 0,
        rate,
        (row) => rowRankScore(siteRanking, row),
      ),
    [active, rate, siteRanking],
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
      dataIndex: "site_id",
      // 固定宽度贴住内容（站名+分），不设宽会在 fixed 布局里与公告列平分剩余空间、
      // 站名后面拖出一大段空白；富余宽度让公告列（文本）吸收，手机端由 mobileScrollX 兜底
      width: 150,
      render: (v: string, row) => {
        const site = getSiteInfo(v, row.source_url, siteHomepages);
        // 状态列已去掉：确认/候选/规则价是常态不挂标签；需认证/无数据挂标签
        const statusKey = recordStatusKey(row);
        const showTag = statusKey === "auth_required" || statusKey === "unavailable";
        const meta = statusMeta(statusKey);
        const reason = rowReason(row);
        const tip = [reason, row.last_price_at != null ? `上次拿到数据：${formatTime(row.last_price_at)}` : null]
          .filter(Boolean)
          .join("\n") || undefined;
        // 行综合分只在每站首行显示：整表一次只展示一个模型，同站各分组行的分必然相同，
        // 逐行重复是噪音（与公告列同口径）
        const score =
          siteRanking && firstRowKeys.has(rowKeyOf(row)) ? rowScore(siteRanking, row) : null;
        return (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, maxWidth: "100%", flexWrap: "wrap" }}>
            <RiskLink href={site.homepage || row.source_url} variant="site" title={site.name}>
              {/* 列宽固定后长名靠省略号兜底，完整名字走悬停提示 */}
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
      dataIndex: "site_id",
      // 三段并存允许自然换行（用户 2026-10-14 定：可以换行，但不要单行被压缩截断）——
      // 不设死宽，给个合适的最小宽让多余空间给公告列
      width: 150,
      mobileHide: true,
      // 每行都显示（用户 2026-10-14 定：同站各分组行也要有，不要只挂首行）；排序键 = 人气摘要值
      sorter: (a, b) => popularitySortValue(sitePopularity?.[a.site_id]) - popularitySortValue(sitePopularity?.[b.site_id]),
      render: (v: string) => {
        const badge = popularityBadge(sitePopularity?.[v]);
        if (!badge) return <span style={{ color: "var(--text-3)", fontSize: 12.5 }}>—</span>;
        return (
          <span className="mono" title={badge.title} style={{ fontSize: 12.5, lineHeight: 1.5, whiteSpace: "normal", wordBreak: "break-word" }}>
            {badge.text}
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
        const notice = data.notices?.[row.site_id];
        if (!notice?.content || !firstRowKeys.has(rowKeyOf(row))) return <span style={{ color: "var(--text-3)" }}>—</span>;
        const tip = [
          noticeExcerpt(notice.content, 6),
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
              {noticeExcerpt(notice.content, 2)}
            </span>
          </Link>
        );
      },
    },
  ];

  return (
    <>
      <CollectAlerts alerts={data.collect_alerts ?? []} />
      {models.length > 0 && <ModelPicker models={models} activeKey={active?.key} onSelect={setActiveModel} />}
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
                    {hit.intelligence_index != null && ` · 智能指数 ${hit.intelligence_index}/100`}
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
            <Empty
              icon={<DajuSit width={30} />}
              title="还没有价格数据"
              description="我们采完一轮数据后，这里就会展示各站点的最新价格。"
            />
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
  models: ModelGroup[];
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
