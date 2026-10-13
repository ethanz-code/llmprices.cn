# 站点导入与配置手册

> 回答三个问题：站点怎么进来、进来后怎么配、配什么不配什么（渠道筛选口径）。字段级技术细节见 [pricing.md](pricing.md)「配置文件」；动手前先翻 [lessons.md](lessons.md) 触发词索引与 Serena 记忆 `dom_url_auth_constraint`。

## 导入站点的三条路

都在管理台 `/admin/sites` 页面：

| 入口 | 适用场景 | 流程 |
| --- | --- | --- |
| 从新站发现导入 | 有候选清单时首选 | 「导入站点」弹窗 → 从新站发现导入，勾选自动收录的候选站点一键导入。发现清单来自 `price-discover`（公开聚合源拉候选 + 探测可导入性），公开页 `/discover` 也能浏览。不想要的候选点「忽略」：灰显沉底、不再出现在待导入清单（标记存档，每日刷新不会翻出来，「全部」页签可恢复）；已监控的站忽略时会连带从站点管理删除（含历史数据，有确认弹窗） |
| 手工新增站点 | 已知站点与接口地址 | 「新增站点」→ 最少填 id + 价格接口地址（`network.url`）→ 保存 |
| 从文件导入 | 整份迁移 / 备份恢复 | 「导入站点」→ 从文件导入，上传站点配置 JSON，同名站点逐个确认冲突；「导出站点」反向导出（**含登录凭证**，文件妥善保管）|

「批量管理」显示勾选列，可批量删除、只导出所选。保存即写 SQLite `var/monitor.db` 立即生效；`config/default-seed.json` 只在空库首次启动时作种子导入，日常配置一律走管理面板。

## 编辑站点怎么下手

站点行的「编辑」进编辑弹窗：主弹窗管基本信息与采集地址，子弹窗按需进（认证与续签 / 网页模式 / 倍率 / 渠道状态 / 公告 / 高级 JSON），子弹窗写回草稿、主弹窗统一保存。常见场景对照：

- 接口要登录 → 「认证与续签」（auth_token / auth_inject / token_refresh；new-api 会话模板按采集地址自动带出，贴 Refresh Token 后点「测试续签」验证）
- 页面是 JS 渲染的空壳 → 「网页模式」（`network.headless`，无头浏览器渲染后再解析）
- 要盯渠道可用性、站内公告 → 「渠道状态」「公告」各自子弹窗，new-api 系默认地址自动推断
- 采集被墙/超时 → 「系统设置 → 采集出口」配备用代理

**模型清单不分站点**：站点级 `models` 字段已废弃（加载时静默丢弃），监控哪些模型由页面顶部「检测模型」统一配置（`settings.monitor_models`），所有站点共用一份。目录刷新自动补各厂商最新发布的模型、发布超 3 个月的自动移出、手动删过的不回加；通配符 `*` 全量采集已移除，只收明确清单。站点没有清单里的模型只是提示「没采到价」，不是故障。

## 渠道筛选口径（只采官方共享渠道）

监控对象是**站点自己对外售卖的共享渠道模型**——普通访客充钱就能用、按站点标价计费的那些。三类渠道区别对待：

| 渠道类型 | 采不采 | 识别特征 |
| --- | --- | --- |
| 站点自营 / 官方共享 | ✅ 采 | new-api 系常规价格接口默认就是自营渠道；市场型站点选官方共享订阅源（如 subrouter 的 `source=shared_subscription`）|
| 用户上传 key 的经销商渠道 | ❌ 不采 | subrouter 的 `source=self`；价格是上传者自定，不代表站点官方售价 |
| 挂官方名但无实际供货的空壳 | ❌ 不采 | subrouter 的 `source=official`（official-channels 页）；特征：已供货模型 0（如 0/32）、可用 Key 0、供货商家 0、最近最低价/最高允许价「不限 · 不限」|

落点在**采集地址**，不是模型清单：接口自带渠道过滤参数的，把参数固化进 `network.url`（subrouter 现配置即范例：`/api/marketplace/shared-models?…&source=shared_subscription`）；接口不支持过滤的市场站，只采官方渠道确实在售、且在检测模型清单里的模型，市场渠道独占的模型不加进清单。

## 公告与渠道状态怎么配（与价格同周期顺带采集）

