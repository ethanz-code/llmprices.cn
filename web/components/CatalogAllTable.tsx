"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { DataTable, type DColumn } from "./DataTable";
import { Empty, Input, Pick } from "./ui";
import { IconSearch } from "./icons";
import { RiskLink } from "./RiskLink";
import { ToneNum } from "./ToneTag";
import { VendorBadge } from "./CatalogTable";
import { catalogAllPageUrl, type CatalogAllPage } from "@/lib/catalogPage";
import { formatCount, formatIsoMinute, formatPrice, formatTokens, isFreePrice } from "@/lib/format";
import { useNarrow } from "@/lib/useNarrow";
import { vendorDisplay } from "@/lib/vendorNames";
import type { CatalogEntry } from "@/lib/types";

interface Row extends CatalogEntry {
  key: string;
}

/** 全量渠道价表：models.dev 所有厂商的带价模型，仅供浏览。
 *
 *  真分页：8000+ 条（整份约 8 MB）由后端按目录口径排序筛选后按页下发，页面只取当前页；
 *  搜索、厂商筛选、列排序、翻页都改 URL，服务端重新取数（分页之后前端排序只能排当页，没意义）。 */
export function CatalogAllTable({
  data,
  page,
  size,
  query,
  vendor,
  sortKey,
  dir,
}: {
  data: CatalogAllPage;
  page: number;
  size: number;
  query: string;
  vendor: string;
  sortKey: string | null;
  dir: "ascend" | "descend";
}) {
  const [keyword, setKeyword] = useState(query);
  // 手机（≤560px）：渠道并入模型列上下两行，价格一列，避免横滑藏住最后一列
  const phone = useNarrow(560);
  const router = useRouter();

  // 服务端回传的搜索词变化时同步输入框（点浏览器后退也能对上）
  useEffect(() => setKeyword(query), [query]);
  // 输入防抖：停顿 300ms 再改 URL（真分页下搜索走后端，即时性靠防抖换）
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (keyword === query) return;
    const timer = setTimeout(() => go({ q: keyword, page: 1 }), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword, query]);

  /** 改搜索/厂商/排序/分页参数 → 写进 URL，服务端重新取当页数据。 */
  function go(next: {
    page?: number;
    size?: number;
    q?: string;
    vendor?: string;
    sortKey?: string | null;
    dir?: "ascend" | "descend";
  }) {
    router.push(
      catalogAllPageUrl({
        page: next.page ?? page,
        size: next.size ?? size,
        q: next.q ?? query,
        vendor: next.vendor ?? vendor,
        sortKey: next.sortKey !== undefined ? next.sortKey : sortKey,
        dir: next.dir ?? dir,
      }),
      { scroll: false },
    );
  }

  const rows: Row[] = Object.entries(data.models).map(([key, entry]) => ({ ...entry, key }));
  const filtered = Boolean(query || vendor);

  const columns: DColumn<Row>[] = [
    {
      title: "渠道 / 厂商",
      dataIndex: "vendor",
      width: 190,
      render: (v: string, row: Row) => (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 550, whiteSpace: "nowrap" }}>
          <VendorBadge vendor={v} logo={row.logo} />
          {vendorDisplay(v)}
        </span>
      ),
    },
    {
      title: "模型",
      dataIndex: "model",
      width: 230,
      render: (v: string, row: Row) => (
        <span
          className="mono"
          title={row.name ? `${row.name}（${v}）` : v}
          style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {v}
        </span>
      ),
    },
    {
      title: (
        <>
          价格（输入/输出）
          <span className="thead-unit thead-unit-block">USD / 1M tokens</span>
        </>
      ),
      key: "list",
      align: "right",
      width: 180,
      sorter: (a, b) => (a.list?.input ?? 0) - (b.list?.input ?? 0),
      render: (_, row) =>
        isFreePrice(row.list) ? (
          <ToneNum tone="green">免费</ToneNum>
        ) : (
          <span className="mono num" style={{ fontWeight: 550 }}>
            ${formatPrice(row.list?.input)} / ${formatPrice(row.list?.output)}
          </span>
        ),
    },
    {
      title: (
        <>
          上下文（最大/输出）
          <span className="thead-unit thead-unit-block">tokens</span>
        </>
      ),
      key: "limit",
      align: "right",
      width: 180,
      mobileHide: true,
      sorter: (a, b) => (a.limit?.context ?? 0) - (b.limit?.context ?? 0),
      render: (_, row) => {
        const limit = row.limit;
        if (!limit?.context) return <span style={{ color: "var(--text-3)" }}>—</span>;
        const part = (value: number | undefined) => (value ? formatTokens(value) : "—");
        return (
          <span className="mono num">
            {formatTokens(limit.context)} / {part(limit.output)}
          </span>
        );
      },
    },
    {
      title: "模型简介",
      key: "description",
      mobileHide: true,
      render: (_, row) => {
        const text = row.description_zh || row.description;
        return text ? (
          <span
            title={text}
            style={{
              display: "inline-block",
              maxWidth: "100%",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              verticalAlign: "bottom",
              color: "var(--text-2)",
            }}
          >
            {text}
          </span>
        ) : (
          <span style={{ color: "var(--text-3)" }}>—</span>
        );
      },
    },
    {
      title: "发布",
      dataIndex: "release_date",
      width: 110,
      mobileHide: true,
      sorter: (a, b) => (a.release_date ?? "").localeCompare(b.release_date ?? ""),
      render: (v: string | null | undefined) =>
        v ? (
          <span className="mono num">{v}</span>
        ) : (
          <span style={{ color: "var(--text-3)" }}>—</span>
        ),
    },
    {
      title: "来源",
      dataIndex: "source_url",
      width: 60,
      mobileHide: true,
      render: (v: string) => (v ? <RiskLink href={v}>定价页</RiskLink> : <span style={{ color: "var(--text-3)" }}>—</span>),
    },
  ];

  // 手机列组：渠道（徽标+名称）与模型上下两行合并，价格列收窄，两列一屏放得下
  const displayColumns: DColumn<Row>[] = phone
    ? [
        {
          title: "渠道 / 模型",
          key: "vendor-model",
          width: 190,
          render: (_, row: Row) => (
            <span style={{ display: "inline-grid", gap: 2, justifyItems: "start" }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  color: "var(--text-2)",
                  whiteSpace: "nowrap",
                }}
              >
                <VendorBadge vendor={row.vendor} logo={row.logo} />
                {vendorDisplay(row.vendor)}
              </span>
              <span
                className="mono"
                title={row.name ? `${row.name}（${vendorDisplay(row.vendor)}）` : row.model}
                style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {row.model}
              </span>
            </span>
          ),
        },
        { ...columns[2], width: 160 },
      ]
    : columns;

  return (
    <div className="rise-in" style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <Input
          placeholder="搜索模型、名称或渠道"
          style={{ flex: "1 1 260px", maxWidth: "min(420px, 100%)" }}
          value={keyword}
          onChange={setKeyword}
          prefix={<IconSearch size={14} />}
        />
        <Pick
          value={vendor}
          onChange={(next) => go({ vendor: next, page: 1 })}
          style={{ width: 200, maxWidth: "100%" }}
          options={[{ value: "", label: "全部渠道" }, ...data.vendors.map((v) => ({ value: v, label: v }))]}
        />
      </div>
      <div className="panel" style={{ overflow: "hidden" }}>
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
          <span style={{ fontWeight: 550, fontSize: 15 }}>全量渠道价格</span>
          <span style={{ color: "var(--text-2)", fontSize: 13 }}>
            共 <span className="mono">{formatCount(data.total)}</span> 条
            {filtered && (
              <>
                （当前筛选 <span className="mono">{formatCount(data.filtered_total)}</span> 条）
              </>
            )}{" "}
            · <span className="mono">{data.vendors.length}</span> 个渠道 · 截至{" "}
            <span className="mono" title={data.generated_at_iso}>{formatIsoMinute(data.generated_at_iso)}</span> · 汇率{" "}
            <span className="mono">{data.usd_cny_rate}</span>（{data.rate_source}）
          </span>
        </div>
        <DataTable<Row>
          rowKey="key"
          columns={displayColumns}
          rows={rows}
          total={data.filtered_total}
          page={page}
          pageSize={size}
          onPageChange={(next) => go({ page: next })}
          onPageSizeChange={(next) => go({ size: next, page: 1 })}
          serverSort={sortKey ? { key: sortKey, dir } : null}
          onSortChange={(key, nextDir) => go({ sortKey: nextDir ? key : null, dir: nextDir ?? "ascend", page: 1 })}
          scrollX={1130}
          mobileScrollX={phone ? 360 : 560}
          dense
          empty={
            filtered ? (
              <Empty
                icon={<IconSearch size={18} />}
                title="没有匹配的渠道价"
                description="换个关键词或调整筛选条件再试试。"
              />
            ) : (
              <Empty
                icon={<IconSearch size={18} />}
                title="目录里还没有带价条目"
                description="等下一轮目录同步完成后，这里会列出各渠道的带价模型。"
              />
            )
          }
        />
      </div>
    </div>
  );
}
