/** 与后端 llm_price_monitor 输出结构对应的类型定义。 */

/** 站点价折扣（/api/overview）：只下发前端要用的两个折扣值（折扣列/排序/中位数）；
 *  原币实付、官方参考价与折扣基准来源只在库里留档（后端 _DISCOUNT_ARCHIVE_ONLY_KEYS）。 */
export interface DiscountInfo {
  input: number | null;
  output: number | null;
}

/** 站点价记录的采集元数据：后端 metadata JSON 的已知字段（其余自由键原样透传）。 */
export interface PriceMetadata {
  group?: string;
  confidence?: number;
  notes?: string;
  /** base_times_rate 记录：实售价 = 基准价(USD) × rate */
  rate?: number;
  rate_source?: string;
  /** 缓存读/写价（写1h 为 1 小时有效期档）：与 input/output 同币种同计价单位，站点未提供时缺省 */
  cache_read_price?: number | null;
  cache_create_price?: number | null;
  cache_create_1h_price?: number | null;
  /** 订阅套餐行（pricing_kind=subscription）：套餐基础信息，定价页跨列渲染 */
  plan?: {
    /** 套餐售价（USD，已含站方折扣） */
    price_usd?: number;
    /** 配额额度（美元额度/周期） */
    quota_usd?: number | null;
    /** 买 1 美元额度实付（USD），越低越便宜 */
    per_quota_usd?: number | null;
    /** 有效期展示串（如 "1天"） */
    validity?: string | null;
    /** 所属分组名 */
    group?: string | null;
    /** 分组倍率 */
    group_ratio?: number | null;
    /** 未折价挂牌价（USD） */
    list_price_usd?: number | null;
    /** 站方折扣因子（如 0.9072 = 9.07 折） */
    final_price_factor?: number | null;
    /** 适用模型范围 */
    model_scopes?: string[] | null;
    /** 套餐描述 */
    description?: string | null;
  };
  [key: string]: unknown;
}

export interface PriceRecord {
  site_id: string;
  model: string;
  input_price: number | null;
  output_price: number | null;
  unit: string;
  price_status: string;
  requires_auth: boolean;
  status_reason?: string | null;
  /** 上次实际取到价的时间：本次采集没拿到数据、沿用上次价时由后端写入 */
  last_price_at?: number | null;
  source_url: string;
  captured_at: number;
  metadata?: PriceMetadata;
}

export interface OverviewRecord extends PriceRecord {
  discount: DiscountInfo | null;
}

/** 计算器页的站点价行：整包 overview 里计算器实际用到的字段，页面按此瘦身下发。
 *  别把整包 OverviewData 传给客户端组件——整份会内联进 HTML，体积差一个量级。 */
export interface CalcPriceRow {
  site_id: string;
  model: string;
  input_price: number | null;
  output_price: number | null;
  unit: string;
  /** 分组名：同站同名模型按分组各占一条候选，候选 value 靠它破重 */
  group: string;
  cache_read_price: number | null;
  cache_create_price: number | null;
}

/** 站点渠道摘要（后端 /api/status/summary）：列表页画站点卡与排序只用这些数字。
 *  完整可用率序列（每站几百点、全量约 1.7MB）与渠道行明细不随列表下发——需要完整视图走
 *  /api/status/views，站点详情页自己按站拉原始快照解析（要画点阵与延迟趋势）。 */
export interface SiteChannelSummaryEntry {
  /** 最新一个可用率点（0–100）；无检测记录为 null */
  pct: number | null;
  /** 该点的时间戳（秒级） */
  at: number | null;
  /** 各渠道近 24h 成功率均值（0–100）；无渠道数据为 null */
  success: number | null;
  /** 最新点里的异常渠道数（首页星球悬停用） */
  down: number;
  /** 近 7 天可用率点数（首页星球「已检测 N 次」用） */
  checks: number;
  /** 近 7 天时段色块：avg 画色块、count 参与排序加权；无数据的槽位为 null */
  buckets: (SummaryBucket | null)[];
}

/** 时段色块（摘要版）：相对完整 UptimeBucket 只留画色块与排序加权要用的两项。 */
export interface SummaryBucket {
  avg: number;
  count: number;
}

