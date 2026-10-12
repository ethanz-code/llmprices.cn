/** 站点截图元数据：图片本体走 /api/sites/{id}/screenshot，这里只拿地址与拍摄时间。 */

import { apiGet } from "./api";

export interface SiteShot {
  /** 拍摄时打开的地址（站点首页）：点图新标签打开它 */
  url: string;
  /** 拍摄时间（秒级时间戳）：同时用作图片地址的版本参数，新截图自动换地址 */
  captured_at: number;
  bytes: number;
}

export type SiteShots = Record<string, SiteShot>;

/** 服务端读取全部站点截图元数据；拉不到返回空表（截图区/缩略图列整体不渲染），不阻塞页面。 */
export async function loadSiteScreenshots(): Promise<SiteShots> {
  try {
    const data = await apiGet<{ screenshots?: SiteShots }>("/api/sites/screenshots");
    return data.screenshots ?? {};
  } catch {
    return {};
  }
}

/** 截图图片地址：带拍摄时间做版本参数；传 width 取缩略图（表格一屏几十张，原图太沉）。 */
export function shotSrc(siteId: string, shot: SiteShot, width?: number): string {
  const version = `v=${encodeURIComponent(String(shot.captured_at))}`;
  return `/api/sites/${encodeURIComponent(siteId)}/screenshot?${version}${width ? `&w=${width}` : ""}`;
}
