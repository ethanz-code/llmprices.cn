/** 花费计算：单价（每 100 万 token）× 用量 → 各档小计与总价。
 *  与 React 无关的纯函数：便于单测，也供 URL 编解码复用。文案不在此文件，统一放 copy.ts。 */

/** 四个计费档（与站点价目卡一致）。口径按 AI Agent 实测用量拆分：输出约占 0.4%，
 *  输入里约 96% 从缓存读取（命中率可调），其余是首次写入缓存的部分——见 calcCost。 */
export type PriceKey = "input" | "output" | "cacheRead" | "cacheWrite";

export type CalcPrices = Record<PriceKey, number | null>;

interface CostLine {
  key: PriceKey;
  /** 单价（每 100 万 token，与 CalcPrices 同币种）；该档没填价时为 null，整档不计入总价 */
  unitPrice: number | null;
  /** 该档分到的 token 数；没填价也照常拆出来，明细表照实展示 */
  tokens: number;
  /** 小计；没填价时为 null */
  subtotal: number | null;
  /** 占已计费总价的比例 0–1；没填价或总价为 0 时为 null */
  share: number | null;
}

export interface CalcResult {
  lines: CostLine[];
  total: number;
}

export const PRICE_KEYS: PriceKey[] = ["input", "output", "cacheRead", "cacheWrite"];

/** 单价口径：目录与站点价统一按每 100 万 token 标价。 */
const TOKENS_PER_UNIT = 1_000_000;

/** 缓存命中率默认 96%：反复带同前缀的调用（agent、多轮对话）实测在 96–97% 量级。 */
export const DEFAULT_HIT_RATE = 96;

/** 总用量快捷档位（与 copy.ts 的 tokenPresets 标签按序对应），默认 1 亿。 */
export const TOKEN_PRESET_VALUES = [10_000_000, 100_000_000, 1_000_000_000] as const;
export const DEFAULT_TOTAL_TOKENS: number = TOKEN_PRESET_VALUES[1];

/** 输出占总用量 0.4%：agent 类实测口径（Claude Code 7.4 万轮约 0.44%），成本几乎全在输入。 */
const OUTPUT_SHARE = 0.004;

/** 用量口径：一个总量（快捷档位）+ 缓存命中率，不按计费档分别填。 */
export interface CalcUsage {
  total: number | null;
  hitRate: number | null;
}

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

/** 总花费 = 缓存读取×读取价 + 缓存写入×写入价 + 未命中输入×输入价 + 输出×输出价。
 *  用量按 agent 实测口径拆分：输出占 0.4%，其余是输入池；输入池按命中率切两段——
 *  命中段是从缓存读取的部分，未命中段是本次首次见到的内容，会写入缓存，所以默认按
 *  缓存写入计；站点没给缓存写入价时（多数站点缓存未命中就是普通输入价）回落按输入价计。
 *  四档固定返回：没填价的档 tokens 照常拆出，单价/小计/占比为 null——明细表据此
 *  照实展示该档用量并标注「未计入」，不让整行消失后占比看起来失真。 */
export function calcCost(prices: CalcPrices, usage: CalcUsage): CalcResult {
  const hit = parseHitRate(usage.hitRate != null ? String(usage.hitRate) : "") / 100;
  const totalTokens = positiveTokens(usage.total);
  const outputTokens = totalTokens * OUTPUT_SHARE;
  const inputTokens = totalTokens - outputTokens;
  const missTokens = inputTokens * (1 - hit);
  // 非命中输入：填了缓存写入价就按写入计，否则按输入价计——同一批 token，不重复计
  const writePriced = prices.cacheWrite !== null && prices.cacheWrite >= 0;
  const tokensByKey: Record<PriceKey, number> = {
    input: writePriced ? 0 : missTokens,
    output: outputTokens,
    cacheRead: inputTokens * hit,
    cacheWrite: writePriced ? missTokens : 0,
  };
  const lines: CostLine[] = PRICE_KEYS.map((key) => {
    const tokens = tokensByKey[key];
    const price = prices[key];
    const unitPrice = price !== null && price >= 0 ? price : null;
    return {
      key,
      unitPrice,
      tokens,
      subtotal: unitPrice !== null ? (tokens / TOKENS_PER_UNIT) * unitPrice : null,
      share: null,
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
  /** 总 token 用量；缺省回落默认档（1 亿） */
  totalTokens: number | null;
  /** 缓存命中率 0–100；缺省回落默认值（96） */
  hitRate: number | null;
}

export const EMPTY_PRICES: CalcPrices = {
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
};

/** 是否填了至少一档单价：决定结果区显示空态还是明细表。 */
export function hasAnyPrice(prices: CalcPrices): boolean {
  return PRICE_KEYS.some((key) => prices[key] !== null);
}

export const EMPTY_STATE: CalcState = {
  source: "official",
  model: "",
  site: "",
  currency: "USD",
  prices: EMPTY_PRICES,
  totalTokens: DEFAULT_TOTAL_TOKENS,
  hitRate: DEFAULT_HIT_RATE,
};

/** URL 参数名：短键，保证分享链接不至于过长。 */
const PARAM = {
  source: "src",
  model: "m",
  site: "s",
  currency: "cur",
  price: { input: "pi", output: "po", cacheRead: "pr", cacheWrite: "pw" },
  total: "t",
  hit: "h",
} as const;

function compact(value: number | null): string | undefined {
  return value === null ? undefined : String(value);
}

/** 状态 → query 参数；空值与默认值不写，保证链接干净。 */
export function encodeCalcState(state: CalcState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.source === "site") params.set(PARAM.source, "site");
  if (state.model) params.set(PARAM.model, state.model);
  if (state.site) params.set(PARAM.site, state.site);
  // USD 是解码默认值，省掉无损；其余币种必须写入，否则还原时币种会变
  if (state.currency && state.currency !== "USD") params.set(PARAM.currency, state.currency);
  for (const key of PRICE_KEYS) {
    const value = compact(state.prices[key]);
    if (value !== undefined) params.set(PARAM.price[key], value);
  }
  if (state.totalTokens != null && state.totalTokens !== DEFAULT_TOTAL_TOKENS) {
    params.set(PARAM.total, String(state.totalTokens));
  }
  if (state.hitRate != null && state.hitRate !== DEFAULT_HIT_RATE) {
    params.set(PARAM.hit, String(state.hitRate));
  }
  return params;
}

/** query 参数 → 状态；总量只认快捷档位，命中率缺失回落默认值。 */
export function decodeCalcState(params: URLSearchParams): CalcState {
  const prices = { ...EMPTY_PRICES };
  for (const key of PRICE_KEYS) {
    prices[key] = parseAmount(params.get(PARAM.price[key]) ?? "");
  }
  return {
    source: params.get(PARAM.source) === "site" ? "site" : "official",
    model: params.get(PARAM.model) ?? "",
    site: params.get(PARAM.site) ?? "",
    currency: (params.get(PARAM.currency) ?? "USD").toUpperCase(),
    prices,
    totalTokens: presetTotal(parseAmount(params.get(PARAM.total) ?? "")),
    hitRate: parseHitRate(params.get(PARAM.hit) ?? ""),
  };
}