export interface SiteChannelSummary {
  sites: Record<string, SiteChannelSummaryEntry>;
}

interface CatalogMeta {
  enabled: boolean;
  generated_at?: number;
  generated_at_iso?: string;
  usd_cny_rate?: number;
  rate_source?: string;
}

export interface OverviewData {
  records: OverviewRecord[];
  catalog: CatalogMeta;
  /** 监控模型列表（管理台配置）：站点详情页渠道行的过滤基准（见 lib/channelStatus.ts） */
  monitor_models?: string[];
  /** 本轮价格采集异常的站点（公开下发，只含站点与状态）：价格表上方的提示条用它 */
  collect_alerts?: CollectAlert[];
  /** 各站点最新公告（每站一条；没采集到公告的站点无键） */
  notices?: Record<string, { excerpt: string; captured_at?: number | null }>;
  /** 各站点配置信息完整度（0–3）：监控模型、认证凭证、附加采集地址各 1 分；兼容用途，站点综合分走 site_flags */
  site_completeness?: Record<string, number>;
  /** 各站点配置标志（结构化）：站点综合分里「配置完整」一项的输入（见 lib/siteRanking） */
  site_flags?: Record<string, SiteFlags>;
}

/** 站点采集配置的布尔标志（后端 /api/overview 下发），逐项表示该项是否已配置。 */
export interface SiteFlags {
  /** 价格接口（network.url） */
  network: boolean;
  /** 渠道状态接口 */
  status: boolean;
  /** 公告源（显式配置；留空时后端会按价格地址推导） */
  notice: boolean;
  /** 附加价格接口 */
  networks: boolean;
  /** 认证续签配置 */
  token_refresh: boolean;
  /** 站点首页地址 */
  homepage: boolean;
  /** 站点是否启用采集 */
  enabled: boolean;
}

/** 本轮价格采集异常的站点（后端 /api/overview 的 collect_alerts）。
 *  后端库里那份逐站状态文档带原始错误文案，公开响应只透出站点与状态两类信息。 */
export interface CollectAlert {
  site_id: string;
  /** error = 本轮没抓到价，价格停在上一轮；auth_required = 需要登录授权才拿得到价 */
  status: "error" | "auth_required";
  /** 本轮检查时间（epoch 秒），没有就为 null */
  checked_at: number | null;
}

export interface EventRow {
  site_id: string;
  model: string;
  kind: string;
  detected_at: number;
  current?: PriceRecord | null;
  previous?: PriceRecord | null;
}

/** 趋势点（price_trend 精简列）：每次采集一条，供价格趋势图使用。 */
export interface TrendRecord {
  site_id: string;
  model: string;
  group?: string;
  input_price: number | null;
  output_price: number | null;
  unit: string;
  captured_at: number;
}

export interface HistoryListData {
  records: TrendRecord[];
  total: number;
  /** 展示汇率（USD→CNY，快照优先实时后备）；缺失时前端回落原币展示 */
  rate?: number;
}

/** 长上下文分档价档位：tier 是分档条件（models.dev 目前只有 context 阈值档，如 {type:"context", size:200000}）。 */
export interface PriceTier {
  input?: number | null;
  output?: number | null;
  cache_read?: number | null;
  tier?: { type?: string; size?: number } | null;
}

