/**
 * 站点文案集中地：面向用户的文字都放在这里，想改措辞只改这个文件。
 * 按页面/区域分组；改完保存即可生效，不涉及任何逻辑。
 * 管理面板（/admin）内部的提示文案暂未抽离。
 */

/** 品牌与站点级描述（浏览器标签、搜索结果、分享摘要） */
export const site = {
  /** 品牌展示名即域名，全站统一用英文字体呈现 */
  name: "llmprices.cn",
  title: "llmprices.cn — 中转站价格逐条可溯源",
  description:
    "哪个中转站价格更低、服务更稳？每条数据都附来源链接，点开就能核对。",
};

/** 顶部导航 */
export const nav = {
  items: [
    { key: "/", label: "首页" },
    { key: "/overview", label: "模型数据" },
    { key: "/catalog", label: "厂商数据" },
    { key: "/discover", label: "发现" },
    { key: "/calculator", label: "价格计算" },
  ],
  adminLabel: "工作台",
  theme: {
    light: { label: "浅色", title: "浅色模式" },
    dark: { label: "深色", title: "深色模式" },
    system: { label: "系统", title: "跟随系统" },
  },
};

/** Bento 小卡图标键：与首页 BENTO_ICONS 映射（components/icons.tsx 的导出名）一一对应，
 *  加新键必须两边同步，类型约束让漏改在编译期报错而不是渲染期崩页面 */
export type BentoIconKey = "sync" | "monitor" | "aim";

/** 首页 */
export const home = {
  /** Hero 大标题静态两行，第二行开头两个字走品牌色（见 components/HeroType.tsx） */
  typeLines: ["中转站", "价格逐条可溯源"],
  heroSub:
    "自己用的中转站，是不是时不时就不能用？想找个靠谱的，先来对照各家价格和渠道状态。我们不偏向任何中转站，只把数据摆给你看；使用需谨慎，Token 少充值。",
  heroButtons: {
    primary: "进入中转站定价 →",
    secondary: "算一笔花费 →",
  },
  sections: {
    latestPrice: "最新价格",
    trend: "价格走势",
    events: "最新事件",
    sites: "检测中的站点",
    rankings: "模型榜单速览",
    faq: "常见问题",
  },
  sectionSubs: {
    latestPrice:
      "每个模型只展示检测站点里的最低价，每条都附来源链接，点开就能核对",
    sites: "每个站点的渠道检测与公告我们都自动存档，点站点名就能进检测档案",
    rankings:
      "第三方评测的智能指数前五名，判断模型能力档位时拿它做参考",
  },
  /** Bento 产品介绍：1 大（主价值 + 真实价格行预览，可点）+ 3 小（图标芯片 + 能力一句话）；
   *  icon 是 components/icons.tsx 的导出名键 */
  introBento: {
    main: {
      title: "每条价格，逐条可溯源",
      desc: "每条价格都附来源链接，点开就是站点当时的价目页，随时自己核对；我们只记录，不修改。",
      cta: "去看最新价格 →",
    },
    items: [
      {
        icon: "sync",
        title: "调价第一时间留档",
        desc: "哪家涨价了、哪家降价了，一变就记成事件，新价旧价、变化时间都在记录里。",
      },
      {
        icon: "monitor",
        title: "渠道自动探测",
        desc: "几分钟一轮自动探测各家渠道，能不能用、延迟多少，正常异常都有记录。",
      },
      {
        icon: "aim",
        title: "折扣一眼看清",
        desc: "厂商官方定价摆在旁边，中转站标价折到几折，不用自己按计算器。",
      },
    ] satisfies { icon: BentoIconKey; title: string; desc: string }[],
  },
  viewAll: "查看全部 →",
  viewAllEvents: "全部事件 →",
  submitSite: "提交站点，加入检测",
  submitSiteDesc: "加企业微信客服，把站点发给我们，核验通过后就开始检测。",
  empty: {
    events: "还没有事件记录。",
    sites: "还没有站点数据。",
    siteNoCheckRecord: "暂无渠道检测记录",
    siteDisabled: "已停用",
  },
  sitesOverview: {
    more: (n: number) => `还有 ${n} 个站点 →`,
  },

  faq: [
    {
      q: "价格数据准确吗？",
      a: "每条价格都附来源链接，点开就能看到站点当前标价；我们只记录，不修改。",
    },
    {
      q: "多久更新一次？",
      a: "价格和公告我们定时去抓，渠道状态几分钟探测一轮；历史记录全部留档，随时可查。",
    },
    {
      q: "会推荐用哪个中转站吗？",
      a: "不会。我们只提供价格、公告和可用性的对照数据，选哪家由你自己判断。",
    },
    {
      q: "标价就是我要付的钱吗？",
      a: "不一定。价格表里的单价是站点公开标价，实际账单还受缓存命中率和各家计费口径影响，可能和按标价算出来的数字有不小出入。建议先小额充值试跑，确认账单符合预期再加量。",
    },
    {
      q: "想让我的站点也被检测怎么办？",
      a: "点首页「提交站点，加入检测」，把站点地址填给我们，核验通过后就接入。",
    },
  ],
  ctaTitle: "选中转站，先看数据。",
};

