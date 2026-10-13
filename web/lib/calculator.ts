/** 花费计算：单价（每 100 万 token）× 用量 → 各档小计与总价。
 *  与 React 无关的纯函数：便于单测，也供 URL 编解码复用。文案不在此文件，统一放 copy.ts。
 *  用量口径：按账单/用量面板的四个计费档直接填 token 数（输入、输出、缓存读取、缓存写入），
 *  不再让用户猜「输出占比 × 缓存命中率」两个联动比率；没有账单时用 estimateTokens 按场景预设
 *  （普通对话 / 编码 Agent / 长文分析）估算填充，估的是量级、不是账单原值。 */

/** 四个计费档（与站点价目卡一致） */
export type PriceKey = "input" | "output" | "cacheRead" | "cacheWrite";

export type CalcPrices = Record<PriceKey, number | null>;

/** 四档 token 数（账单口径）；null = 没填，按 0 计 */
export type UsageTokens = Record<PriceKey, number | null>;

export const PRICE_KEYS: PriceKey[] = ["input", "output", "cacheRead", "cacheWrite"];

/** 单价口径：目录与站点价统一按每 100 万 token 标价。 */
const TOKENS_PER_UNIT = 1_000_000;

/** 估算场景：没有账单时按哪种用法把「一个总用量」折算成四档 token。
 *  两个比率都是**量级假设**，不是厂商口径；选中场景后照样能在下面手改。
 *  把场景做成预设而不是写死一对默认值的理由：输出占比与命中率高度依赖用法，
 *  一个用错场景的默认值会让估算跟真实账单差出好几倍（默认按重缓存的 Agent 口径时，
 *  没开缓存的普通用户看到的花费只有实际的几分之一）。 */
export type EstimatePresetKey = "chat" | "agent" | "longdoc";

export interface EstimatePreset {
  key: EstimatePresetKey;
  /** 输出占总用量的百分比 0–100 */
  outputShare: number;
  /** 输入里从缓存读取的比例 0–100；0 = 这次用量完全没走缓存 */
  hitRate: number;
}

/** 三个场景覆盖绝大多数用法，按「接入缓存的程度」从低到高排。 */
export const ESTIMATE_PRESETS: readonly EstimatePreset[] = [
  /** 普通对话 / 问答：一问一答，输入比输出多几倍，一般站点也不做前缀缓存 */
  { key: "chat", outputShare: 20, hitRate: 0 },
  /** 编码 Agent：Claude Code 这类自带前缀缓存的工具，同一份代码与规则反复带进上下文——
   *  输入远多于输出、而输入里九成以上直接命中缓存。数值取自一份公开实测样本
   *  （单人 35 天 / 7.4 万轮：输出约 0.44%、命中率 96–97%），非厂商官方口径。 */
  { key: "agent", outputShare: 0.4, hitRate: 96 },
  /** 长文分析 / 文档处理：整篇文档喂进去、只要一段结论，输出占比很低，一般也不走缓存 */
  { key: "longdoc", outputShare: 5, hitRate: 0 },
];

/** 默认场景「普通对话」：不带任何缓存假设，也不假设输出可以忽略。
 *  宁可估高一点，也不让用户按一个偏低的数去充值。 */
export const DEFAULT_PRESET: EstimatePresetKey = "chat";

function presetOf(key: EstimatePresetKey): EstimatePreset {
  return ESTIMATE_PRESETS.find((item) => item.key === key) ?? ESTIMATE_PRESETS[0];
}

/** 两个比率的缺省值：都跟随默认场景（普通对话：输出 20%、命中率 0）。 */
export const DEFAULT_OUTPUT_SHARE = presetOf(DEFAULT_PRESET).outputShare;
export const DEFAULT_HIT_RATE = presetOf(DEFAULT_PRESET).hitRate;

/** 按当前两个比率反查命中的场景：值被手改过就返回 null（界面据此取消高亮）。 */
export function matchPreset(outputShare: number, hitRate: number): EstimatePreset | null {
  return (
    ESTIMATE_PRESETS.find(
      (item) => item.outputShare === outputShare && item.hitRate === hitRate,
    ) ?? null
  );
}

