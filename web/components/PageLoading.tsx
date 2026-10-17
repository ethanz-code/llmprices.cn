/* 数据页骨架屏：逐页对齐真实首屏布局。摘要条复用 .page-digest，卡片复用 .event-card，
 * 分页条复用 .pager，列模板与面板头取自各真实组件（DataTable 调用方的列定义、
 * ModelPicker、HistoryView、状态页 ch-row、Calculator、SnapshotPreview），
 * 内容换入时只剩「灰条 → 文字」的原位变化，不再跳版。
 * 所有条块带负相位错峰（Skel delay），整页 shimmer 呈波浪扫过而非同步闪。 */

import type { CSSProperties } from "react";

import { LoadingRows, Skel } from "./ui";

/* ---------- 通用零件 ---------- */

/** 摘要条骨架：label 在上、value 在下，与真实 .page-digest-item 的 column 排布一致；
 *  复用 .page-digest 拿到同样的底线与间距，换入时整条高度不跳。 */
function DigestSkeleton({ labels }: { labels: string[] }) {
  return (
    <div className="page-digest" aria-hidden>
      {labels.map((label, index) => (
        <span key={label} className="page-digest-item">
          <Skel w={label.length * 13} h={11} delay={index * 90} />
          <Skel w={56} h={20} delay={index * 90 + 45} />
        </span>
      ))}
    </div>
  );
}

/** 列宽：数字即 px；"auto" 与 fr 类不给宽（table-layout:fixed 下自动平分剩余，与真实表一致）；
 *  其余字符串（如 min(140px,24vw)）原样透传给 <col>。 */
type Col = number | "auto" | (string & {});

const colWidth = (col: Col): string | undefined => {
  if (typeof col === "number") return `${col}px`;
  if (col === "auto" || col.endsWith("fr)")) return undefined;
  return col;
};

/** 单元格条宽：行×列决定 52%–80% 的伪随机宽度，避免整列齐刷刷。 */
const cellWidth = (row: number, col: number) => `${52 + ((row * 7 + col * 13) % 5) * 7}%`;

/** 分页条骨架：复用 .pager 获得真实分页的布局盒。 */
function PagerSkeleton() {
  return (
    <div className="pager" aria-hidden>
      <span className="pager-info">
        <Skel w={64} h={12} />
      </span>
      <Skel w={58} h={28} style={{ borderRadius: 6 }} />
      {[0, 1, 2, 3, 4].map((index) => (
        <Skel key={index} w={28} h={28} style={{ borderRadius: 6 }} delay={index * 60} />
      ))}
      <Skel w={58} h={28} style={{ borderRadius: 6 }} />
      <Skel w={104} h={12} />
    </div>
  );
}

/** 数据表骨架：直接铺真实 .dtable——列宽交给 <colgroup>、窄屏隐藏列复用 .col-hide-m，
 *  单元格内距/行高/表头色带/首末列内缩全部来自真实样式，换入时列位与行高零漂移。
 *  head 为面板头栏（总览/目录/全量渠道）；dense 对应 .dtable-dense；tallRows 表示真实行为
 *  双行内容（站点 + 分组小字），加高行留白逼近真实行高。 */
