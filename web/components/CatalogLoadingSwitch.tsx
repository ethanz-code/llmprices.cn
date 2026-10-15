"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { CatalogAllLoading, CatalogLoading } from "./PageLoading";

/** 厂商定价页骨架按当前视图选形：官方定价 6 列 / 全量渠道 7 列（多一条筛选行）。
 *  loading.tsx 是路由级 fallback，拿不到 searchParams，只能由客户端读 ?view= 决定。 */
function Switcher() {
  const view = useSearchParams().get("view");
  return view === "all" ? <CatalogAllLoading /> : <CatalogLoading />;
}

export function CatalogLoadingSwitch() {
  return (
    <Suspense fallback={<CatalogLoading />}>
      <Switcher />
    </Suspense>
  );
}
