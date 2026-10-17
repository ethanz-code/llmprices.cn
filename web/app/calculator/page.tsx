import { apiGetOptional } from "@/lib/api";
import { decodeCalcState, EMPTY_STATE } from "@/lib/calculator";
import { Calculator } from "@/components/Calculator";
import { PageDigest } from "@/components/PageDigest";
import { SiteAlert } from "@/components/SiteAlert";
import { calculator } from "@/lib/copy";
import { formatCount } from "@/lib/format";
import type { CalcPriceRow, CatalogData, OverviewData } from "@/lib/types";
import { pageMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

export const metadata = pageMetadata(
  "花费计算",
  "按 token 用量算一笔账：同一次使用，厂商官方价和各家中转站价分别要花多少钱。",
  "/calculator",
);

export default async function CalculatorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") search.set(key, value);
  }
  // 两个价格源并行取数：任一不可用只影响对应模式，页面仍可手填单价使用
  const [catalog, overview] = await Promise.all([
    apiGetOptional<CatalogData>("/api/catalog"),
    apiGetOptional<OverviewData>("/api/overview"),
  ]);
  const initial = search.size > 0 ? decodeCalcState(search) : EMPTY_STATE;
  // 瘦身下发：整包 overview 记录里带着倍率/证据等留档字段，计算器只用下面这几个，
  // 整包传给客户端组件会整份内联进 HTML（2026-10-16 页面变慢修复）
  const priceRows: CalcPriceRow[] | null = overview
    ? overview.records.map((row) => ({
        site_id: row.site_id,
        model: row.model,
        input_price: row.input_price,
        output_price: row.output_price,
        unit: row.unit ?? "",
        group: row.metadata?.group ?? "",
        cache_read_price: row.metadata?.cache_read_price ?? null,
        cache_create_price: row.metadata?.cache_create_price ?? null,
      }))
    : null;

  return (
    <div className="page page-calc">
      <h1 className="sr-only">花费计算</h1>
      {!catalog && !overview && (
        <SiteAlert
          title={calculator.loadFailed.title}
          detail="厂商定价和最新价格都还没抓到"
          fix={calculator.loadFailed.fix}
        />
      )}
      {catalog && (
        <PageDigest
          items={[
            { label: "官方价模型", value: formatCount(Object.keys(catalog.models).length) },
            ...(priceRows ? [{ label: "站点", value: formatCount(new Set(priceRows.map((row) => row.site_id)).size) }] : []),
          ]}
        />
      )}
      <Calculator catalog={catalog} priceRows={priceRows} initial={initial} />
    </div>
  );
}