公告和渠道状态跟着同一次采集顺带执行，配站点时**两样都尽量配上**。字段细节见 [pricing.md](pricing.md)，这里讲「什么时候配什么」。

**公告（notice）**：

- new-api 系零配置也能跑：未配 `notice.url` 时自动从 `network.url` 根地址推导 `/api/notice`，并自动请求 `/api/status` 把后台「公告管理」发布的多条 announcements 拼成分节 Markdown 合并进正文。
- **配法口径（2026-10-09 修订，推翻 10-08 旧拍板）**：**哪个接口承载站的真公告就配哪个**——new-api 站的公告板（`/api/status` 的 announcements）通常是主公告源且更明确（cun 板上 16 条完整版 vs `/api/notice` 57 字节一句话；modelflare 的 `/api/notice` 是静态欢迎页；subrouter 的为空），这类站显式配 `/api/status`；少数站板上无货、`/api/notice` 手写位才是真公告（123ai-ai-wx 等批站），则配 `/api/notice`。**配之前两个接口都拉一次看内容，别按站族套公式**。显式配 `/api/notice` 时解析层仍会自动拼 `/api/status` 的公告板进正文（json+status），显式配 `/api/status` 只拿公告板（但板上就是主源时这正好）。零配置虽等价于显式 `/api/notice`，按「填什么抓什么」原则统一显式写。
- 其余显式场景：① 标准路径不存在或自研路径 → 配实际公告接口（`data` 直接是公告数组、`announcements` 挂顶层、`data` 为单条公告对象（302.ai 型）这三种形态都能解析；公告数组条目的正文字段 `content` 与 `description`（01tree 型）都认）；② 公告接口要登录 → 显式配 + 认证（`auth_inject` 的 notice 腿或 `notice.headers`）。**公告抓回来是空的先查两处再怪站方**：接口 401（腿没配认证）与正文键对不上（01tree 实锤：description 被当无正文整批过滤，扫描零报错零记录，只能主动干跑一单站才发现）。
- 正文变化才存新版本发事件，正文为空不入库；显式配置的地址 404 是配置错误会报错，自动推导地址 404 视为站点没有公告接口、静默跳过。

**渠道状态（status）**：

- **没有自动推导，必须显式配 `status.url`**。new-api 系常见候选：`/api/model_status/groups`（渠道分组状态，多要登录态 + `New-Api-User` 头）、公开性能汇总接口（如 `/api/perf-metrics/summary?hours=24`）；自研站找 channel-monitors / channel-status 类端点。⚠️ **perf-metrics 这类接口常是站方后来才上线的——启用时实测为空不等于一直空，批量复测标准端点族（脚本思路：拉首页提取 `/api/*` 引用 + 标准族逐个打）值得隔阵子跑一遍**（2026-10-09 复测即捡到 modelflare 48 条、123ai-ai-wx 1 条）。
- **Uptime Kuma 状态页**（外挂 status.xxx 域名，导航叫 Monitor 的多是它）：配心跳接口并声明 `"parse": "kuma"`——
  ```json
  "status": {"url": "https://status.<站域>/api/status-page/heartbeat/<slug>", "parse": "kuma"}
  ```
  采集器自动取同源 `/api/status-page/<slug>` 拿监控名与分组，转成标准渠道形状（name/group/status 词/availability 整数/timeline 心跳点）；滚动窗口不进 diff，渠道状态翻转才算事件（首例 1xm：22 渠道两轮零噪音）。**不要原样采 heartbeat 端点**——前端通用提取器会把每条心跳渲染成垃圾渠道、diff 每轮刷 81 条噪音。
- 解析三层：结构化 JSON 直接采用 → HTML/文本提取内嵌 JSON → AI 兜底；数据原样存（不强制归一 schema），路径级结构 diff 生成状态变化事件（滚动时间线字段自动跳过防噪音）。选地址时优先找直接返回 JSON 的接口。
- **展示层在售口径过滤（前端自动，无需配置）**：渠道视图只保留渠道名对得上本站在售「模型名 ∪ 计价分组名」的行（去空格忽略大小写，`channelStatus.buildMonitoredSets`）；一条都对不上时回退全量防白板（状态页产品线与在售完全错开的站，如 1xm 只挂 claude 渠道而在售全是 GPT/Gemini 分组）。站级可用率/延迟/时段桶随之变成「在售口径」。`status.groups` 是采集层的可选硬过滤，两者不冲突，但优先靠通用机制、不逐站配 groups。
- `status.groups` 可只保留指定分组；401/403 按需认证处理，走 `auth_inject` 的 status 腿。

