import Link from "next/link";
import { apiGet } from "@/lib/api";
import { Btn } from "@/components/ui";
import {
  eventMeta,
  formatPrice,
  formatTime,
  isNoticeEvent,
  toCnyPrice,
} from "@/lib/format";
import { getSiteInfo, loadSiteHomepages, type SiteHomepages } from "@/lib/sites";
import { canonicalModel, lowestPriceRowPerModel, orderByReleaseDesc } from "@/lib/priceRows";
import { foldEvents, noticeText } from "@/lib/events";
import { rateLevel, type RateLevel } from "@/lib/channelStatus";
import { buildSiteQualityFromOverview, orderSitesByQuality } from "@/lib/siteRanking";
import { loadSitePopularity, type SitePopularityMap } from "@/lib/popularity";
import { loadSiteChannelSummary } from "@/lib/statusData";
import type {
  CatalogData,
  DiscountInfo,
  EventRow,
  FeedData,
  HistoryListData,
  MetaData,
  OverviewData,
  RankingsData,
  SiteChannelSummary,
  SummaryBucket,
} from "@/lib/types";
import { SectionRail } from "@/components/SectionRail";
import { Reveal } from "@/components/Reveal";
import { HeroType } from "@/components/HeroType";
import { HeroArea } from "@/components/HeroArea";
import type { GlobeSite, SiteGeo } from "@/components/SiteMapFlat";
import { HeroTrendChart } from "@/components/HeroTrendChart";
import { SnapshotPreview } from "@/components/SnapshotPreview";
import { SiteAlert } from "@/components/SiteAlert";
import { SiteCard, UptimeStrip } from "@/components/SiteCard";
import { DajuChartNap, DajuNap, DajuYarn } from "@/components/DajuArt";
import { FaqList } from "@/components/FaqList";
import { JsonLd } from "@/components/JsonLd";
import { IconAim, IconMonitor, IconSync } from "@/components/icons";
import { DiscountBars } from "@/components/DiscountBars";
import { alerts, home, site } from "@/lib/copy";
import { siteOrigin } from "@/lib/seo";

/** Bento 小卡图标映射：icon 键 → components/icons.tsx 组件 */
const BENTO_ICONS = {
  sync: IconSync,
  monitor: IconMonitor,
  aim: IconAim,
} as const;

export const dynamic = "force-dynamic";

interface LandingData {
  overview: OverviewData | null;
  meta: MetaData | null;
  feed: FeedData | null;
  history: HistoryListData | null;
  /** 渠道摘要（每站最新可用率/成功率/时段分桶）：站点卡与星球用，见 lib/statusData */
  channelSummary: SiteChannelSummary;
  /** 站点 IP 归属地：服务端取好传给首屏地球，读接口封锁后浏览器不再直接调 */
  geo: Record<string, SiteGeo>;
  /** AA 榜单：首页速览用，拉取失败只影响榜单小节 */
  rankings: RankingsData | null;
  /** 厂商目录：只取发布日期建排序索引，拉取失败只影响最新价格的排序规则 */
  catalog: CatalogData | null;
  /** 站点首页覆盖表：站名链接用，拉取失败退回内置映射/来源域名后备 */
  homepages: SiteHomepages;
  /** 站点人气：站点卡质量分「人气」一项的输入，拉取失败按无数据计（loadSitePopularity 自带后备） */
  popularity: SitePopularityMap;
  error: string | null;
}

/** 站点墙封顶：首页只列这么多张卡（质量分最高的在前），其余进「还有 N 个站点」卡（→ /sites） */
const SITE_CARD_MAX = 18;

/** 首屏胶囊轮播的站数上限：只取质量序前 10（站点不足 10 个就全上） */
const HERO_TICKER_MAX = 10;

/** 最新事件侧栏展示条数：feed 取 8 条折叠后截到这里，渲染处直接整组上 */
const LATEST_EVENTS_SHOWN = 5;

