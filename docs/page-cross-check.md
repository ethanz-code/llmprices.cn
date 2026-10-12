# 页面对照核查（采集值 vs 站点页面）

> 用途：配新站或对价格口径存疑时，用站点自己的页面验证库里的价格和公告是否与用户看到的一致。接口 JSON 和源码注释都可能误导——**页面渲染值是唯一事实源**（2026-10-12 2btocken 实锤：plaza 接口 pricing 未含组倍率，源码注释却写「实收口径已含倍率」，采到的价是页面实付价的 4 倍）。

## 价格源优先级

1. **模型列表页优先**（new-api 系 `/pricing`、自研站的模型列表/价目表）：页面有模型列表就以它为准。
2. **Model Plaza / 模型广场只在没有模型列表时兜底**（sub2api 系部分部署只有广场没有列表，如 2btocken）。
3. 两者都没有、只有渠道倍率 → 走渠道倍率合成（见 sites.md），标 candidate。

## 核查步骤（内置浏览器，带登录态）

1. 打开站点价格页（登录墙站先注入登录态：sub2api 系 localStorage 四键，new-api 系 session Cookie，见 lessons.md §3）。
2. 看页面网络请求（performance 资源列表或 DevTools），确认页面实际打的价格接口与站点配置的 `network.url` 是同一个；顺带扫一眼有没有漏配的渠道状态/公告接口。
3. 挑 1-2 个监控清单内模型，读页面显示的输入/输出价与币种标注，和库里 `latest` 对应记录对账：
   - 页面价 = 库里价：通过。
   - 差一个组倍率/充值汇率倍数：页面展示的是基准价、计费才乘系数（HeyRoute 型：页面 $12 = 基准，库里 ¥157.68 = $12×组倍率 1.8×充值汇率 7.3）——在 notes 里写明语义即可，不算错。
   - 对不上且说不清倍数：采集口径有误，先修解析器再重采，别在配置里打补丁。
4. 公告：打开公告入口（弹窗/公告页），正文与 `notice_records` 最新版本对照；页面有公告而库里空，先查公告腿 401（认证没配）与正文字段名（01tree description 键教训）。
5. **渠道状态**：点开站点的 Channel Status / 监控页，看它实际调用的端点与渲染内容，和 `status.url` 配置对照——**别信老端点还活着**（sub2api 新版把 `/api/v1/channel-monitors` 留成空壳，页面走 `/api/v1/channel-monitor-v2/models`，2026-10-12 2btocken 实锤）。看页面还能量出对的语义：成功率是 0-1 小数还是百分数、首字耗时在哪个字段、无流量模型怎么标。

## 记录模板

核查结论追加到文末「核查记录」，一行一站：

`日期 | 站点 | 价格页(列表/广场) | 对照模型 | 页面价 | 库里价 | 结论(一致/差倍数已解释/已修) | 公告对照 | 渠道状态端点对照`

## 核查记录

- 2026-10-12 | aheapi(HeyRoute) | 模型列表 /pricing | gpt-6-astra | 页面 $12.00/$60.00（Codex-Pro20x 组，标注 1.8x billing，美元基准价） | 库 ¥157.68/¥788.4 | ~~一致：页面是未乘组倍率的基准价，$12×1.8×充值汇率 7.3=¥157.68，四组逐分吻合~~ **已被 2026-10-12 复核查更正，见下条** | 公告「Claude 系列已上架」与 /api/notice 一致；无渠道状态接口（perf/groups 均 404）
- 2026-10-12 | aheapi(HeyRoute) | 模型列表 /pricing | grok-4.7 / gpt-6-astra | 页面每格**两个数字**：`$2.00`（灰、删除线＝官方参考价）→ `$0.040`（黑粗＝站方售价）；分组徽标「≈2%/4%/56% of official price」＋「Nx billing」 | 库 ¥14.6/¥43.8（grok，≈官方价 $2/$6） | **已修（2026-10-12 当天）**：库里存的是**删除线那一列**（官方参考价），站方实收是加粗列（参考价×分组折扣 2%–56%）；`group_ratio` 是「Nx 计费」额度倍率、不是价格折扣。已内置确定性解析 `adapters.display_fork_price_records`（实收 = 参考价×分组折扣，rate = 钱包/套餐汇率各算百分比取最小，cn-models a=7），靠顶层 `display_prices` 自动分派；**实采与页面 7 个分组逐分吻合**（grok $0.04、astra codex-pro20x $0.48、opus claude $0.16 / Max20x $0.84、glm/m3 cn-models $0.64/$0.168），站点已恢复启用 | 公告「Claude 系列已上架」+「国内线路改 cn.heyroute.ai」与 /api/notice 一致；公告无价格折扣说明（折扣在前端算法里） |
- 2026-10-12 | 2btocken(MaxAPI) | 仅 Model Plaza（无模型列表，/models 是 API Key 网关接口） | gpt-6-astra | 页面 Your Price $4.50/$22.50（PRO池 0.25x） | 库 $4.50/$22.50（candidate） | 已修：初版按源码注释当「已含倍率」存了 $18，页面实锤 pricing 未含倍率，解析器补乘 rate_multiplier（0dd602d）后重采一致 | 公告腿已配 /api/v1/announcements（页面 Announcements 弹窗同源） | **渠道状态**：老 `/channel-monitors` 空壳（items 0），页面走 `/channel-monitor-v2/models?range=90m`（81 条，成功率嵌 metrics 且为 0-1 小数、首字耗时在 metrics.ttft.avg_ms、无流量模型 rate/error 双零）——已改配 v2 端点，前端补嵌套取值/归一/无样本过滤（8087a1a），站点页可用率 2%→25%、渠道 65→4 条真实行