/** 总用量快捷档位（与 copy.ts 的 tokenPresets 标签按序对应），默认 1 亿。 */
export const TOKEN_PRESET_VALUES = [10_000_000, 100_000_000, 1_000_000_000] as const;
export const DEFAULT_TOTAL_TOKENS: number = TOKEN_PRESET_VALUES[1];

interface CostLine {
  key: PriceKey;
  /** 计入的单价（每 100 万 token，与 CalcPrices 同币种）；该档没价且无法回落时为 null，整档不计入总价 */
  unitPrice: number | null;
  /** 该档填写的 token 数；没填价也照常展示，明细表照实呈现 */
  tokens: number;
  /** 小计；没价可计时为 null */
  subtotal: number | null;
  /** 占已计费总价的比例 0–1；没计价或总价为 0 时为 null */
  share: number | null;
  /** 本档没填单价、回落按输入价计（只有缓存读取/写入两档会回落） */
  fallback: boolean;
}

export interface CalcResult {
  lines: CostLine[];
  total: number;
}

/** 估算填充参数：一个总量 + 两个拆分假设，套用后折算成四档 token 数。
 *  两个假设来自场景预设（ESTIMATE_PRESETS），也可手改。 */
export interface CalcEstimate {
  /** 总 token 用量；只认快捷档位 */
  total: number | null;
  /** 缓存命中率 0–100；缺省回落默认场景的值（0） */
  hitRate: number | null;
  /** 输出占总用量百分比 0–100；缺省回落默认场景的值（20） */
  outputShare: number | null;
}

export const EMPTY_PRICES: CalcPrices = {
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
};

export const EMPTY_TOKENS: UsageTokens = {
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
};

export const EMPTY_ESTIMATE: CalcEstimate = {
  total: DEFAULT_TOTAL_TOKENS,
  hitRate: DEFAULT_HIT_RATE,
  outputShare: DEFAULT_OUTPUT_SHARE,
};

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveTokens(value: number | null | undefined): number {
  const num = finiteOrNull(value);
  return num !== null && num > 0 ? num : 0;
}

/** 命中率：空/负数按非法值回落默认值，超过 100 钳到 100。 */
export function parseHitRate(text: string): number {
  const num = parseAmount(text);
  if (num === null) return DEFAULT_HIT_RATE;
  return Math.min(100, Math.max(0, num));
}

/** 输出占比：空/负数按非法值回落默认值，超过 100 钳到 100。 */
export function parseOutputShare(text: string): number {
  const num = parseAmount(text);
  if (num === null) return DEFAULT_OUTPUT_SHARE;
  return Math.min(100, Math.max(0, num));
}

/** 估算 → 四档 token：输出占 outputShare，其余是输入池。
 *  输入池怎么记分两种情况：
 *    · 命中率 > 0（这批用量确实在用缓存）：命中段记「缓存读取」，未命中段是这次首次
 *      见到的内容、会写进缓存，记「缓存写入」（站点没给写入价时由 calcCost 回落按输入价）。
 *    · 命中率 = 0（没有缓存这回事）：整池都记「普通输入」——不能记到缓存写入档，
 *      否则会把一批根本没走缓存的 token 按写入价（多数站点比输入价贵）计，凭空估高。
 *  四档取整后加总严格等于总用量，明细表逐行加起来不会跟总量对不上。 */
export function estimateTokens(estimate: CalcEstimate): UsageTokens {
  const hit = parseHitRate(estimate.hitRate != null ? String(estimate.hitRate) : "") / 100;
  const outputShare =
    parseOutputShare(estimate.outputShare != null ? String(estimate.outputShare) : "") / 100;
  const totalTokens = Math.round(positiveTokens(estimate.total));
  const output = Math.round(totalTokens * outputShare);
  const inputPool = totalTokens - output;
  const cacheRead = Math.round(inputPool * hit);
  const miss = inputPool - cacheRead;
  return {
    input: hit > 0 ? 0 : miss,
    output,
    cacheRead,
    cacheWrite: hit > 0 ? miss : 0,
  };
}