/** 花费计算页 */
export const calculator = {
  source: {
    official: "厂商官方价",
    site: "中转站价",
  },
  siteLabel: "选站点",
  sitePlaceholder: "先选一个中转站",
  modelPlaceholder: "搜索或选一个模型",
  /** 厂商分组节头的「更多」按钮，括号里是被折叠的模型数 */
  moreModels: (count: number) => `更多 ${count} 个`,
  lessModels: "收起",
  buckets: {
    input: "输入",
    output: "输出",
    cacheRead: "缓存读取",
    cacheWrite: "缓存写入",
  },
  priceTitle: "单价 · 每 1M token",
  usageTotal: "用量",
  /** 总用量下拉框的字段标签 */
  usageSelect: "总用量",
  /** 总用量快捷档位标签，与 lib/calculator.ts 的 TOKEN_PRESET_VALUES 按序对应 */
  tokenPresets: ["10M", "100M", "1B"],
  hitRate: "缓存命中率",
  /** 用量区输入框标签：输出占总用量的百分比 */
  outputShare: "输出占比",
  /** 字段悬停说明（正文区不再放长段落）：两个比率各管哪段 token */
  usageHint:
    "输出占比决定多少 token 记在输出，其余记在输入；缓存命中率决定输入里多少从缓存读取。",
  /** 缓存两档在各家账单里的别名——叫法不统一，列出来免得对不上号 */
  bucketAlias:
    "缓存读取＝命中缓存（也叫缓存命中 / cached tokens）；缓存写入＝首次写入缓存（也叫缓存创建 / cache creation）。",
  /** 字段悬停说明：默认值为什么这么给、不同用法怎么调，免得用户把默认值当权威值照抄 */
  sourceNote:
    "默认按「反复带同一段前缀的会话式用法」给（一份公开的 Claude Code 实测样本约 0.44%、命中率 96–97%，这里取整略放宽）。完全没走缓存的普通问答，把命中率改成 0、输出占比调到 20 上下；长文分析、写代码这类回答短、喂进去的长的用法，输出占比再往下调。",
  resultTitle: "花费结果",
  totalLabel: "合计",
  emptyResult: "填好单价和用量，这里就会显示花费。",
  missingCache:
    "没查到缓存读取单价，从缓存读取的 token 没计入总价；知道单价的话在上面补一格。",
  /** 输入档用量为 0 时的悬停说明：解释钱记到了哪一行，免得看着像漏算 */
  inputMovedToCacheWrite:
    "输入这里显示 0，是因为填了缓存命中率：没命中的那部分输入要首次写入缓存，钱记在「缓存写入」那一行，同一批 token 不会收两次。想让输入档有数，把命中率改成 0。",
  detail: {
    bucket: "计费项",
    unitPrice: "单价",
    tokens: "用量",
    subtotal: "小计",
    /** 占的是费用（各档小计占总花费），不是 token 用量，列名直接挑明 */
    share: "费用占比",
  },
  copyLink: "复制分享链接",
  copied: "链接已复制，发给别人，打开看到的就是你算的这笔账。",
  loadFailed: {
    title: "暂时读不到价格数据",
    fix: "计算器还没拿到厂商定价或最新价格：请稍后刷新重试；管理员可在后台「采集任务」页点「刷新厂商定价」。",
  },
};