export interface CatalogEntry {
  found: boolean;
  model: string;
  /** models.dev 的展示名（如 Claude Sonnet 4.6） */
  name?: string;
  vendor: string;
  /** 厂商 logo 地址（models.dev 托管，仅全量渠道目录带；官方视图走本地内置 SVG） */
  logo?: string | null;
  currency: string;
  list?: { input?: number; output?: number };
  /** 快照汇率换算的人民币价（刷新时锁定），仅供展示 */
  list_cny?: { input?: number | null; output?: number | null };
  /** 缓存读/写价（USD/1M tokens）。models.dev 只覆盖部分模型，缺失为 null */
  cache?: { read?: number | null; write?: number | null };
  /** 缓存价的快照汇率人民币折算，规则与 list_cny 一致 */
  cache_cny?: { read?: number | null; write?: number | null };
  /** 长上下文分档价（USD/1M tokens，models.dev tiers 原结构）：prompt 超过阈值后整请求按该档计费；上游仅部分模型带 */
  list_tiers?: PriceTier[] | null;
  /** 分档价的快照汇率人民币折算，规则同 list_cny */
  list_tiers_cny?: PriceTier[] | null;
  /** 音频输入/输出价（USD/1M tokens）；仅音频模型带，缺失为 null */
  list_audio?: { input?: number | null; output?: number | null } | null;
  /** 音频价的快照汇率人民币折算，规则同 list_cny */
  list_audio_cny?: { input?: number | null; output?: number | null } | null;
  source_url?: string;
  description?: string;
  /** 简介的中文翻译（AI 随目录同步翻译；AI 未配置或未轮到时为空，回落英文原文） */
  description_zh?: string | null;
  /** 简介来源标记：ai=按模型名生成的 AI 简介（界面带「AI」标）；缺省为 models.dev 简介或定价页原文 */
  desc_source?: string | null;
  /** models.dev 的产品线家族（如 gpt-astra / claude-opus） */
  family?: string;
  /** 模态（models.dev 原始结构） */
  modalities?: { input?: string[]; output?: string[] };
  /** 厂商标称的 token 上限：上下文窗口与其中输入/输出的上限 */
  limit?: { context?: number; input?: number; output?: number };
  /** models.dev 的发布日期（YYYY-MM-DD，可能为 null）：全量表展示，监控清单选项按它新→旧排 */
  release_date?: string | null;
  /** 官方价基准规则：cn=国内站官方价（厂商定价源或 -cn 渠道），global=国际站官方价 */
  region?: "cn" | "global";
  /** 同厂商国际站的列表价参考（国内基准确立后保留），规则同 list */
  list_global?: { input?: number; output?: number };
  /** 国际参考价的快照汇率人民币折算，规则同 list_cny */
  list_global_cny?: { input?: number | null; output?: number | null };
}

export interface CatalogData {
  generated_at_iso: string;
  /** 数据来源标识与主页链接，恒为 models.dev */
  source: string;
  source_url?: string;
  usd_cny_rate: number;
  rate_source: string;
  models: Record<string, CatalogEntry>;
}

/** AA 榜单单行（Artificial Analysis /leaderboards/models 的一行数据）。 */
export interface RankingEntry {
  /** 行序即排名（按综合评分降序，变体行各占一行） */
  rank: number;
  /** AA 的模型 slug（如 gpt-6-5-sol），变体带 -xhigh/-low 后缀 */
  slug: string;
  /** slug 与展示名归一化后的匹配键；后端 rankings_key 同一套规则 */
  key: string;
  name: string;
  creator: string | null;
  /** 厂商标称写法（1M / 872k），保留 AA 原文 */
  context_window: string | null;
  /** Artificial Analysis Intelligence Index；榜单未测为 null */
  intelligence_index: number | null;
  /** AA 的复合任务成本（USD），规则与每百万 token 价不同，仅展示 */
  cost_per_task_usd: number | null;
  median_output_tokens_per_second: number | null;
  latency_first_chunk_seconds: number | null;
  total_response_seconds: number | null;
  url: string;
}

export interface RankingsData {
  generated_at: number;
  generated_at_iso: string;
  source: string;
  source_url: string;
  models: RankingEntry[];
  /** 服务端分页附加字段：全量条数、q 过滤后条数（分页器用）、评测厂商数 */
  total?: number;
  filtered_total?: number;
  creator_total?: number;
}

/** 新站发现：自动收录的候选中转站清单（站点、简介与监测站自家监控指标）。
 *  监控判离线的站不进列表；uptime_7d/avg_ms/last_ms 缺失表示监测源没有该站数据。 */
export interface DiscoveryStation {
  host: string;
  name: string;
  url: string;
  sources: string[];
  description: string;
  /** 7 天可用率（%），监测源自家数据 */
  uptime_7d: number | null;
  /** 平均响应 / 最新响应（毫秒） */
  avg_ms: number | null;
  last_ms: number | null;
  checked_at: string | null;
  imported_id: string | null;
  /** 标记「忽略」：灰显沉底，不再进待导入清单 */
  ignored: boolean;
  /** 忽略原因（可选，标记时填写） */
  ignore_reason: string | null;
}