**认证怎么选**（价格/状态/公告三处共用一套逻辑）：

1. 匿名能通就不配认证——先匿名 curl 试，这是最省心的形态。
2. 固定 token：站点级 `auth_token` + `auth_inject` 写清三处注入规则。
3. 短效会话：`token_refresh` 自动续签（new-api 会话系配 `refresh_cookie_name: new_api_refresh`，自研站配对应刷新端点）。sub2api 系（1for/2000lab）配法实测（2026-10-09 定稿）：`url` = `https://<站域>/api/v1/auth/refresh`、`method` POST、`body` = `{"refresh_token": "${refresh_token}"}`、`access_token_field` = `data.access_token`、`refresh_token_field` = `data.refresh_token`，浏览器登录后从 localStorage 取 `refresh_token` 贴进去保存即接管。⚠️ 两条纪律：① **rt_ 单次可用每次刷新轮换**——拿被前端自动轮换掉、或被探测烧过的旧 rt_ 去续签必然 `REFRESH_TOKEN_INVALID`（「2000lab 续签链断了」的旧结论就是这么来的误判）；② 接管后浏览器侧会话的自动续签即作废（同一 rt_ 只能一个客户端持有），到期浏览器需重登、采集侧不受影响。**主动续签（2026-10-11 起）**：token 是 JWT 且配了续签的站，三条采集腿每站开抓前检查剩余寿命，不足总寿命 1/6（24h token 提前 4h）就主动续签回写，不等被 401——轮换型 rt_ 隔天只有一次使用机会，被动续签对 24h 短效 token 意味着一天死一次（2026-10-11 四个 sub2api 站同一小时集中掉线的根因）；主动续签撞上并发腿时静默采用库里的新 token，续签链真死仍由被动链路上报。
4. 登录态 Cookie 与特殊头（`New-Api-User`、`Referer`）放**站点级 `request_headers`**（站点对象顶层字段）——这是价格/渠道状态/公告三腿都生效的唯一落点。`network.headers` 价格腿与公告腿其实也会带上（2026-10-09 cun 实证；只有渠道状态腿不读），但**入口级头会覆盖站点级同名头**（合并序：auth_inject > 入口 headers > request_headers）——把凭证迁到 request_headers 或续签换新时，必须同步删掉 network.headers 里的旧同名键，否则旧值一直盖着新值。只有单个采集地址专用的头才写进那个地址的 `headers`。request_headers 里的 `User-Agent` 可覆盖采集默认 UA（2026-10-12 起，大小写不敏感），供指纹类站对齐登录端。**头名可能随站方品牌改名**（heyroute.ai 把 `New-Api-User` 改成了 `HeyRoute-User`，2026-10-12 实锤）：401 文案会直接说缺哪个头，照抄即可。
5. 响应头滑窗续签（claude-relay 系，如 icodeeasy）：登录后 token 存 localStorage 单个 `token` 键、有效期 30 天——服务端可在响应头 `x-new-token` 里下发新 token，前端拦截器自动写回。**实测 2026-10-09：新鲜 token 请求未触发该头**（疑似仅临期才下发），采集端也未接管；到期前没人替它续，过期即公告腿 401、需重新登录重贴。识别特征：SPA 前端代码里 `x-new-token` 字样。
6. **会话绑定类站点**（sub2api 部署可开，401 返回 `SESSION_BINDING_MISMATCH`）：指纹 = SHA256(登录时出口 IP + User-Agent)，任一变化即 401，且**校验失败一次就吊销整个会话家族的 refresh token**（浏览器那边的新鲜 rt_ 立刻全灭）——所以接管前先服务器侧 `curl -H "Authorization: Bearer <token>"` 试一手，别拿浏览器凭证盲配续签链。破解看部署是否信任转发头（源码 session_binding 中间件）：信任时站级 request_headers 传 `X-Forwarded-For: <登录出口 IP>` + `User-Agent: <登录端 UA>`（IAB 内核 UA 用页内 `navigator.userAgent` 现读）即可匹配，采集与续签全通（2btocken 实锤）；不信任转发头就只能同出口代理+UA 定制或放弃。注意 Clash 切节点 = 出口 IP 变 = 指纹再失效，用户重登后要同步更新 XFF 头。