function PanelTable({
  cols,
  mobileHide = [],
  rows = 12,
  dense = false,
  head = false,
  pager = false,
  tallRows = false,
}: {
  cols: Col[];
  /** 窄屏（≤1024px）隐藏的列下标：与真实列的 mobileHide 一一对应，避免窄屏骨架多出列 */
  mobileHide?: number[];
  rows?: number;
  dense?: boolean;
  /** 面板头栏：左标题 + 右数据时间/汇率 */
  head?: boolean;
  pager?: boolean;
  tallRows?: boolean;
}) {
  const hide = new Set(mobileHide);
  return (
    <div className="panel" style={{ overflow: "hidden" }} aria-hidden>
      {head && (
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
          <Skel w={150} h={15} />
          <Skel w={226} h={13} delay={90} />
        </div>
      )}
      {/* .dtable-dense 挂在这层（与 DataTable 同款），窄屏隐藏列靠 .col-hide-m 自动折叠列 */}
      <div className={`dtable-wrap${dense ? " dtable-dense" : ""}`}>
        <div className="dtable-scroll">
          <table className="dtable" style={{ tableLayout: "fixed" }}>
            <colgroup>
              {cols.map((col, index) => (
                <col key={index} style={{ width: colWidth(col) }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {cols.map((_, index) => (
                  <th key={index} className={hide.has(index) ? "col-hide-m" : undefined}>
                    <Skel w="58%" h={11} delay={index * 40} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: rows }, (_, row) => (
                <tr key={row}>
                  {cols.map((_, col) => (
                    <td
                      key={col}
                      className={hide.has(col) ? "col-hide-m" : undefined}
                      style={tallRows ? { paddingTop: 18, paddingBottom: 18 } : undefined}
                    >
                      <Skel w={cellWidth(row, col)} h={13} delay={row * 130 + col * 47} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {pager && <PagerSkeleton />}
      </div>
    </div>
  );
}

/* ---------- 各页骨架（被对应路由的 loading.tsx 引用） ---------- */

/** 总览页：摘要条 3 项 + 模型选择下拉（300px）+ 面板头栏 + 8 列表（对齐 OverviewTable）。 */
export function OverviewLoading() {
  return (
    <div className="page">
      <DigestSkeleton labels={["站点", "模型", "价格记录"]} />
      <div style={{ marginBottom: 16 }} aria-hidden>
        <Skel w={300} h={34} style={{ borderRadius: 6, maxWidth: "100%" }} />
      </div>
      {/* 列与 OverviewTable 逐列对齐：站点 / 首页实拍 / 输入价 / 输出价 / 缓存价 / 分组 / 折扣 / 渠道 / 公告 */}
      <PanelTable
        cols={["auto", 88, 120, 120, 120, 110, 150, 200, "auto"]}
        mobileHide={[1, 4, 5, 6, 7, 8]}
        dense
        head
        pager
        tallRows
        rows={18}
      />
    </div>
  );
}

/** 榜单页：摘要条 2 项 + 搜索行（搜索框 + 数据时间文案）+ 7 列表（对齐 RankingsTable）。 */
export function RankingsLoading() {
  return (
    <div className="page">
      <DigestSkeleton labels={["上榜模型", "评测厂商"]} />
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          alignItems: "center",
          marginBottom: 16,
        }}
        aria-hidden
      >
        <Skel
          w={420}
          h={34}
          style={{ borderRadius: 6, flex: "1 1 260px", maxWidth: "min(420px, 100%)" }}
        />
        <Skel w={186} h={12} delay={120} />
      </div>
      {/* 列与 RankingsTable 对齐：排名 / 模型 / 厂商 / 上下文 / 综合评分 / 速度 / 首字延迟 */}
      <PanelTable
        cols={[72, 220, 130, 84, 96, 100, 92]}
        mobileHide={[2, 3, 5, 6]}
        dense
        pager
        rows={40}
      />
    </div>
  );
}

/** 目录页：摘要条 2 项 + 双视图切换行（Seg + 搜索 + 厂商下拉 + 榜单链接）
 *  + 6 列表（对齐 CatalogTable 官方定价视图，默认视图）。 */
export function CatalogLoading() {
  return (
    <div className="page">
      <DigestSkeleton labels={["官方定价模型", "全量渠道模型"]} />
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          alignItems: "center",
          marginBottom: 16,
        }}
        aria-hidden
      >
        <div
          style={{
            display: "flex",
            gap: 2,
            padding: 3,
            background: "var(--field-bg)",
            borderRadius: 6,
          }}
        >
          <Skel w={68} h={26} style={{ borderRadius: 4 }} />
          <Skel w={68} h={26} style={{ borderRadius: 4 }} delay={60} />
        </div>
        <Skel
          w={420}
          h={34}
          style={{ borderRadius: 6, flex: "1 1 260px", maxWidth: "min(420px, 100%)" }}
          delay={100}
        />
        <Skel w={160} h={34} style={{ borderRadius: 6, maxWidth: "100%" }} delay={160} />
        {/* 右侧簇：榜单链接 + 立即同步按钮，与真实工具栏同为 2 项 */}
        <Skel w={66} h={13} style={{ marginLeft: "auto" }} delay={200} />
        <Skel w={88} h={34} style={{ borderRadius: 6 }} delay={240} />
      </div>
      {/* 列与 CatalogTable 对齐：厂商 / 模型(296，为 AA 徽标留宽) / 输入价 / 输出价 / 简介 / 来源 */}
      <PanelTable
        cols={[170, 296, 190, 190, "auto", 60]}
        mobileHide={[3, 4, 5]}
        dense
        head
        pager
        tallRows
        rows={28}
      />
    </div>
  );
}

/** 厂商定价页 · 全量渠道视图骨架：视图切换行（Seg + 说明 + 榜单链接 + 立即同步）
 *  + 全量渠道自身的筛选行（搜索 + 渠道下拉）+ 面板（头栏 + 7 列表），对齐 CatalogAllTable。 */
export function CatalogAllLoading() {
  return (
    <div className="page">
      <DigestSkeleton labels={["官方定价模型", "全量渠道模型"]} />
      <div style={{ display: "grid", gap: 16 }} aria-hidden>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
          <div
            style={{
              display: "flex",
              gap: 2,
              padding: 3,
              background: "var(--field-bg)",
              borderRadius: 6,
            }}
          >
            <Skel w={68} h={26} style={{ borderRadius: 4 }} />
            <Skel w={68} h={26} style={{ borderRadius: 4 }} delay={60} />
          </div>
          <Skel w={300} h={13} delay={100} />
          <Skel w={66} h={13} style={{ marginLeft: "auto" }} delay={140} />
          <Skel w={88} h={34} style={{ borderRadius: 6 }} delay={180} />
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
          <Skel
            w={420}
            h={34}
            style={{ borderRadius: 6, flex: "1 1 260px", maxWidth: "min(420px, 100%)" }}
          />
          <Skel w={200} h={34} style={{ borderRadius: 6, maxWidth: "100%" }} delay={80} />
        </div>
        {/* 列与 CatalogAllTable 对齐：渠道/厂商 / 模型 / 价格 / 上下文 / 简介 / 发布 / 来源 */}
        <PanelTable
          cols={[190, 230, 180, 180, "auto", 110, 60]}
          mobileHide={[3, 4, 5, 6]}
          dense
          head
          pager
          tallRows
          rows={28}
        />
      </div>
    </div>
  );
}

/** 日期分节头骨架：日期 + 发丝线 + 条数，对齐 EventFeed 的分节结构。 */
function DayHeadSkeleton() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }} aria-hidden>
      <Skel w={88} h={12} />
      <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
      <Skel w={30} h={12} delay={60} />
    </div>
  );
}

/** 事件卡骨架：标签 + 站点 + 模型 + 时间一行、摘要一行，对齐真实 event-card 结构。 */
function EventCardSkeleton({ row }: { row: number }) {
  return (
    <div className="event-card" aria-hidden>
      <div style={{ display: "grid", gap: 7, flex: 1 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <Skel w={46} h={22} style={{ borderRadius: 999 }} delay={row * 130} />
          <Skel w={92} h={13} delay={row * 130 + 40} />
          <Skel w={150} h={13} delay={row * 130 + 80} />
          <Skel w={96} h={12} style={{ marginLeft: "auto" }} delay={row * 130 + 110} />
        </div>
        <Skel w={`${64 - (row % 3) * 7}%`} h={13} delay={row * 130 + 150} />
      </div>
    </div>
  );
}

/** 历史页：摘要条 2 项 + 「事件 | 站点筛选」工具行 + 按天分节的事件卡（对齐 HistoryView）。 */
export function HistoryLoading() {
  return (
    <div className="page">
      <DigestSkeleton labels={["价格事件", "公告"]} />
      <div style={{ display: "grid", gap: 24 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 12,
            alignItems: "center",
          }}
          aria-hidden
        >
          <Skel w={36} h={15} />
          <Skel w={128} h={34} style={{ borderRadius: 6 }} delay={80} />
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          <DayHeadSkeleton />
          {[0, 1, 2, 3].map((row) => (
            <EventCardSkeleton key={row} row={row} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** 渠道状态行骨架：7 列（渠道 / 状态 / 延迟·7日可用率 / 成功率·输出速度 / 缓存读写 / 可用记录条 / 正常次数），
 *  列模板与描边一律交给 .ch-row（gap 8 / padding 5px 0 / border-top），不再另写内距，否则整行错位。 */
function ChannelRowSkeleton({ row, head = false }: { row: number; head?: boolean }) {
  return (
    <div className={`ch-row${head ? " ch-head" : ""}`} aria-hidden>
      {head ? (
        <>
          <Skel w={44} h={12} />
          <Skel w={32} h={12} delay={20} />
          <Skel w={104} h={12} delay={40} style={{ justifySelf: "end" }} />
          <Skel w={92} h={12} delay={60} style={{ justifySelf: "end" }} />
          <Skel w={96} h={12} delay={80} style={{ justifySelf: "end" }} />
          <Skel w={72} h={12} delay={100} />
          <Skel w={56} h={12} delay={120} />
        </>
      ) : (
        <>
          <span className="ch-name" style={{ display: "grid", gap: 4 }}>
            <Skel w={110} h={13} delay={row * 120} />
            <Skel w={150} h={11} delay={row * 120 + 30} />
          </span>
          <span className="ch-state">
            <Skel w={64} h={22} style={{ borderRadius: 999 }} delay={row * 120 + 50} />
          </span>
          <Skel w={104} h={13} delay={row * 120 + 70} style={{ justifySelf: "end" }} />
          <Skel w={112} h={13} delay={row * 120 + 90} style={{ justifySelf: "end" }} />
          <Skel w={96} h={13} delay={row * 120 + 100} style={{ justifySelf: "end" }} />
          <span className="ch-upt">
            <span className="uptime-wrap" style={{ display: "block" }}>
              <span className="uptime-bars">
                {Array.from({ length: 18 }, (_, index) => (
                  <Skel
                    key={index}
                    w="100%"
                    h={30}
                    style={{ flex: 1, borderRadius: 2.5 }}
                    delay={row * 120 + index * 10}
                  />
                ))}
              </span>
            </span>
          </span>
          <Skel w={40} h={13} delay={row * 120 + 110} />
        </>
      )}
    </div>
  );
}

/** 站点检测详情页：页头（标题 + 分享按钮）+ 检测面板（时段色块 + 两张图）
 *  + 渠道状态列表 + 站点公告（对齐 status/[siteId] 页）。 */
export function StatusLoading() {
  return (
    <div className="page">
      <div className="page-header" aria-hidden>
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 24,
          }}
        >
          <Skel w={280} h={28} />
          <Skel
            w={110}
            h={34}
            style={{ borderRadius: 8, marginBottom: 4 }}
            delay={60}
          />
        </div>
      </div>
      <div style={{ display: "grid", gap: 16 }} aria-hidden>
        <section className="panel" style={{ display: "grid", gap: 14, padding: 16 }}>
          <div className="uptime-wrap">
            <div className="uptime-bars">
              {Array.from({ length: 28 }, (_, index) => (
                <Skel
                  key={index}
                  w="100%"
                  h={30}
                  style={{ flex: 1, borderRadius: 2.5 }}
                  delay={index * 30}
                />
              ))}
            </div>
          </div>
          {/* 趋势图：可用率 + 延迟 + TPS 三块，各带一行小节标题，块距与 StatusCharts 的 gap 14 一致 */}
          <div style={{ paddingTop: 4, display: "grid", gap: 14 }}>
            {[132, 108, 150].map((titleW, index) => (
              <div key={index} style={{ display: "grid", gap: 10 }}>
                <Skel w={titleW} h={16} delay={220 + index * 90} />
                <Skel w="100%" h={216} style={{ borderRadius: 8 }} delay={260 + index * 90} />
              </div>
            ))}
          </div>
        </section>
        <section className="panel" style={{ display: "grid", gap: 2, padding: 16 }}>
          <Skel w={110} h={16} style={{ marginBottom: 6 }} />
          <ChannelRowSkeleton row={0} head />
          {[0, 1, 2, 3, 4, 5].map((row) => (
            <ChannelRowSkeleton key={row} row={row} />
          ))}
        </section>
        <section className="panel" style={{ display: "grid", gap: 10, padding: 16 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
            <Skel w={64} h={15} />
            <Skel w={170} h={12} delay={60} />
          </div>
          <Skel w="88%" h={13} delay={100} />
          <Skel w="72%" h={13} delay={160} />
          <Skel w="80%" h={13} delay={220} />
        </section>
        {/* 站点首页实拍：截图固定 1280×800（比例 1.6），骨架按同比例占位，换入时高度不跳 */}
        <section className="panel" style={{ display: "grid", gap: 10, padding: 16 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <Skel w={92} h={16} />
            <Skel w={96} h={12} delay={60} />
          </div>
          <Skel
            w="100%"
            style={{ aspectRatio: "1280 / 800", height: "auto", borderRadius: 8 }}
            delay={120}
          />
        </section>
      </div>
    </div>
  );
}

/** 花费计算页：摘要条 2 项 + 模型选择块（来源切换 + 搜索 + 厂商分节候选）
 *  + 单价/用量块（四档单价、三格用量、两组提示）+ 结果块（合计 + 五列明细表）。
 *  容器与列数逐条对齐 Calculator：880 居中、候选带上厂商节头、用量三格、结果表直接铺 .dtable。 */
export function CalcLoading() {
  return (
    <div className="page page-calc">
      <DigestSkeleton labels={["官方价模型", "站点"]} />
      <div className="calculator" aria-hidden>
        <section className="panel calc-block">
          <div className="calc-head">
            <Skel w={150} h={28} style={{ borderRadius: 6 }} />
            <Skel w={280} h={34} style={{ borderRadius: 6, maxWidth: "100%" }} delay={60} />
          </div>
          <div className="calc-options">
            <div className="calc-vendor">
              <Skel w={92} h={12} />
            </div>
            {[0, 1, 2, 3, 4].map((row) => (
              <div key={row} className="calc-option">
                <span className="calc-option-main">
                  <Skel w={`${44 - (row % 3) * 6}%`} h={13} delay={row * 90} />
                  <Skel w={56} h={11} delay={row * 90 + 30} style={{ flexShrink: 0 }} />
                </span>
                <Skel w={92} h={12} delay={row * 90 + 50} style={{ flexShrink: 0 }} />
              </div>
            ))}
          </div>
        </section>

        <section className="panel calc-block">
          <div className="calc-head">
            <Skel w={96} h={15} />
          </div>
          <div className="calc-grid">
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="calc-field">
                <Skel w={72} h={12} delay={index * 60} />
                <Skel w="100%" h={34} style={{ borderRadius: 6 }} delay={index * 60 + 20} />
              </div>
            ))}
          </div>
          <div className="calc-head" style={{ margin: "18px 0 0" }}>
            <Skel w={40} h={15} />
          </div>
          {/* 用量三格（总用量 / 缓存命中率 / 输出占比）：与真实页同列模板，窄屏自动折行 */}
          <div
            className="calc-grid"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}
          >
            {[0, 1, 2].map((index) => (
              <div key={index} className="calc-field">
                <Skel w={84} h={12} delay={index * 60 + 240} />
                <Skel w="100%" h={34} style={{ borderRadius: 6 }} delay={index * 60 + 260} />
              </div>
            ))}
          </div>
          <div className="calc-actions">
            <Skel w="58%" h={12} delay={380} />
            <Skel w={128} h={12} delay={400} />
          </div>
          <div className="calc-actions">
            <Skel w="46%" h={12} delay={420} />
          </div>
        </section>

        <section className="panel calc-block calc-result">
          <div className="calc-head">
            <Skel w={72} h={15} />
            <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
              <Skel w={100} h={28} style={{ borderRadius: 6 }} delay={60} />
              <Skel w={112} h={28} style={{ borderRadius: 6 }} delay={100} />
            </span>
          </div>
          <div className="calc-total">
            <Skel w={40} h={13} />
            <Skel w={150} h={28} delay={80} />
          </div>
          {/* 明细表：五列（计费项/单价/用量/小计/费用占比）四行，直接铺 .dtable，不再嵌一层面板 */}
          <div className="dtable-wrap">
            <div className="dtable-scroll">
              <table className="dtable">
                <thead>
                  <tr>
                    <th>
                      <Skel w={44} h={11} />
                    </th>
                    {[28, 28, 28, 52].map((w, index) => (
                      <th key={w + index} style={{ textAlign: "right" }}>
                        <Skel w={w} h={11} delay={30 + index * 30} style={{ marginLeft: "auto" }} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[0, 1, 2, 3].map((row) => (
                    <tr key={row}>
                      <td>
                        <Skel w={56} h={13} delay={row * 90} />
                      </td>
                      {[40, 72, 48, 32].map((w, col) => (
                        <td key={col} style={{ textAlign: "right" }}>
                          <Skel
                            w={w}
                            h={13}
                            delay={row * 90 + (col + 1) * 20}
                            style={{ marginLeft: "auto" }}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

/** 管理面板概览骨架：对齐 /admin 概览——外层 .page 由 admin layout 提供，这里只铺 dash-grid。
 *  主栏 = 统计条 + 访问统计 + 采集报错 + 最近事件（4 块），右栏 = 快捷入口 + 公开页面（2 块），
 *  统计条留在主栏内（占左栏宽）而不是铺满整页。 */
export function AdminLoading() {
  return (
    <>
      <h1 className="sr-only">控制台</h1>
      <div className="dash-grid" aria-hidden>
        <div className="dash-main">
          <div className="dash-stats">
            {["检测站点", "价格记录", "事件总数", "输入折扣中位数"].map((label, index) => (
              <div key={label} className="dash-stat">
                <Skel w={label.length * 12} h={12} delay={index * 70} />
                <Skel w={64} h={20} style={{ marginTop: 3 }} delay={index * 70 + 30} />
              </div>
            ))}
          </div>
          <div className="panel">
            <div className="dash-panel-head">
              <Skel w={76} h={15} />
            </div>
            <div style={{ padding: 16 }}>
              <Skel w="100%" h={120} style={{ borderRadius: 8 }} delay={80} />
            </div>
          </div>
          <div className="panel">
            <div className="dash-panel-head">
              <Skel w={92} h={15} />
            </div>
            <div style={{ padding: 16 }}>
              <LoadingRows rows={3} />
            </div>
          </div>
          <div className="panel">
            <div className="dash-panel-head">
              <Skel w={80} h={15} />
              <Skel w={64} h={13} delay={60} />
            </div>
            <div className="dash-events">
              {[0, 1, 2].map((row) => (
                <div key={row} className="event-card">
                  <Skel
                    w={8}
                    h={8}
                    style={{ borderRadius: "50%", flexShrink: 0, marginTop: 5 }}
                    delay={row * 120}
                  />
                  <div style={{ display: "grid", gap: 6, flex: 1 }}>
                    <Skel w={`${56 - row * 7}%`} h={13} delay={row * 120 + 30} />
                    <Skel w={`${72 - row * 9}%`} h={11} delay={row * 120 + 60} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="dash-side">
          {[4, 3].map((count, panel) => (
            <div key={panel} className="panel">
              <div className="dash-panel-head">
                <Skel w={64} h={15} />
              </div>
              <div className="dash-quick">
                {Array.from({ length: count }, (_, row) => (
                  <div key={row} className="dash-quick-item">
                    <Skel w={15} h={15} style={{ borderRadius: 4, flexShrink: 0 }} delay={row * 60} />
                    <Skel w={72} h={13} delay={row * 60 + 30} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/* ---------- 首页 landing 骨架 ---------- */

/** hero 节点轮播一排：点 + 站名 + 百分比，对齐 pano-site 胶囊；渲染时复制一份凑满
 *  marquee 的 -50% 位移，与真实页同一套无缝循环（真实页由 HeroArea 复制 ghost 节点）。 */
const PANO_WIDTHS = [
  [76, 96, 64, 88, 72, 104],
  [84, 60, 92, 68, 100, 76],
];

/** 星野散点占位：几团「大陆」簇近似真实底图点阵的疏密（固定公式生成——骨架由服务端
 *  渲染，不能用 Math.random，否则每次请求坐标都变）；只求星野氛围，不描真实海岸线。 */
const MAP_CLUSTERS = [
  { x: 21, y: 38, spread: 10, count: 14 },
  { x: 33, y: 64, spread: 7, count: 8 },
  { x: 48, y: 32, spread: 8, count: 12 },
  { x: 57, y: 56, spread: 9, count: 10 },
  { x: 74, y: 42, spread: 12, count: 16 },
  { x: 86, y: 68, spread: 5, count: 6 },
];

const MAP_DOTS = MAP_CLUSTERS.flatMap((cluster, c) =>
  Array.from({ length: cluster.count }, (_, i) => {
    const seed = c * 57 + i * 23;
    return {
      left: cluster.x + ((seed * 7) % (cluster.spread * 2)) - cluster.spread,
      top: cluster.y + ((seed * 13) % cluster.spread) - cluster.spread / 2,
      delay: (seed * 97) % 1400,
    };
  }),
);

/** 亮星节点占位：对齐真实页按归属地落点的状态色亮星（骨架保持中性灰，换入不变位） */
const MAP_NODES = [
  { left: 24, top: 36 },
  { left: 46, top: 28 },
  { left: 55, top: 44 },
  { left: 66, top: 34 },
  { left: 77, top: 26 },
  { left: 87, top: 52 },
];

/** 榜单速览行骨架：#排名 / 模型 / 厂商 / 指数，对齐 .rank-row 四列模板。 */
const RANK_COLS = "2.4em minmax(0, 1fr) 160px 4.5em";

function RankListSkeleton() {
  return (
    <div className="rank-list" aria-hidden>
      <div
        className="rank-list-head"
        style={{ display: "grid", gridTemplateColumns: RANK_COLS, columnGap: 14 }}
      >
        <Skel w={16} h={11} />
        <Skel w={36} h={11} delay={20} />
        <Skel w={36} h={11} delay={40} />
        <Skel w={48} h={11} delay={60} />
      </div>
      {[0, 1, 2, 3, 4].map((row) => (
        <div
          key={row}
          className="rank-row"
          style={{
            display: "grid",
            gridTemplateColumns: RANK_COLS,
            columnGap: 14,
            alignItems: "center",
            borderBottom: "1px solid var(--border)",
            padding: "11px 10px",
          }}
        >
          <Skel w={30} h={13} delay={row * 120} />
          <Skel w={`${58 - (row % 3) * 8}%`} h={13} delay={row * 120 + 30} />
          <Skel w={100} h={13} delay={row * 120 + 60} />
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              gap: 4,
            }}
          >
            <Skel w={34} h={13} delay={row * 120 + 90} />
            <Skel w={30} h={3} delay={row * 120 + 110} style={{ borderRadius: 2 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** 首页骨架：hero（星空点阵图 + 文案叠放 + 两排节点轮播）+ Bento 介绍 + 最新价表
 *  + 趋势/事件两栏 + 站点卡 + 榜单速览 + FAQ + CTA，节次与真实页一致，换入不跳版。 */
export function LandingLoading() {
  return (
    <div className="page landing">
      <section className="hero">
        {/* 星空层：借 .hero-sky / .pano-flatmap 拿到与真实页一致的 100vw 全出血布局盒
            （cobe 3D 球已退役），散点占位底图星野、大点占位站点亮星，文案照旧压在图上 */}
        <div className="hero-sky" aria-hidden>
          <div className="pano-flatmap">
            {MAP_DOTS.map((dot, index) => (
              <Skel
                key={index}
                w={3}
                h={3}
                delay={dot.delay}
                style={{
                  position: "absolute",
                  left: `${dot.left}%`,
                  top: `${dot.top}%`,
                  borderRadius: "50%",
                }}
              />
            ))}
            {MAP_NODES.map((node, index) => (
              <Skel
                key={index}
                w={8}
                h={8}
                delay={index * 180}
                style={{
                  position: "absolute",
                  left: `${node.left}%`,
                  top: `${node.top}%`,
                  borderRadius: "50%",
                }}
              />
            ))}
          </div>
          <div className="hero-main">
            <div style={{ display: "grid", gap: 8 }}>
              <Skel w="82%" h={52} />
              <Skel w="58%" h={52} delay={80} />
            </div>
            <div style={{ display: "grid", gap: 8, marginTop: 22 }}>
              <Skel w="94%" h={13} delay={160} />
              <Skel w="72%" h={13} delay={200} />
            </div>
            <div style={{ display: "flex", gap: 12, marginTop: 30 }}>
              <Skel w={150} h={44} style={{ borderRadius: 10 }} delay={260} />
              <Skel w={128} h={44} style={{ borderRadius: 10 }} delay={300} />
            </div>
          </div>
        </div>
        {PANO_WIDTHS.map((widths, row) => (
          <div
            key={row}
            className={`marquee-row is-scroll${row % 2 ? " is-reverse" : ""}`}
            aria-hidden
          >
            <ul
              className="marquee-track"
              style={{ "--marquee-dur": "72s" } as CSSProperties}
            >
              {[...widths, ...widths].map((width, index) => (
                <li key={index}>
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "7px 8px",
                    }}
                  >
                    <Skel
                      w={8}
                      h={8}
                      style={{ borderRadius: "50%", flexShrink: 0 }}
                      delay={row * 200 + index * 45}
                    />
                    <Skel w={width} h={12} delay={row * 200 + index * 45 + 15} />
                    <Skel w={34} h={12} delay={row * 200 + index * 45 + 30} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      {/* Bento 产品介绍骨架：1 大 + 3 小 */}
      <section className="landing-section" aria-hidden>
        <div className="bento-grid">
          <div className="bento-card bento-card--feature">
            <Skel w={170} h={16} />
            <Skel w="62%" h={12} delay={60} />
          </div>
          {[0, 1, 2].map((row) => (
            <div key={row} className="bento-card">
              <Skel w={`${70 - row * 8}%`} h={15} delay={row * 70} />
              <Skel w="88%" h={12} delay={row * 70 + 30} />
              <Skel w="72%" h={12} delay={row * 70 + 50} />
            </div>
          ))}
        </div>
      </section>

      <section className="landing-section" aria-hidden>
        <div className="landing-section-head">
          <Skel w={132} h={28} />
          <Skel w={64} h={13} delay={60} />
        </div>
        <div style={{ marginTop: 14 }}>
          <Skel w="42%" h={11} delay={100} />
        </div>
        <div style={{ marginTop: 16 }}>
          {/* 与首页最新价用的 SnapshotPreview 同款列：站点 / 模型 / 输入价 / 输出价 / 分组 / 时间 */}
          <PanelTable
            cols={["min(140px, 24vw)", "auto", 130, 130, 140, 150]}
            mobileHide={[3, 4, 5]}
            dense
            rows={6}
          />
        </div>
      </section>

      <section className="landing-section landing-duo" aria-hidden>
        <div>
          <div className="landing-section-head">
            <Skel w={110} h={28} />
          </div>
          <div className="panel" style={{ marginTop: 20, padding: 16 }}>
            <Skel w="100%" h={210} style={{ borderRadius: 8 }} delay={120} />
          </div>
        </div>
        <div>
          <div className="landing-section-head">
            <Skel w={96} h={28} />
            <Skel w={70} h={13} delay={60} />
          </div>
          <div className="landing-events" style={{ marginTop: 20 }}>
            {[0, 1, 2, 3].map((row) => (
              <div key={row} className="event-row">
                <Skel w={40} h={20} style={{ borderRadius: 6 }} delay={row * 120} />
                <div style={{ flex: 1, display: "grid", gap: 5 }}>
                  <Skel w={`${56 - row * 6}%`} h={13} delay={row * 120 + 30} />
                  <Skel w={`${40 - row * 4}%`} h={11} delay={row * 120 + 55} />
                </div>
                <Skel w={64} h={11} delay={row * 120 + 80} />
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="landing-section" aria-hidden>
        <div className="landing-section-head">
          <Skel w={88} h={28} />
          <Skel w={96} h={13} delay={60} />
        </div>
        <div style={{ marginTop: 14 }}>
          <Skel w="38%" h={11} delay={100} />
        </div>
        {/* 站点小卡网格骨架，对齐真实页 .site-grid / .site-card */}
        <div className="site-grid" style={{ marginTop: 20 }}>
          {[0, 1, 2, 3, 4, 5, 6, 7].map((row) => (
            <div key={row} className="site-card">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Skel
                  w={8}
                  h={8}
                  style={{ borderRadius: "50%", flexShrink: 0 }}
                  delay={row * 90}
                />
                <Skel w={`${68 - (row % 3) * 8}%`} h={13} delay={row * 90 + 20} />
                <Skel w={32} h={13} style={{ marginLeft: "auto" }} delay={row * 90 + 40} />
              </div>
              <Skel w={64} h={11} delay={row * 90 + 60} />
            </div>
          ))}
        </div>
      </section>

      <section className="landing-section" aria-hidden>
        <div className="landing-section-head">
          <Skel w={110} h={28} />
          <Skel w={78} h={13} delay={60} />
        </div>
        <div style={{ marginTop: 14 }}>
          <Skel w="36%" h={11} delay={100} />
        </div>
        <div style={{ marginTop: 16 }}>
          <RankListSkeleton />
        </div>
      </section>

      <section className="landing-section" aria-hidden>
        <div className="landing-section-head">
          <Skel w={132} h={28} />
        </div>
        <div style={{ display: "grid", gap: 14, marginTop: 18 }}>
          {[0, 1, 2, 3].map((row) => (
            <div key={row} style={{ display: "flex", gap: 14, alignItems: "baseline" }}>
              <Skel w={24} h={13} delay={row * 90} />
              <Skel w={`${54 - row * 5}%`} h={13} delay={row * 90 + 30} />
            </div>
          ))}
        </div>
      </section>

      <section className="landing-section" aria-hidden>
        <div className="landing-section-head">
          <Skel w={64} h={22} />
        </div>
        <div style={{ display: "grid", gap: 14, marginTop: 18 }}>
          {[0, 1, 2].map((row) => (
            <Skel key={row} w={`${44 - row * 4}%`} h={14} delay={row * 100} />
          ))}
        </div>
      </section>

      <section
        className="landing-cta"
        style={{ display: "grid", justifyItems: "center", gap: 18, padding: "48px 0" }}
        aria-hidden
      >
        <Skel w={300} h={24} />
        <Skel w={170} h={44} style={{ borderRadius: 10 }} delay={120} />
      </section>
    </div>
  );
}