export interface DiscoveryData {
  generated_at: string;
  summary: { total: number; offline: number; imported: number; ignored: number };
  stations: DiscoveryStation[];
  /** 服务端分页附加字段：收录总数、筛选后条数（分页器用） */
  total?: number;
  filtered_total?: number;
}

export interface SiteMeta {
  id: string;
  models: string[];
  url?: string;
  enabled: boolean;
}

export interface MetaData {
  sites: SiteMeta[];
  is_admin: boolean;
  /** true = 数据库还没有管理员账号，需要先走 /setup 首次设置 */
  needs_setup: boolean;
}

/** 附加采集地址（networks 数组项），与 network 同构。 */
interface NetworkEndpoint {
  url?: string | null;
  params?: Record<string, string>;
  headers?: Record<string, string>;
}

/** 站点完整配置（与 config/default-seed.json 的 sites 段同构，存储于 SQLite sites 表）。 */
export interface SiteConfig {
  id: string;
  /** 已废弃：目标模型统一在 settings.monitor_models（站点管理页顶部）配置 */
  models?: string[];
  auth_token?: string | null;
  network?: {
    url?: string | null;
    /** 倍率接口：返回 {pricing: [{provider, model_display, rate}]}，基准价 × rate 折算实售价。
     *  两种形态兼容：纯地址字符串（旧），或 {url, headers} 对象（倍率接口要专用请求头时）。 */
    ratio_url?: string | { url: string; headers?: Record<string, string> } | null;
    params?: Record<string, string>;
    headers?: Record<string, string>;
    /** 网页模式·Headless：开启后用 Headless 浏览器打开网页渲染，Cookie/localStorage 登录态一并注入；关闭则纯接口请求 */
    headless?: {
      enabled?: boolean;
      /** 注入的 Cookie；每项只需 name/value，domain/path 由后端按站点 URL 域名自动补 */
      cookies?: { name: string; value: string }[];
      /** 注入的 localStorage 键值 */
      localStorage?: Record<string, string>;
      /** 页面加载后等待秒数（0~60），默认 3 */
      wait_seconds?: number;
    } | null;
  } | null;
  networks?: NetworkEndpoint[];
  /** 渠道状态数据地址：每次采集顺带 GET 并存档，变化写入状态事件；groups 是站点级分组白名单，价格采集与状态检测共用 */
  status?: {
    url?: string | null;
    params?: Record<string, string>;
    headers?: Record<string, string>;
    groups?: string[];
  } | null;
  /** 站点公告地址：默认从 network.url 推导 /api/notice；也可指向纯文本/Markdown 公告页 */
  notice?: { url?: string | null; params?: Record<string, string>; headers?: Record<string, string> } | null;
  request_headers?: Record<string, string> | null;
  /** 认证续签：token 失效时调用该接口换新 token 并自动回写配置 */
  token_refresh?: {
    url: string;
    method?: string;
    params?: Record<string, string>;
    headers?: Record<string, string>;
    /** 请求体模板，${refresh_token} 会替换成下面的 refresh_token */
    body?: string;
    /** 响应数据结构案例：保存时交给 AI 分析出 token 字段路径，不写库 */
    response_sample?: string;
    /** 响应里 token 的字段路径（如 data.access_token）；留空自动探测 data.access_token / access_token */
    access_token_field?: string;
    refresh_token_field?: string;
    /** 轮换 Cookie 名（如 new_api_refresh）：这类站点旧凭据一次有效、新值只在响应 Set-Cookie 里，续签后自动接力 */
    refresh_cookie_name?: string;
    refresh_token: string;
  } | null;
  /** 凭证注入：把认证与续签里的 token 塞进价格/渠道状态/公告三处请求，一条规则 = 头名 + 值模板。
   *  值里可用 ${access_token} / ${refresh_token}，续签换新后自动展开成新值；
   *  头名填 cookie 就是塞进 Cookie（如值 new_api_refresh=${refresh_token}）。没配的处不注入。 */
  auth_inject?: Record<string, { header?: string; value?: string } | null> | null;
  /** 站点首页地址（选填）：截站点截图时打开的页面；留空按采集地址推导。
   *  采集入口在 API 子域、根路径不是可看页面时（如 4aicode）填这里 */
  homepage?: string | null;
  /** 后端保存时始终写库（slim_site_config 保留该字段），可放心用于行内启用判断 */
  enabled: boolean;
  [key: string]: unknown;
}