/** 总花费 = 各档 token 数 × 各档单价之和（缓存档没填单价时回落按输入价，见 calcCost）。
 *  每档独立计价：账单上四档 token 数各是各的，这里不拆分、不搬移，填多少算多少。
 *  缓存读取/写入没填单价时按输入价回落计（不假设有缓存折扣，也不按 0 元漏计），
 *  回落档带 fallback 标记，由界面挑明；输入价也没有，那一档才真的「未计入」。 */
export function calcCost(prices: CalcPrices, tokens: UsageTokens): CalcResult {
  const lines: CostLine[] = PRICE_KEYS.map((key) => {
    const count = positiveTokens(tokens?.[key]);
    const own = prices[key];
    let unitPrice = own !== null && own >= 0 ? own : null;
    let fallback = false;
    if (unitPrice === null && (key === "cacheRead" || key === "cacheWrite")) {
      const inputPrice = prices.input;
      if (inputPrice !== null && inputPrice >= 0) {
        unitPrice = inputPrice;
        fallback = true;
      }
    }
    return {
      key,
      unitPrice,
      tokens: count,
      subtotal: unitPrice !== null ? (count / TOKENS_PER_UNIT) * unitPrice : null,
      share: null,
      fallback,
    };
  });
  const total = lines.reduce((sum, line) => sum + (line.subtotal ?? 0), 0);
  if (total > 0) {
    for (const line of lines) {
      if (line.subtotal !== null) line.share = line.subtotal / total;
    }
  }
  return { lines, total };
}

/** 金额显示：大额少留位、小额多留位，避免 0.0004 被四舍五入成 0。
 *  ≥1 两位、≥0.01 四位、其余六位；整数与 0 原样。 */
export function formatAmount(value: number | null | undefined): string {
  const num = finiteOrNull(value);
  if (num === null) return "—";
  if (num === 0) return "0";
  const digits = Math.abs(num) >= 1 ? 2 : Math.abs(num) >= 0.01 ? 4 : 6;
  return num
    .toFixed(digits)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}

/** 单价文本：目录/站点的单价由倍率相乘算出，常是无限循环小数（0.38457142857142856），
 *  纯浮点噪声（0.2499999999）也混在其中。收敛到 6 位有效数字再由 Number 归一，
 *  输入框里始终是短小数；6 位对 0.000647 ~ 1401.6 的单价量级足够精确（相对误差 < 1e-5）。 */
export function formatPriceText(value: number | null | undefined): string {
  const num = finiteOrNull(value);
  if (num === null || num === 0) return num === 0 ? "0" : "";
  const magnitude = Math.floor(Math.log10(Math.abs(num)));
  const decimals = Math.min(12, Math.max(0, 5 - magnitude));
  const text = num.toFixed(decimals);
  // 小于 1e-6 时 Number#toString 会退化成指数写法（1e-7），输入框里读不出量级，改回定长小数
  if (magnitude < -6) {
    const trimmed = text.replace(/0+$/, "").replace(/\.$/, "");
    // 小到 12 位小数都印不出来时（1e-13）退回原样，宁可给个指数也好过给空框
    return trimmed === "" ? String(num) : trimmed;
  }
  return String(Number(text));
}

/** 金额输入解析：空串与非法值一律为 null（留空表示该档不计入），负数按 0 处理。 */
export function parseAmount(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const num = Number(trimmed);
  if (!Number.isFinite(num) || num < 0) return null;
  return num;
}

/** URL 里的总量只认快捷档位，其余一律回落默认档。 */
function presetTotal(value: number | null): number {
  return value !== null && (TOKEN_PRESET_VALUES as readonly number[]).includes(value)
    ? value
    : DEFAULT_TOTAL_TOKENS;
}

export type CalcSource = "official" | "site";

export interface CalcState {
  source: CalcSource;
  model: string;
  site: string;
  /** 单价币种：只决定展示符号（CNY→¥，USD→$，其余不显示符号），不做汇率换算 */
  currency: string;
  prices: CalcPrices;
  /** 四档 token 数（账单口径）；挂载时若全空会按估算默认值自动填充一次 */
  tokens: UsageTokens;
  /** 估算填充参数：驱动「按估算填充」按钮 */
  estimate: CalcEstimate;
}

/** 是否填了至少一档单价：决定结果区显示空态还是明细表。 */
export function hasAnyPrice(prices: CalcPrices): boolean {
  return PRICE_KEYS.some((key) => prices[key] !== null);
}