- 2026-10-12 | 123api | 模型广场 /pricing | claude-sonnet-5-5 / claude-opus-5-5 | 页面 `输入 $75.0000 / 补全 $75.0000`（default 组；分组倍率 aws-Claude 3.5x、az-Claude 1.8x） | 库 ¥75/¥75（default） | 一致：站方自己把这两个模型的 completion_ratio 设成 1（输入=输出），页面同样显示两者相等；aws-Claude 组 ¥262.5 = 75×3.5 亦与倍率吻合。非解析错，是站方标价 | — |
- 2026-10-12 | 2coding | 模型广场 /pricing | claude-fable-5-1 | 页面 `输入 $150 / 输出 $150`（claude-max 组 x2） | 库 ¥1095/¥1095 | 一致：$150=$75基准×2组倍率，¥1095=$150×7.3 充值汇率；输入=输出同 123api 系站方 completion_ratio=1 | — |
- 2026-10-12 | sudocode | 模型广场 /pricing | gpt-6-astra | 页面 `输入 ¥2.00 / 输出 ¥10.00`，页内标注「节省 -97%」，官方价 $10/$50 | 库 ¥2.0/¥10.0 | 一致：超低价是站方公开宣传的真价（号池站常态） | — |
- 2026-10-12 | 8yes | 模型广场 /pricing | gpt-6-sol | 页面 `$0.12 / $0.6`（gpt-默认降智组 x0.06） | 库 ¥0.12/¥0.6 | 一致：站方自定义 x0.06 低价分组，页面如实显示 | — |
- 2026-10-12 | 128api | 模型列表 /pricing | grok-4.7 | 站方公式「cost = Group ratio × Model ratio × (...) / 500000 USD」；模型自带 `model_ratio=2, completion_ratio=12`、组倍率 2 | 库 ¥58.4/¥700.8（=$8/$96） | 一致：高倍（输入 4x/输出 16x 官价）来自站方自己把 grok 输出 completion_ratio 设为 12，接口如实返回，非采集错 | — |
- 2026-10-12 | totokens | 模型列表 /models（登录态） | claude-haiku-5-5 · CC-MAX -纯血专享 | 页面 `2.98x → 输入 $14.9 / 输出 $74.5` | 库 $14.9/$74.5（USD） | 一致：149 倍是站方「纯血专享」高价池的自定义倍率（同站 gpt-6-astra gpt-plus-优惠 0.178x→$1.78 亦逐分吻合） | — |
- 2026-10-12 | 2api | marketplace 接口 /api/v1/marketplace/models | deepseek-v4-pro / gpt-6-astra | 接口 offers 直读 `effective_input/output_price`，deepseek-v4-pro（aliyun_bailian offer）$12/$24 | 库 $12/$24 | 一致：高倍来自 marketplace 各平台 offer 的挂牌价 | ⚠️ 这些高于官价的 offer 是否属「官方共享渠道」口径待确认 |
- 2026-10-12 | 123ai-ai-wx | 模型广场 /pricing（另有自研壳） | grok-4.6 / grok-4.7 | 站方 `/api/pricing` 返回 `model_ratio=0, completion_ratio=0`；plaza 页面未展示这两款 | 库 ¥0/¥0（confirmed） | **存疑（待修）**：0/0 是站方占位值，页面根本不售卖，不应作为「¥0 免费价」展示（命中 zero-price 占位坑） | — |
- 2026-10-12 | 988665(佛爷API) | 模型广场 /pricing | gpt-6-luna / grok-4.6-4.7 | 页面卡片单列 `输入 $0.4 / 输出 $2.4 / 缓存 $0.04`（gpt官key 组） | 库 ¥2.92/¥17.52（=$0.4/$2.4×7.3） | 一致：单列显示，站方真实标价（其 gpt官key 组对官价约 4x）；公告「gpt plus 0.05 倍率 pro 0.15 倍率 claude max 1.3 倍率」与分组倍率口径吻合 | — |
- 2026-10-12 | 134-175-71(CC中转) | 模型广场 /pricing | glm-5.3 | 页面单列 `输入 $3.2 / 输出 $11.2`（国产模型 组） | 库 ¥23.36/¥81.76 | 一致：$3.2×7.3=¥23.36；单列显示，站方真实标价（对官价约 2.8x） | — |
- 2026-10-12 | 128api | 模型列表 /pricing | grok-4.7 | 页面行 `Model ratio 2 / Completion ratio 12 / Group ratio 1 → Prompt $4.000、Completion $48.000` | 库 ¥58.4/¥700.8（pro百万token 组=$8/$96） | 一致：页未登录按 1x 基准，×2 组倍率=$8/$96；单列显示，高倍来自站方自定义 completion_ratio 12 | 公告为微信/上新，无调价说明 |
- 2026-10-12 | 2api | marketplace 模型页 /marketplace/models/split | gpt-6-astra / deepseek-v4-pro | 页面单列 `Input ¥0.500000/M、Output ¥3.000000/M`（196 个 ¥、0 个 $） | 库 USD 0.5/3.0 | **币种存疑（待确认）**：接口声明 `currency:USD`、页面显示 ¥（数值相同不换算）——按「币种以页面为准」应为 CNY；此站折扣口径可能整体差 6.7 倍。若确认页面 ¥（本地化换算）为准，需把该站 unit 改 CNY 重采 | 公告「ccmax 价格调整至 1.2」等 | 