## AI 浏览器代办 SOP（替用户看站 + 配置）

### 工具栈：同一套口径，两个环境（2026-10-13 双环境对齐）

配站走查先认当前跑在哪个环境——能力等价、命令不同，**选型规则两边一致**：

| 用途 | ZCode（历史主力） | WorkBuddy（现用） |
| --- | --- | --- |
| 黑盒走查 / 真实浏览器交互（点按填表、跑完整用户流程、localhost 走查） | Browser Use 插件：`browser-use:web-gui-tester` 方法论 + `browser-use:control-browser` 操作 | `agent-browser` skill（Chromium CLI：`open → wait --load networkidle → snapshot -i → click/type → screenshot`，同会话保留 cookie/localStorage，收尾 `close`）；首次用自动装 Chromium（约 500MB） |
| 找接口地址 / 看页面实际请求 | Chrome DevTools MCP 网络面板 | 无 DevTools MCP → `agent-browser snapshot` 看渲染后的页面 + 直接 `curl` 候选接口族逐个打；仍拿不准再用页内同源 fetch 对照 |
| 纯截图核对（量字号/间距/版式） | Computer Use | `agent-browser screenshot`（存本地文件后用 Read 看图） |
| 网页预览（HTML 静态页 / 本地 dev server 成稿） | IAB 内嵌浏览器 | 右侧「预览」面板：直接看 HTML 或 `http://localhost:3000`（前端）这类本地服务，带地址栏与刷新，不用切外部浏览器 |
| 轻量抓取（静态 HTML 已含目标内容） | `curl` / WebFetch | 同左，不变 |

**选型铁律（两边一致）**：`curl <url>` 拿到的原始 HTML 里已有目标内容 → 走轻量抓取，不起浏览器；只有 JS 动态渲染、要多步交互、或要截图核对时才上真实浏览器。黑盒走查一律主 Agent 亲自执行，不委托 sub-agent。

**环境自检**：手边有 `browser-use:*` 插件 / Chrome DevTools MCP / Computer Use → ZCode；只有内置「预览」面板 + `agent-browser` skill → WorkBuddy。

流程：