async function loadLanding(): Promise<LandingData> {
  try {
    // 统一事件流（价格+公告已合并）；渠道检测拉取失败只影响星球与站点卡片，不阻塞整页
    const overviewPromise = apiGet<OverviewData>("/api/overview");
    const [overview, meta, feed, channelSummary, geo, rankings, catalog, history, homepages, popularity] = await Promise.all([
      overviewPromise,
      apiGet<MetaData>("/api/meta"),
      apiGet<FeedData>("/api/feed?events_limit=8&notice_limit=8").catch(() => null),
      // 渠道摘要与站点检测详情页同一套规则：一个请求拿全站算好的可用率/时段分桶（后端 /api/status/summary）。
      // 曾经逐站拉 21 份原始快照共约 49MB 再在 Node 解析；整份视图（含 1.7MB 可用率序列）也不随列表下发。
      loadSiteChannelSummary().catch(() => ({ sites: {} })),

      // 站点定位较慢（DNS + 归属地查询），失败只影响地球落点，不阻塞整页
      apiGet<{ geo: Record<string, SiteGeo> }>("/api/geo").catch(() => ({ geo: {} })),
      apiGet<RankingsData>("/api/rankings").catch(() => null),
      apiGet<CatalogData>("/api/catalog").catch(() => null),
      // hero 折线是装饰位：拉取失败只影响图表回退补插画，不阻塞整页报错
      apiGet<HistoryListData>("/api/history?limit=1000").catch(() => null),
      // 站点首页覆盖表：站名外链用（loadSiteHomepages 自带后备，取不到返回空表）
      loadSiteHomepages(),
      // 站点人气：站点卡质量分用（loadSitePopularity 自带后备，取不到返回空表按无数据计）
      loadSitePopularity(),
    ]);
    return { overview, meta, feed, history, channelSummary, geo: geo.geo, rankings, catalog, homepages, popularity, error: null };
  } catch (cause) {
    return {
      overview: null,
      meta: null,
      feed: null,
      history: null,
      channelSummary: { sites: {} },
      geo: {},
      rankings: null,
      catalog: null,
      homepages: {},
      popularity: {},
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/** 榜单去重：推理档位变体（-xhigh/-high/-medium/-low 后缀）只留排名最靠前的基础模型行。 */
function topBaseModels(rankings: RankingsData | null, count = 5) {
  if (!rankings) return [];
  const seen = new Set<string>();
  const top: RankingsData["models"] = [];
  for (const entry of rankings.models) {
    const base = entry.slug.replace(/-(xhigh|high|medium|low)$/, "");
    if (seen.has(base)) continue;
    seen.add(base);
    top.push(entry);
    if (top.length >= count) break;
  }
  return top;
}

/** 站点去重：优先 /api/meta 全量清单，退化到快照里出现过的站点。 */
function collectSites(overview: OverviewData | null, meta: MetaData | null) {
  if (meta && meta.sites.length > 0) {
    return meta.sites.map((site) => ({
      id: site.id,
      models: site.models.length,
      enabled: site.enabled,
      sourceUrl: site.url,
    }));
  }
  if (!overview) return [];
  const seen = new Map<string, number>();
  for (const row of overview.records) {
    seen.set(row.site_id, (seen.get(row.site_id) ?? 0) + 1);
  }
  return [...seen.entries()].map(([id, models]) => ({
    id,
    models,
    enabled: true,
    sourceUrl: overview.records.find((row) => row.site_id === id)?.source_url,
  }));
}

/** Fisher-Yates 洗牌（返回新数组）：轮播胶囊席位顺序随机、集合不变；
 *  必须在服务端、每请求洗一次——客户端渲染时洗会与 SSR 输出不一致，触发水合报错。 */
function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** bento 小卡的微缩示例：三种能力各配一块「真实数据缩影」（调价 diff / 近 7 天探测色块 /
 *  折扣条形），对应数据缺席时整块不渲染，卡片回落纯文案。 */
function BentoDemo({
  kind,
  event,
  eventSite,
  buckets,
  bucketSite,
  discount,
  rate,
}: {
  kind: keyof typeof BENTO_ICONS;
  event: EventRow | null;
  eventSite: string | null;
  buckets: (SummaryBucket | null)[] | null;
  bucketSite: string | null;
  discount: DiscountInfo | null;
  rate: number | null;
}) {
  if (kind === "sync") {
    const previous = event?.previous;
    const current = event?.current;
    if (!event || !eventSite || !previous?.input_price || !current?.input_price) return null;
    const prev = toCnyPrice(previous.input_price, previous.unit, rate) ?? previous.input_price;
    const curr = toCnyPrice(current.input_price, current.unit, rate) ?? current.input_price;
    if (prev <= 0 || prev === curr) return null;
    const drop = curr < prev;
    const pct = Math.round((Math.abs(curr - prev) / prev) * 100);
    return (
      <div className="bento-demo" aria-hidden>
        <span className="bento-demo-head">
          <span className="bento-demo-site">{eventSite}</span>
          <span className="mono bento-demo-model">{event.model}</span>
        </span>
        <span className="bento-demo-line mono">
          {prev !== null && "¥"}
          {formatPrice(prev)} → {curr !== null && "¥"}
          {formatPrice(curr)}
          <b
            className="bento-demo-delta"
            style={{ color: drop ? "var(--tone-green-text)" : "var(--tone-red-text)" }}
          >
            {drop ? "↓" : "↑"}
            {pct}%
          </b>
        </span>
      </div>
    );
  }
  if (kind === "monitor") {
    if (!buckets || buckets.length < 2 || !bucketSite) return null;
    return (
      <div className="bento-demo" aria-hidden>
        <span className="bento-demo-head">
          <span className="bento-demo-site">{bucketSite}</span>
          <span className="bento-demo-note">近 7 天探测</span>
        </span>
        <UptimeStrip buckets={buckets} />
      </div>
    );
  }
  // aim：折扣一眼看清 —— 真实行的输入/输出折扣条形（与总览表同一组件）
  if (!discount || (discount.input == null && discount.output == null)) return null;
  return (
    <div className="bento-demo bento-demo--disc" aria-hidden>
      <DiscountBars discount={discount} />
    </div>
  );
}

export default async function LandingPage() {
  const { overview, meta, feed, history, channelSummary, geo, rankings, catalog, homepages, popularity, error } = await loadLanding();
  // JSON-LD 里的站点地址要绝对 URL，与 metadataBase 同一推导方式
  const origin = await siteOrigin();
  const records = overview?.records ?? [];
  const sites = collectSites(overview, meta);
  // 首页榜单速览：基础模型去重后的 Top 5；数值条按榜首归一
  const rankingsTop = topBaseModels(rankings);
  const maxRankIndex = Math.max(0, ...rankingsTop.map((entry) => entry.intelligence_index ?? 0));
  // 站点价统一按 RMB 展示：汇率取厂厂商价快照标准
  const rate = overview?.catalog?.usd_cny_rate ?? null;
  // 最新事件侧栏与事件追踪页同一套折叠规则（同站同模型同类 120s 内折一张卡），
  // 原始事件按「站点+模型+分组」入库，不折叠会同模型并排出几条看起来一样的行；公告事件没有模型行，展示公告摘要
  const latestEventGroups = foldEvents(feed?.events ?? []).slice(0, LATEST_EVENTS_SHOWN);
  const historyRecords = history?.records ?? [];

  // 站点检测档案：可用率序列供星球悬停与行列表状态共用；
  // 阈值与详情页一致：可用率 80/60 三档，延迟 1000/3000ms 三档
  const summarySites = channelSummary.sites;
  // 站点质量序：按质量分从高到低——与 /overview 同一套权重（价格 35 / 渠道稳定 20 / 人气 30 /
  // 配置完整 10 / 公告新鲜 5，见 lib/siteRanking），停用站统一排最后；装配与排序函数与
  // /sites 全部站点页共用，两处顺序不会分叉。概览拉取失败时质量分为空表，
  // 排序自动退回名称序（orderSitesByQuality 对缺省分的定义）。
  // 下游三处共用这一份序：首屏胶囊轮播（前 HERO_TICKER_MAX 个）、站点卡墙（前 SITE_CARD_MAX 个）、示例卡随机池。
  const siteQuality = overview
    ? buildSiteQualityFromOverview(overview, channelSummary, popularity)
    : {};
  const orderedSites = orderSitesByQuality(
    sites.map((site) => ({ ...site, name: getSiteInfo(site.id, site.sourceUrl).name })),
    siteQuality,
  );
  const wallSites = orderedSites.slice(0, SITE_CARD_MAX);

  // 星球地图仍铺全部站点；每站的可用率取最新时段区块均值（uptimeBuckets 由服务端用抽稀前的
  // 全量序列分桶，均价不受「最差值降采样只留最差」影响），阈值与详情页同一套
  const globeSites: GlobeSite[] = orderedSites.map((site) => {
    const entry = summarySites[site.id];
    const siteBuckets = entry?.buckets ?? [];
    const latestBucket = siteBuckets[siteBuckets.length - 1];
    return {
      id: site.id,
      name: site.name,
      models: site.models,
      enabled: site.enabled,
      availability: latestBucket ? latestBucket.avg : null,
      down: entry?.down ?? 0,
      checks: entry?.checks ?? 0,
    };
  });
  // 首屏胶囊轮播只展示质量序前 10（最多 10 个；站点不足 10 个就全上）：
  // 不再把全部站点（含大量低可用率/待检测站）铺在首屏，避免看起来像一锅随机渠道；
  // 顺序每次刷新打乱（用户 2026-10-16 定「可以随机换顺序」），洗牌在服务端做（见 shuffled 注释）
  const tickerSites = shuffled(globeSites.slice(0, HERO_TICKER_MAX));

  // 首页代表行规则：每个模型归一合并后只留加权单价最低的一行，按目录发布日期倒序（新模型在前），
  // 与总览页模型下拉同一套规则；目录没收录的模型排在最后按名称
  const releaseByModel: Record<string, string> = {};
  for (const entry of Object.values(catalog?.models ?? {})) {
    if (entry?.model) releaseByModel[canonicalModel(entry.model)] = entry.release_date ?? "";
  }
  const parentRows = orderByReleaseDesc(lowestPriceRowPerModel(records, rate), releaseByModel);

  // bento 小卡微缩示例的数据（全部真实数据，缺席时对应示例不渲染）：
  // 调价 diff 取最近一条带新旧输入价的调价事件；探测色块每次刷新随机取一个有检测数据的站点；折扣取最新发布模型的行
  const demoEvent =
    (feed?.events ?? []).find(
      (event): event is EventRow =>
        !isNoticeEvent(event) && event.previous?.input_price != null && event.current?.input_price != null,
    ) ?? null;
  const demoEventSite = demoEvent
    ? getSiteInfo(demoEvent.site_id, demoEvent.current?.source_url ?? demoEvent.previous?.source_url).name
    : null;
  // 探测色块示例的随机池 = 质量序前 10 的启用站里有足够检测数据的（最多 10 个；站点不足就全上）：
  // force-dynamic 下每次请求重渲染，刷新即换示例
  const demoBucketCandidates = orderedSites
    .slice(0, HERO_TICKER_MAX)
    .filter((site) => site.enabled && (summarySites[site.id]?.buckets.length ?? 0) >= 2);
  const demoBucketSite = demoBucketCandidates[Math.floor(Math.random() * demoBucketCandidates.length)] ?? null;
  const demoBuckets = demoBucketSite ? (summarySites[demoBucketSite.id]?.buckets ?? null) : null;
  const demoBucketName = demoBucketSite?.name ?? null;
  const demoDiscount = parentRows[0]?.discount ?? null;

  // 快照表附加规则：站点三档状态点（与站点墙同一套）+ 数据新鲜度
  const siteLevelBySite: Record<string, RateLevel | null> = {};
  for (const site of sites) {
    const entry = summarySites[site.id];
    siteLevelBySite[site.id] = site.enabled && entry?.pct != null ? rateLevel(entry.pct) : null;
  }
  const snapshotAt = records.length > 0 ? Math.max(...records.map((row) => row.captured_at)) : null;

  return (
    <>
      {/* 结构化数据：站点身份 + 首页常见问题（内容与页面上 FaqList 同源，满足 FAQPage 可见性要求） */}
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "WebSite",
              name: site.name,
              url: origin,
              description: site.description,
              inLanguage: "zh-CN",
            },
            {
              "@type": "FAQPage",
              mainEntity: home.faq.map((item) => ({
                "@type": "Question",
                name: item.q,
                acceptedAnswer: { "@type": "Answer", text: item.a },
              })),
            },
          ],
        }}
      />
      <div className="page landing">
        <SectionRail />
        <HeroArea
          sites={globeSites}
          tickerSites={tickerSites}
          geo={geo}
          main={
            <>
              <h1 className="hero-title">
                <HeroType />
              </h1>
              <p className="hero-sub">{home.heroSub}</p>
              <div className="hero-actions">
                <Link href="/overview">
                  <Btn variant="primary" size="lg">
                    {home.heroButtons.primary}
                  </Btn>
                </Link>
                <Link href="/calculator">
                  <Btn size="lg">{home.heroButtons.secondary}</Btn>
                </Link>
              </div>
            </>
          }
        />

        {/* Bento 产品介绍：大卡 = 主价值 + 真实价格行预览（Apple 式文/视觉分栏），小卡 = 图标芯片 + 能力一句话 */}
        <Reveal>
          <section className="landing-section" id="sec-intro">
            <div className="bento-grid">
              <Link href="/overview" className="bento-card bento-card--feature">
                <div className="bento-copy">
                  <span className="bento-title">{home.introBento.main.title}</span>
                  <p className="bento-desc">{home.introBento.main.desc}</p>
                  <span className="landing-more">{home.introBento.main.cta}</span>
                </div>
                <div className="bento-visual" aria-hidden>
                  <div className="bento-mini-head">
                    <span>站点</span>
                    <span>模型</span>
                    <span>输入价 /M</span>
                  </div>
                  {parentRows.slice(0, 3).map((row) => {
                    const site = getSiteInfo(row.site_id, row.source_url);
                    const converted = toCnyPrice(row.input_price, row.unit, rate);
                    return (
                      <div key={`${row.site_id}:${row.model}`} className="bento-mini-row">
                        <span className="bento-mini-site">{site.name}</span>
                        <span className="mono bento-mini-model">{row.model}</span>
                        <span className="mono bento-mini-price">
                          {converted !== null ? "¥" : ""}
                          {formatPrice(converted ?? row.input_price)}
                        </span>
                      </div>
                    );
                  })}
                  <span className="bento-mini-src mono">llmprices.cn · 每行附来源链接 ↗</span>
                </div>
              </Link>
              {home.introBento.items.map((item) => {
                const Icon = BENTO_ICONS[item.icon];
                return (
                  <div key={item.title} className="bento-card">
                    <span className="bento-icon" aria-hidden>
                      <Icon size={20} />
                    </span>
                    <span className="bento-title">{item.title}</span>
                    <p className="bento-desc">{item.desc}</p>
                    <BentoDemo
                      kind={item.icon}
                      event={demoEvent}
                      eventSite={demoEventSite}
                      buckets={demoBuckets}
                      bucketSite={demoBucketName}
                      discount={demoDiscount}
                      rate={rate}
                    />
                  </div>
                );
              })}
            </div>
          </section>
        </Reveal>

        {records.length > 0 && (
          <Reveal>
            <section className="landing-section" id="sec-latest">
              <div className="landing-section-head">
                <div className="landing-section-title">
                  <h2>{home.sections.latestPrice}</h2>
                </div>
                <Link href="/overview" className="landing-more">
                  {home.viewAll}
                </Link>
              </div>
              <p className="landing-section-sub">{home.sectionSubs.latestPrice}</p>
              <SnapshotPreview
                rows={parentRows.slice(0, 12)}
                rate={rate}
                siteLevels={siteLevelBySite}
                snapshotAt={snapshotAt}
                siteHomepages={homepages}
              />
            </section>
          </Reveal>
        )}

        <Reveal>
          <section className="landing-section landing-duo" id="sec-trend">
            <div>
              <div className="landing-section-head">
                <div className="landing-section-title">
                  <h2>{home.sections.trend}</h2>
                </div>
              </div>
              <HeroTrendChart records={historyRecords} rate={rate} activeModels={[...new Set(records.map((r) => r.model))]} />
            </div>
            <div>
              <div className="landing-section-head">
                <h2>{home.sections.events}</h2>
                <Link href="/history" className="landing-more">
                  {home.viewAllEvents}
                </Link>
              </div>
              {latestEventGroups.length > 0 ? (
                <div className="landing-events">
                  {latestEventGroups.map((group, index) => {
                    const event = group[0];
                    const meta = eventMeta(event.kind);
                    const site = isNoticeEvent(event)
                      ? getSiteInfo(event.site_id)
                      : getSiteInfo(
                          event.site_id,
                          event.current?.source_url ?? event.previous?.source_url,
                        );
                    return (
                      <Link
                        key={`${event.site_id}:${event.kind}:${event.detected_at}:${index}`}
                        href="/history"
                        className="event-row"
                      >
                        <span className={`event-badge tone-${meta.tone}`}>
                          {meta.label}
                        </span>
                        <span className="event-main">
                          <span className="event-site">{site.name}</span>
                          <span className="event-sub">
                            {isNoticeEvent(event) ? (
                              <span title={noticeText(event)}>
                                {noticeText(event)}
                              </span>
                            ) : (
                              <span className="mono">{event.model}</span>
                            )}
                          </span>
                        </span>
                        <span className="event-time mono num">
                          {formatTime(event.detected_at)}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              ) : (
                <div className="landing-empty-compact">
                  <DajuYarn width={72} />
                  <span>{home.empty.events}</span>
                </div>
              )}
            </div>
          </section>
        </Reveal>

        {error && (
          <SiteAlert title={alerts.loadData.title} detail={error} fix={alerts.loadData.fix} />
        )}

        <Reveal>
          <section className="landing-section" id="sec-sites">
            <div className="landing-section-head">
              <div className="landing-section-title">
                <h2>{home.sections.sites}</h2>
              </div>
              <Link href="/sites" className="landing-more">
                {home.viewAll}
              </Link>
            </div>
            <p className="landing-section-sub">{home.sectionSubs.sites}</p>
            {sites.length > 0 ? (
              <div className="site-grid">
                  {wallSites.map((site) => {
                    const entry = summarySites[site.id];
                    const pct = site.enabled && entry?.pct != null ? entry.pct : null;
                    return (
                      <SiteCard
                        key={site.id}
                        id={site.id}
                        name={site.name}
                        enabled={site.enabled}
                        pct={pct}
                        checkedAt={entry?.at ?? null}
                        buckets={site.enabled ? (entry?.buckets ?? []) : []}
                      />
                    );
                  })}
                  {sites.length > wallSites.length && (
                    <Link href="/sites" className="site-card site-card--more">
                      <span className="site-card-more-label">
                        {home.sitesOverview.more(sites.length - wallSites.length)}
                      </span>
                    </Link>
                  )}
                </div>
            ) : (
              <div className="landing-empty">
                <DajuNap width={150} />
                <p>{home.empty.sites}</p>
              </div>
            )}
          </section>
        </Reveal>

        {rankingsTop.length > 0 && (
          <Reveal>
            <section className="landing-section" id="sec-rankings">
              <div className="landing-section-head">
                <div className="landing-section-title">
                  <h2>{home.sections.rankings}</h2>
                </div>
                <Link href="/rankings" className="landing-more">
                  完整榜单 →
                </Link>
              </div>
              <p className="landing-section-sub">{home.sectionSubs.rankings}</p>
              <div className="rank-list">
                <div className="rank-list-head" aria-hidden>
                  <span />
                  <span>模型</span>
                  <span>厂商</span>
                  <span>综合评分</span>
                </div>
                {rankingsTop.map((entry) => (
                  <Link key={entry.slug} href="/rankings" className="rank-row">
                    <span className="rank-row-no mono num">#{entry.rank}</span>
                    <span className="rank-row-name mono" title={entry.name}>
                      {entry.name.replace(/\s*\([^)]*\)$/, "")}
                    </span>
                    <span className="rank-row-creator">{entry.creator ?? "—"}</span>
                    <span className="rank-row-index mono num">
                      {entry.intelligence_index ?? "—"}
                      {entry.intelligence_index != null && maxRankIndex > 0 && (
                        <span
                          aria-hidden
                          className="rank-row-bar"
                          style={{
                            width: `${Math.round((entry.intelligence_index / maxRankIndex) * 100)}%`,
                          }}
                        />
                      )}
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          </Reveal>
        )}

        {/* 常见问题：全内容宽度铺开 */}
        <Reveal>
          <section className="landing-section" id="sec-faq">
            <div className="landing-section-head">
              <div className="landing-section-title">
                <h2>{home.sections.faq}</h2>
              </div>
            </div>
            <FaqList items={home.faq} />
          </section>
        </Reveal>

        <Reveal>
          <section className="landing-cta">
            <div className="landing-cta-art">
              <DajuChartNap width={300} />
            </div>
            <h2>{home.ctaTitle}</h2>
            <Link href="/overview">
              <Btn variant="primary" size="lg">
                进入中转站定价 →
              </Btn>
            </Link>
          </section>
        </Reveal>
      </div>
    </>
  );
}