export interface SitesData {
  sites: SiteConfig[];
  /** 站点 id → 三类采集各自的最近一次异常（正常时对应节不存在） */
  site_health?: Record<string, SiteCollectHealth>;
}

/** 一类采集最近一次的异常：报错红、需认证/无数据黄；下一轮采集正常即清除。 */
export interface SiteCollectIssue {
  level: "error" | "warn";
  message: string;
  time: number;
}

/** 站点采集健康档案：price/status/notice 三个可缺省的异常节。 */
export type SiteCollectHealth = Partial<Record<"price" | "status" | "notice", SiteCollectIssue>>;

/** 系统设置文档：settings/ai 两段，键名与配置文件一致。 */
export interface SettingsData {
  settings: Record<string, unknown>;
  ai: Record<string, unknown>;
}

/** 厂商定价页抓到的单个模型价格（page-price 输出，价格按页面标价币种）。 */
export interface VendorSourceModel {
  model: string;
  model_key: string;
  input_price?: number | null;
  output_price?: number | null;
  cache_read_price?: number | null;
  currency?: string | null;
  unit?: string;
  /** 同模型多档价格：AI 抽取带 name（如 高峰时段/空闲时段，含时段定义），静态解析带 context（上下文档位）；第一项为基准档 */
  tiers?: { name?: string | null; context?: string | null; input_price?: number; output_price?: number }[];
  source_url?: string;
  quote?: string;
  /** ai 来源的价格为 candidate（待复核），静态解析无此字段 */
  price_status?: string;
}

/** 管理台「厂商定价源」：一个厂商的公开定价页配置与最近抓取状态。 */
export interface VendorPricingSource {
  vendor: string;
  url: string;
  enabled: boolean;
  /** 区域：cn=国内折扣基准 / global=国际参考价；存量记录缺省按国内处理 */
  region?: "cn" | "global";
  last_fetched_at?: number | null;
  last_status?: "ok" | "empty" | "failed" | null;
  last_error?: string | null;
  /** 抓取方式：static-md / static-html / static-json / headless-* / ai */
  last_method?: string | null;
  model_count?: number | null;
  /** 源描述：覆盖检测行与源表格展示用（种子/新增时写入） */
  note?: string | null;
  /** 仅详情接口返回；列表接口不带 */
  models?: VendorSourceModel[] | null;
}

/** models.dev 对国内厂商国内价的覆盖检测记录。 */
export interface VendorSourceDetection {
  vendor: string;
  /** has_cn=已覆盖 / missing_cn=仅国际标准（推荐添加）/ not_listed=未收录（推荐添加） */
  verdict: "has_cn" | "missing_cn" | "not_listed";
  providers: string[];
  models_total: number;
  models_priced: number;
  /** 推荐采集地址（人工核验过），kind=web 网页页 / json 价格接口；一键添加时预填 */
  suggestions?: { kind: "web" | "json"; url: string }[];
  note?: string;
  /** 已配置源自己的描述（种子/新增时写入）；空则回落到 note */
  source_note?: string | null;
  source_added: boolean;
  source_enabled?: boolean | null;
}

export interface TasksData {
  tasks: TaskInfo[];
}

export interface TaskInfo {
  id: string;
  kind: string;
  status: "running" | "done" | "failed";
  started_at: number;
  finished_at: number | null;
  result?: { [key: string]: unknown };
  error?: string | null;
  /** 列表接口只带日志行数；完整日志经 /api/tasks/{id} 详情获取。 */
  log_count?: number;
  /** 日志中 level=error 的行数与最后一条错误内容，供列表行内提示。 */
  error_count?: number;
  error_summary?: string | null;
}

/** 任务过程日志行：level=error 在界面标红。 */
interface TaskLog {
  time: number;
  message: string;
  level: "info" | "error";
}

export interface TaskDetail extends TaskInfo {
  logs: TaskLog[];
}

/** 概览页「采集异常」卡片条目：跨任务汇总的警告/错误日志行（独立流水持久化，重启后仍在）。
 *  同站点同类问题按归一键合并为一条：time 为最近一次，count 为累计次数，first_time 为首见。 */