1. **看站类型**：打开站点，判断是 new-api/one-api 系（标配 `/api/pricing`、`/api/status`、`/api/notice`）还是自研接口（如 subrouter 的 marketplace API）。**动手前先学站点自己的文档**（2026-10-08 约定）：站内文档页、页脚开源署名对应的 GitHub 仓库、API 文档都看一眼再下判断——sub2api 系读它的仓库文档，new-api 系对照官方源码，不靠猜。**别用一个接口定生死**（2026-10-08 用户要求）：`/api/pricing` 404 不等于站死——把导航、模型广场、渠道、订阅、公告各页面都翻一遍再归类，页面 UI 同款模板（如 sub2api 系的 EN/暗色切换壳）直接对照同族站找接口。
2. **甄别渠道**：按上表口径过一遍模型页/渠道页，确认官方共享渠道的过滤参数或专用接口；空壳渠道（供货统计全 0、价格「不限」）直接排除。
3. **确认价格接口**：优先公开 pricing 接口；拿不准时看页面实际打了哪个请求——ZCode 用 Chrome DevTools MCP 网络面板找返回模型+价格的请求；WorkBuddy 无 DevTools MCP，改用 `agent-browser snapshot` 看渲染后的页面结构、再直接 `curl` 候选接口族（`/api/pricing`、`/api/status`、`/api/notice`…）逐个打，命中即配。返回 HTML 的页面地址必须免登录——httpx 直采没有浏览器环境（详见 `dom_url_auth_constraint`）。顺带确认公告与渠道状态接口（new-api 系候选：`/api/notice`、`/api/status`、`/api/model_status/groups`；渠道分组接口不少部署没有，公开性能汇总 `/api/perf-metrics/summary?hours=24` 是常见替代，两者都匿名可读才配）。sub2api 系端点家族：`/api/v1/model-plaza`（模型广场，匿名性逐站不同）、`/api/v1/channels/available`（可用渠道，带每 token 直读价）、`/api/v1/model-prices`（分组实付价，2026-10-08 新增确定性解析器：按分组展开已含倍率的 CNY 价，登录后可读）、`/api/v1/groups/rates`（分组倍率，多为要登录）、`/api/v1/announcements`（公告）、`/api/v1/channel-monitors`（渠道可用率/延迟，登录后可读）；注意「实收 = 官方美元价 × 分组倍率」的 CNY 计费站，倍率表拿不到就别采——采到的只是没乘倍率的官方价（2xapi 教训）。自研美元计价站（「基准价 × 套餐倍率」那种）先想清楚抽取路径：非 new-api 格式走 AI 兜底，抽取不稳就先别开——错价比没价糟（118.ink 教训，lessons.md §2）。
   **计价口径不用配但必须懂**（2026-10-10 定稿，修 AIHub365 全站价低 6.8 倍后收口）：v1 new-api 站的倍率基准价 = `(1e6/quota_per_unit) × price`，两数都取自该站 `/api/status`（`price` 是充值汇率：1 美元额度卖几块钱；`usd_exchange_rate` 是前端显示换算，不能当基准——1-cnmz 报 7.3 实收按 1）。中文 1:1 站 price=1 基准即 2；AIHub365 6.8→13.6、cun 6.95→13.9、128api/2coding/134-175-71 7.3→14.6。采集层自动读 status 推导（含 marketplace 等非 /api/pricing 地址，剥不出后缀退回 URL 起源），v2 载荷（billing_denomination_version=2）以站方声明优先——配站零动作，但核对价格、跟用户解释折扣时按这个口径心算。另两条解析层既有语义：站方挂牌价（input_price/output_price）优先于 billing_expr 表达式（subrouter 实锤：表达式是官价池计费 p*10+c*50，站上挂牌 0.6=94% 折扣）；`billing_multiplier` 是站方对表达式的折扣系数（sudocode 0.2~2），漏乘即错最高 5 倍。
   **⚠️ 站方自有计价站（充值折扣/展示价）——配站必查，2026-10-12 heyroute 实锤**：少数 fork 站的定价页把「官方参考价（灰色删除线）」与「本站实收价（加粗）」并排显示，实收价 = 参考价 × 按充值/套餐汇率**实时算出**的折扣（heyroute：Grok 组 `$2.00`→`$0.040`、badge「≈2% of xAI official price」）。标准公式拿到的是**被划掉的那一列**（`group_ratio` 是「Nx 计费」额度倍率、不是价格折扣），方向相反 → 整站偏高 2–50 倍。**识别特征**：① 页面每格两个数（前灰删除线、后加粗）；② 分组标题挂在「≈X% of official price」＋「Nx billing」；③ `/api/pricing` 顶层带非标准字段 `display_prices`（标准 new-api 没有这个键）。**这类站的实收价在任何 JSON 里都没有**（前端用 `/api/user/topup/info` 的 `wallet_recharge_rate` + `/api/subscription/plans` 现算），标准公式不可复现。**采集侧已内置该形态的确定性解析**（`adapters.display_fork_price_records`：实收 = 参考价(model_ratio×2/a) × 分组折扣 floor(组倍率×100×a/rate)，rate 取钱包/套餐汇率各算百分比后取最小，cn-models 组 a=7；2026-10-12 用 heyroute 全部 7 个分组的页面渲染价逐分验证），配站零动作、走 `display_prices` 自动分派；配站收尾仍要用浏览器实锤**逐个数字**是站方实收价（heyroute 当初只对「基准价×倍率」自洽就误判成「一致」）。