/** 页面加载失败的提示条（SiteAlert） */
export const alerts = {
  loadData: {
    title: "暂时读不到数据",
    fix: "请稍后刷新重试；若持续出现，欢迎通过页脚「提建议」告诉我们。",
  },
  catalog: {
    title: "无法读取厂商定价",
    fix: "请稍后刷新重试；若持续出现，欢迎通过页脚「提建议」告诉我们。",
  },
  rankings: {
    title: "暂时读不到模型榜单",
    fix: "请稍后刷新重试；若持续出现，欢迎通过页脚「提建议」告诉我们。",
  },
  discovery: {
    title: "新站清单还没生成",
    fix: "管理员在「站点管理 → 导入站点 → 从新站发现导入」里点「刷新发现」后，这里会列出收录的中转站。",
  },
};

/** 模型数据页（/overview）表前的风险提示：试水建议 + 榜单口径 + 消费免责。
 *  用户 2026-10-13 定：这三条只在这一页展示，不铺到其他页面；改措辞只改这里。
 *  写法按 docs/ai-collab.md 的口径来：说人话、给下一步动作，别写成书面告示。 */
export const risk = {
  title: "充值前，先看这三句",
  /** 一段一条，分三行渲染，顺序即重要度 */
  lines: [
    "第一次用哪家，先充最小额度试试能不能正常用，再加量。",
    "排名高是综合情况决定的，不代表站点稳；没有渠道状态的连好坏都看不出，优先选有的。",
    "我们只做数据展示，不参与交易，充值、退费都跟我们无关，选哪家自己定。",
  ],
};

/** 对外联系邮箱：页脚 mailto 用 */
export const CONTACT_EMAIL = "service@llmprices.cn";

/** 企业微信客服链接：访客「提建议」「提交站点」都直接打开这里对话（微信客服，手机扫码/电脑直接聊）。
 *  改客服在「企业微信 → 微信客服」后台重新获取即可。 */
export const CONTACT_WECOM_URL = "https://work.weixin.qq.com/kfid/kfc554611547f3878a8";

/** 页脚 */
export const footer = {
  brandLine:
    "我们检测各家 API 中转站的价格、渠道状态和公告，数据都抓自各站点公开页面，仅供使用参考，不构成任何使用推荐。\n最后祝大家 Vibe Coding 之路畅通无阻，永远用到低价不降智模型，天天 Happy.",
  links: {
    history: "事件追踪",
    articles: "文章资讯",
    feedback: "提建议",
  },
  aria: {
    github: "GitHub 仓库",
    mail: "邮件联系",
  },
  /** 企业微信二维码：直接平铺在页脚右列（企业联系人名片码，非客服），替换 web/public/wecom-qr.png 即可生效 */
  wecomQrSrc: "/wecom-qr.png",
  /** 客服入口的固定说法：页脚二维码旁、各处「找客服」文案共用 */
  wecomContact: "企业微信客服",
};

/** 分享图 */
export const share = {
  /** 分享图品牌头上的简介 */
  brandDesc:
    "哪个中转站价格更低、服务更稳？每条数据都附来源链接，点开就能核对。",
};
