"use client";

/** 站点人气管理：各站交流群/访问量/排名一览 + 上次取数时间 + 手动补采。
 *  数据来自 /api/sites/popularity/admin（含未启用站，选站要用）；两个按钮都提交
 *  collect-popularity 任务并轮询到结束：「立即补采」只查还有数据要补的站，
 *  「全量刷新」无视复查期逐站重查。列表顺序（待补在前）与整轮采集顺序一致；
 *  状态标签可分「全部/待补/正常/无数据」筛选，标签上直接带数量。
 *  每行的「趋势」按钮打开该站的人气趋势图（后端逐轮记点，详情页同图）。 */

import { useCallback, useEffect, useState } from "react";
import { DataTable, type DColumn } from "./DataTable";
import { Btn, LoadingRows, Modal, Seg, toast } from "./ui";
import { apiSend, errorText } from "@/lib/api";
import { getSiteInfo } from "@/lib/sites";
import { formatTime } from "@/lib/format";
import { groupKindLabel, loadSitePopularityHistory, rankSourceLabel, type PopularityPoint, type SiteGroup } from "@/lib/popularity";
import { PopularityTrendChart } from "./PopularityTrendChart";
import { formatCompact } from "@/lib/format";
import { IconUsers } from "./icons";
import { DajuSit } from "./DajuArt";

interface PopularityRow {
  site_id: string;
  enabled: boolean;
  groups: SiteGroup[];
  monthly_visits?: number | null;
  visits_source?: string | null;
  rank?: number | null;
  rank_source?: string | null;
  checked_at?: number | null;
  needs_query: boolean;
  no_data: boolean;
}

interface PopularityAdminData {
  rows: PopularityRow[];
  pending: number;
  total: number;
}

/** 状态筛选：全部 / 待补 / 正常 / 无数据。 */
type StatusFilter = "all" | "pending" | "normal" | "no_data";

/** 行状态口径：状态标签与筛选标签共用，避免两处判定漂移。 */
function rowStatus(row: PopularityRow): Exclude<StatusFilter, "all"> {
  if (row.needs_query) return "pending";
  if (row.no_data) return "no_data";
  return "normal";
}

/** 采集时间分档文案：刚采/几天前/一周以上/还没采过。 */
function freshnessText(checkedAt: number | null | undefined): string {
  if (!checkedAt) return "还没采过";
  const days = (Date.now() / 1000 - checkedAt) / 86_400;
  if (days < 1) return "今天";
  if (days < 7) return `${Math.round(days)} 天前`;
  return "超过一周";
}