4. **试探认证**：先匿名请求接口；401/403 再配认证。new-api 系注意 `New-Api-User` 头与 Referer 坑（lessons.md §1）。**撞到登录墙（定价/接口要登录才给数据）**：不硬试——每个站单独开一个注册页标签页交给用户注册登录（2026-10-08 与用户跑通的流程），登录后取凭证，按现役范式配（共享登录态走站点级 `request_headers`，短效凭证配 `token_refresh` 自动续签，浏览器存储登录态走 headless 注入）；凭证运行时贴入，不落仓库。**取凭证按环境走两条路**：① **ZCode** —— IAB 内嵌浏览器 cookie 库是本地明文 SQLite，httpOnly Cookie 也能拷库直查（2026-10-09 cun 实证）：`cp "~/Library/Application Support/ZCode/session/Partitions/zcode-embedded-browser/Cookies" /tmp/iab_cookies.db && sqlite3 /tmp/iab_cookies.db "SELECT name, value FROM cookies WHERE host_key LIKE '%站域%'"`，value 是加密形态（`v10` 开头）才退回让用户从 DevTools 手抄；② **WorkBuddy** —— 没有可拷的内嵌浏览器 cookie 库（2026-10-13 本机实测 `~/Library/Application Support/WorkBuddy` 为空、无 `Partitions` 目录），登录态只能从**用户自己的系统浏览器**取：让用户在 Chrome/Edge 登录同站后从 DevTools → Application → localStorage 手抄 `token`/`refresh_token` 贴进配置（sub2api 系四键、new-api 系会话 Cookie，见 lessons.md §3）；需要浏览器会话内真登录时用 `agent-browser open <登录页>` → `snapshot -i` 认元素 → `type` 填 → `click` 提交（凭据向用户要、不落仓库），登录态在该会话内保留供后续同源接口对照。**假设（未实测）**：内置「预览」面板是独立会话、不共享系统浏览器 Cookie；若实测共享，看图走「预览」面板更省事。
5. **录入配置**：管理台新增/编辑站点，价格、公告、渠道状态三件套配齐（能采就采），填认证；凭证运行时贴入，不落仓库。
6. **自验**：站点行「测试采集」干跑（默认不调 AI、零费用），或 `POST /api/collect` 带 `site_id`；核对采到的模型与价格同站内页面一致、渠道来源符合口径。价格核对拿页面渲染值对数，流程与记录模板见 [page-cross-check.md](page-cross-check.md)（**模型列表页优先，Model Plaza 只在没有模型列表时兜底**；页面渲染值是唯一事实源，接口字段语义与源码注释都可能误导）。公开页直接看 DOM（ZCode 用 IAB、WorkBuddy 用 `agent-browser`）；登录墙站优先用库内凭证直接 `curl` 同源接口对账（两边通用），要页面渲染值再按环境注入登录态（ZCode 拷库/注入四键、WorkBuddy 系统浏览器手抄或 `agent-browser` 会话内登录）；数值对不上先怀疑充值口径、组倍率计入位置与 billing_multiplier 这类解析层盲区，站方换模型阵容才是正常流失。
7. **收尾沉淀**：新坑进 lessons.md 对应分类，跨会话硬约束写 Serena 记忆。

## 新站速判（配前 3 分钟过一遍，2026-10-12 定）

配一个新站前按顺序打这几枪，命中任何一条都先停下来想清楚再决定采不采：

1. **页面每格几个数？** 打开 `/pricing`（无则模型列表页），看模型行里价格单元格。一格一个数＝常规 new-api，标准公式可用；一格**两个数且前一个灰色删除线**＝站方自有计价（见上方「站方自有计价站」），标准公式会采到被划掉那列 → 采集已内置该形态解析（靠顶层 `display_prices` 自动分派），但配站收尾仍要逐数字实锤。
2. **分组标题写了什么？** 只有「Nx」＝常规倍率；出现「≈X% of official price」这类对照官价的营销口径＝大概率用了充值/套餐折扣体系。
3. **`/api/pricing` 顶层有哪些键？** 标准站是 `data / group_ratio / usable_group / pricing_version`；若多出 `display_prices`、`wallet_recharge_rate` 之类非标准键＝改过计费的 fork，先按「自有计价」对待。一条命令扫全库同类站：拉各站 pricing URL 看顶层键（本轮扫描脚本思路见 `.zcode/plans`）。
4. **实收口径必须逐个数字实锤**：别用「基准价 × 倍率 = 库里值」自证（自洽不等于对），要点开模型行读页面**实收那个数**与库里比；对不上且说不清倍数就是口径错。参照 `docs/page-cross-check.md` 的对照流程与记录模板。
5. **站价高于官价的行会被系统丢弃**（产品口径，2026-10-12 用户定）：折合 CNY 后折扣 > 100% 即「比官价还贵、没有选择价值」，采集侧不入快照、展示侧过滤。所以某站在库里「少了几个模型/分组」时，先看是不是它本来就卖得比官价贵——不是采集故障。

## 红线

- 凭证（token/Cookie/密码）不写进任何仓库文件；配置里用 `${ENV_VAR}` 引用或运行时贴入；导出文件含凭证，交付时提醒用户保管。
- 目标站点只读浏览：不改对方站点任何数据、不点消耗额度的按钮、不代充值。
- 不替用户启动服务；需要管理台在线时先探测端口（API 8437 / 前端 3000），不在线请用户启动。