export interface TaskErrorEntry {
  key: string;
  task_id: string;
  kind: string;
  time: number | null;
  level: "warn" | "error";
  message: string;
  count?: number;
  first_time?: number | null;
}

export interface TaskErrorsData {
  entries: TaskErrorEntry[];
}

/** 渠道状态快照（后端 fetch_site_status 输出；data 为站点自有结构的自由 JSON）。 */
export interface StatusSnapshot {
  site_id: string;
  captured_at: number;
  source_url: string;
  http_status: number;
  parse: string;
  data: unknown;
}

/** 站点公告版本（后端 fetch_site_notice 输出；content 为公告正文 Markdown/纯文本，仅内容变化时新增）。 */
export interface NoticeSnapshot {
  site_id: string;
  captured_at: number;
  source_url: string;
  http_status: number;
  parse: string;
  content: string;
}

/** 站点公告事件：首次建档（notice_init）或内容更新（notice_changed）。 */
export interface NoticeEvent {
  site_id: string;
  kind: string;
  detected_at: number;
  /** 公告正文摘要（与 noticeExcerpt 同一套规则）：列表侧只渲染它，正文不随列表下发 */
  excerpt?: string;
  /** 公告正文原文：列表接口已不下发（一份十几 KB），仅按需取详情时才有 */
  content?: string;
}

/** 事件流条目：价格事件（带模型与前后价格）或公告事件（带公告正文）。 */
export type FeedEvent = EventRow | NoticeEvent;

/** /api/feed：价格事件与公告事件按时间合并的统一事件流 */
export interface FeedData {
  events: FeedEvent[];
  /** 价格事件全量总数（events 可能被 limit 截断，计数用它才准确） */
  price_total: number;
  /** 公告事件全量总数 */
  notice_total: number;
}

/** 单条页面访问记录（后端 visit_logs 表，/api/analytics/logs 输出）。 */
export interface VisitLog {
  ts: number;
  path: string;
  ip: string;
  user_agent: string;
  browser: string;
  os: string;
  device: string;
}

export interface VisitLogsData {
  visits: VisitLog[];
  total: number;
}

/** 访问统计聚合（/api/analytics/summary 输出；分布与榜单取近 30 天窗口）。 */
export interface AnalyticsSummary {
  today_pv: number;
  today_uv: number;
  total_pv: number;
  total_ip: number;
  daily: { day: string; pv: number; uv: number }[];
  devices: { name: string; pv: number }[];
  browsers: { name: string; pv: number }[];
  oses: { name: string; pv: number }[];
  top_paths: { path: string; pv: number; uv: number }[];
  top_ips: { ip: string; pv: number; last_seen: number }[];
  /** 近 30 天按国家聚合的访问分布（中文名，匹配世界地图；"未知"为解析失败）。 */
  regions: { name: string; pv: number; uv: number }[];
  retained_days: number;
}

/** AI 调用按天聚合点（/api/ai-logs/summary 的 daily 项；fallback/param_retry 是同一请求里的失败尝试）。 */
export interface AiLogDailyPoint {
  day: string;
  ok: number;
  fallback: number;
  param_retry: number;
  /** 连接抖动（超时/SSL 断开等未收到响应）：不算成功也不算失败 */
  transport: number;
  error: number;
  prompt_tokens: number;
  completion_tokens: number;
}

/** AI 调用统计（/api/ai-logs/summary 输出；范围为当前保留的全部调用尝试）。 */
export interface AiLogSummary {
  total: number;
  /** 成功率（%）：ok / (total - transport - ignored)，报错重试计入失败，连接抖动与已忽略报错组不计入；无记录时为 null */
  success_rate: number | null;
  ok: number;
  fallback: number;
  param_retry: number;
  transport: number;
  error: number;
  /** 「报错判定」勾成不算失败的报错组涉及的尝试条数：不计失败、不进成功率分母 */
  ignored: number;
  /** 历史报错按形态自动归组：key 为分组键（存 settings.ai_ignored_errors），sample 为报错开头原文 */
  error_kinds: { key: string; count: number; sample: string; ignored: boolean }[];
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  avg_duration_ms: number;
  daily: AiLogDailyPoint[];
  scenes: { name: string; calls: number }[];
  models: { name: string; calls: number }[];
}