export function AdminPopularity() {
  const [data, setData] = useState<PopularityAdminData | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // 状态筛选：清扫待补和数据缺口时先切到对应视图，比在全部里翻找省事
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  // 趋势弹窗：打开时按需拉该站的点（列表接口不带序列，避免整表膨胀）
  const [trendSite, setTrendSite] = useState<string | null>(null);
  const [trendPoints, setTrendPoints] = useState<PopularityPoint[] | null>(null);

  async function openTrend(siteId: string) {
    setTrendSite(siteId);
    setTrendPoints(null);
    try {
      setTrendPoints(await loadSitePopularityHistory(siteId));
    } catch {
      setTrendPoints([]);
    }
  }

  const reload = useCallback(() => {
    apiSend<PopularityAdminData>("/api/sites/popularity/admin", "GET")
      .then(setData)
      .catch(() => setData({ rows: [], pending: 0, total: 0 }));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function refresh(force: boolean) {
    setRefreshing(true);
    try {
      const res = await apiSend<{ task_id: string }>("/api/collect/popularity", "POST", { force });
      toast(force ? "已提交全量刷新（逐站重查外部源，整轮较久）" : "已提交补采（只查还有数据要补的站）");
      // 轮询到任务结束：全量刷新可能边等出口额度回补边补采，最长约半小时
      for (let i = 0; i < 1800; i += 1) {
        const task = await apiSend<{ status: string }>(`/api/tasks/${res.task_id}`, "GET");
        if (task.status !== "running") {
          if (task.status === "done") toast("人气采集完成");
          else toast("人气采集任务异常结束，详情看「采集任务」页");
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      reload();
    } catch (error) {
      toast(`人气采集触发失败: ${errorText(error)}`);
    } finally {
      setRefreshing(false);
    }
  }

  const columns: DColumn<PopularityRow>[] = [
    {
      key: "site",
      title: "站点",
      width: 150,
      sorter: (a, b) => a.site_id.localeCompare(b.site_id),
      render: (_v, row) => {
        const site = getSiteInfo(row.site_id);
        return (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span className="mono" style={{ fontWeight: 550 }}>
              {site.name}
            </span>
            {!row.enabled && <span className="tag tag-quiet">停用</span>}
            <Btn size="sm" variant="text" onClick={() => openTrend(row.site_id)} title="看这站的人气趋势图">
              趋势
            </Btn>
          </span>
        );
      },
    },
    {
      key: "groups",
      title: "交流群",
      width: 190,
      render: (_v, row) => {
        if (!row.groups.length) return <span style={{ color: "var(--text-3)" }}>—</span>;
        return (
          <span style={{ display: "grid", gap: 2, fontSize: 12.5 }}>
            {row.groups.map((group) => (
              <span key={`${group.label}:${group.url}`}>
                {group.url ? (
                  <a className="mono" href={group.url} target="_blank" rel="noreferrer" title={group.title}>
                    {group.label}
                  </a>
                ) : (
                  <span className="mono">{group.label}</span>
                )}
                {group.members != null && (
                  <span style={{ color: "var(--text-3)" }}>
                    {" "}
                    {groupKindLabel(group)} {formatCompact(group.members)} 人
                  </span>
                )}
              </span>
            ))}
          </span>
        );
      },
    },
    {
      key: "visits",
      title: "访问量（每月）",
      align: "right",
      width: 110,
      sorter: (a, b) => (a.monthly_visits ?? -1) - (b.monthly_visits ?? -1),
      render: (_v, row) =>
        row.monthly_visits ? (
          <span className="mono" title={`来源：${row.visits_source === "similarweb" ? "SimilarWeb" : "第三方估算"}`}>
            {formatCompact(row.monthly_visits)}
          </span>
        ) : (
          <span style={{ color: "var(--text-3)" }}>—</span>
        ),
    },
    {
      key: "rank",
      title: "全网排名",
      align: "right",
      width: 100,
      sorter: (a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER),
      render: (_v, row) =>
        row.rank ? (
          <span className="mono" title="全网排名，越靠前越热">
            {formatCompact(row.rank)}
          </span>
        ) : (
          <span style={{ color: "var(--text-3)" }}>—</span>
        ),
    },
    {
      key: "checked_at",
      title: "上次取数",
      width: 150,
      sorter: (a, b) => (a.checked_at ?? 0) - (b.checked_at ?? 0),
      render: (_v, row) => (
        <span style={{ fontSize: 12.5 }}>
          <span style={{ color: "var(--text-2)" }}>{freshnessText(row.checked_at)}</span>
          {row.checked_at && (
            <span style={{ color: "var(--text-3)", display: "block", fontSize: 12 }}>
              {formatTime(row.checked_at)}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "needs_query",
      title: "状态",
      width: 90,
      render: (_v, row) => {
        const status = rowStatus(row);
        if (status === "pending") {
          return (
            <span className="tag tone-yellow" title="有外部数据还没拿到（或已到复查期），下一轮采集优先补">
              待补
            </span>
          );
        }
        if (status === "no_data") {
          return (
            <span
              className="tag tone-gray"
              title="SimilarWeb 没有这个站的数据（站太小或没被收录，一个月后自动复查一次）"
            >
              无数据
            </span>
          );
        }
        return (
          <span className="tag tag-quiet" title="访问量与排名都有结论，且都在复查期内">
            正常
          </span>
        );
      },
    },
  ];

  // 状态标签上的数字按当前行算，与切筛选后的实际条数一致
  const statusCounts: Record<StatusFilter, number> = { all: 0, pending: 0, normal: 0, no_data: 0 };
  for (const row of data?.rows ?? []) {
    statusCounts.all += 1;
    statusCounts[rowStatus(row)] += 1;
  }
  const visibleRows =
    statusFilter === "all" ? (data?.rows ?? []) : (data?.rows ?? []).filter((row) => rowStatus(row) === statusFilter);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="panel" style={{ display: "grid", gap: 6, padding: "14px 16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <IconUsers size={16} />
          <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>站点人气管理</h2>
          <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>
            共 {data?.total ?? "—"} 站，待补 {data?.pending ?? "—"} 站
          </span>
        </div>
        <p style={{ fontSize: 12.5, color: "var(--text-2)", margin: 0, lineHeight: 1.7 }}>
          访问量与排名都来自 SimilarWeb（每月更新），群人数按 Telegram 公开页面统计。
          SimilarWeb 对单个出口 IP 限流，采集会自动轮换采集出口里的节点把请求分散开；这一轮没轮到的站，下一轮定时采集会补上。
          「立即补采」只查还有数据要补的站；「全量刷新」无视复查期、逐站重查外部源，更慢也更耗额度。
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <Btn
            size="sm"
            disabled={refreshing}
            onClick={() => refresh(false)}
            title="现在就去补还有数据要补的站（缺数据或到复查期的），通常很快"
          >
            立即补采
          </Btn>
          <Btn
            size="sm"
            disabled={refreshing}
            onClick={() => refresh(true)}
            title="无视复查期，逐站重查外部源（SimilarWeb），额度消耗大、整轮更久"
          >
            全量刷新
          </Btn>
          {refreshing && <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>采集中…可以离开这个页面，采集在后台继续</span>}
        </div>
      </div>

      <div className="panel" style={{ overflow: "hidden" }}>
        {data === null ? (
          <div style={{ padding: "16px 20px" }}>
            <LoadingRows rows={8} />
          </div>
        ) : data.rows.length === 0 ? (
          <div style={{ padding: "40px 20px", textAlign: "center" }}>
            <DajuSit width={30} />
            <p style={{ color: "var(--text-3)", marginTop: 10 }}>还没有站点。先到「站点管理」添加。</p>
          </div>
        ) : (
          <>
            {/* 状态筛选：标签直接带数量，待补和无数据各有多少一眼可见 */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 10,
                padding: "12px 16px",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <Seg
                value={statusFilter}
                onChange={(next) => setStatusFilter(next as StatusFilter)}
                options={[
                  { value: "all", label: <>全部 <span className="mono" style={{ opacity: 0.6 }}>{statusCounts.all}</span></> },
                  { value: "pending", label: <>待补 <span className="mono" style={{ opacity: 0.6 }}>{statusCounts.pending}</span></> },
                  { value: "normal", label: <>正常 <span className="mono" style={{ opacity: 0.6 }}>{statusCounts.normal}</span></> },
                  { value: "no_data", label: <>无数据 <span className="mono" style={{ opacity: 0.6 }}>{statusCounts.no_data}</span></> },
                ]}
              />
            </div>
            <DataTable<PopularityRow>
              /* 切筛选重挂：页码/排序回到初始，避免停在上一次的页码上 */
              key={statusFilter}
              rowKey="site_id"
              columns={columns}
              rows={visibleRows}
              paginated
              defaultPageSize={20}
              pageSizeStorageKey="admin-popularity"
              scrollX={800}
              empty={statusFilter === "all" ? "暂无数据" : "这个状态下没有站点，切回「全部」看看别的。"}
            />
          </>
        )}
      </div>

      <Modal open={trendSite !== null} onClose={() => setTrendSite(null)} title="人气趋势" width={720}>
        {trendSite && (
          <div style={{ display: "grid", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <span className="mono" style={{ fontWeight: 550 }}>
                {getSiteInfo(trendSite).name}
              </span>
              <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>
                每轮采集记一个点（一天一个）；数据太少时线很短，多跑几轮自然长出来
              </span>
            </div>
            {trendPoints === null ? (
              <LoadingRows rows={3} />
            ) : (
              <PopularityTrendChart points={trendPoints} />
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