/** 是否填了至少一档用量：挂载时据此决定要不要按估算默认值自动填充。 */
export function hasAnyToken(tokens: UsageTokens): boolean {
  return PRICE_KEYS.some((key) => (tokens[key] ?? 0) > 0);
}

export const EMPTY_STATE: CalcState = {
  source: "official",
  model: "",
  site: "",
  currency: "USD",
  prices: EMPTY_PRICES,
  tokens: EMPTY_TOKENS,
  estimate: EMPTY_ESTIMATE,
};

/** URL 参数名：短键，保证分享链接不至于过长。 */
const PARAM = {
  source: "src",
  model: "m",
  site: "s",
  currency: "cur",
  price: { input: "pi", output: "po", cacheRead: "pr", cacheWrite: "pw" },
  token: { input: "ti", output: "to", cacheRead: "tr", cacheWrite: "tw" },
  total: "t",
  hit: "h",
  outputShare: "os",
} as const;

function compact(value: number | null): string | undefined {
  return value === null ? undefined : String(value);
}

/** 状态 → query 参数；空值与估算默认值不写，保证链接干净。 */
export function encodeCalcState(state: CalcState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.source === "site") params.set(PARAM.source, "site");
  if (state.model) params.set(PARAM.model, state.model);
  if (state.site) params.set(PARAM.site, state.site);
  // USD 是解码默认值，省掉无损；其余币种必须写入，否则还原时币种会变
  if (state.currency && state.currency !== "USD") params.set(PARAM.currency, state.currency);
  for (const key of PRICE_KEYS) {
    const price = compact(state.prices[key]);
    if (price !== undefined) params.set(PARAM.price[key], price);
    const tokens = state.tokens?.[key];
    if (tokens != null && tokens > 0) params.set(PARAM.token[key], String(tokens));
  }
  const estimate = state.estimate ?? EMPTY_ESTIMATE;
  if (estimate.total != null && estimate.total !== DEFAULT_TOTAL_TOKENS) {
    params.set(PARAM.total, String(estimate.total));
  }
  if (estimate.hitRate != null && estimate.hitRate !== DEFAULT_HIT_RATE) {
    params.set(PARAM.hit, String(estimate.hitRate));
  }
  if (estimate.outputShare != null && estimate.outputShare !== DEFAULT_OUTPUT_SHARE) {
    params.set(PARAM.outputShare, String(estimate.outputShare));
  }
  return params;
}

/** query 参数 → 状态。
 *  用量优先读四档 token（ti/to/tr/tw）；都没有而带旧参数（t/h/os）时，按旧口径
 *  「总量×输出占比×命中率」迁移成四档 token，老分享链接打开仍是同一笔账。 */
export function decodeCalcState(params: URLSearchParams): CalcState {
  const prices = { ...EMPTY_PRICES };
  const tokens = { ...EMPTY_TOKENS };
  let hasTokens = false;
  for (const key of PRICE_KEYS) {
    prices[key] = parseAmount(params.get(PARAM.price[key]) ?? "");
    tokens[key] = parseAmount(params.get(PARAM.token[key]) ?? "");
    if (tokens[key] !== null) hasTokens = true;
  }
  const total = parseAmount(params.get(PARAM.total) ?? "");
  const hit = params.get(PARAM.hit);
  const outputShare = params.get(PARAM.outputShare);
  if (!hasTokens && (total !== null || hit !== null || outputShare !== null)) {
    Object.assign(
      tokens,
      estimateTokens({
        total,
        hitRate: parseHitRate(hit ?? ""),
        outputShare: parseOutputShare(outputShare ?? ""),
      }),
    );
  }
  return {
    source: params.get(PARAM.source) === "site" ? "site" : "official",
    model: params.get(PARAM.model) ?? "",
    site: params.get(PARAM.site) ?? "",
    currency: (params.get(PARAM.currency) ?? "USD").toUpperCase(),
    prices,
    tokens,
    estimate: {
      total: presetTotal(total),
      hitRate: parseHitRate(hit ?? ""),
      outputShare: parseOutputShare(outputShare ?? ""),
    },
  };
}
