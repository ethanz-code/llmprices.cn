/** 站点展示元数据：id → 名称/官网。名称由前端内置映射维护；
 *  官网优先用管理台配置的「站点首页」（覆盖表），其次内置映射，最后回退来源 URL 的域名。 */

import { apiGet } from "./api";

export interface SiteInfo {
  name: string;
  homepage: string;
}

/** 站点首页覆盖表：site_id → 管理台配置的首页地址（只含配过的站） */
export type SiteHomepages = Record<string, string>;

/** 站点主域名后备表：site_id → 站点根地址（后端从采集地址推导，已配首页的站同值）。
 *  公告事件没有来源 URL，站名外链用它代替 originOf(sourceUrl)。 */
export type SiteOrigins = Record<string, string>;

export interface SiteLinkTables {
  homepages: SiteHomepages;
  origins: SiteOrigins;
}

const SITE_MAP: Record<string, SiteInfo> = {
  sudocode: { name: "SudoCode", homepage: "https://sudocode.chat" },
  cun: { name: "CUN.AI", homepage: "https://www.cun.ai" },
  modelflare: { name: "Modelflare", homepage: "https://modelflare.dev" },
  "downstream-jbbtoken": { name: "JBB 金贝贝", homepage: "https://downstream.jbbtoken.cn" },
  totokens: { name: "To-Tokens", homepage: "https://totokens.cc" },
  icodeeasy: { name: "I Code Easy", homepage: "https://icodeeasy.cc" },
  hao: { name: "HaoAI", homepage: "https://hao.ai" },
  // 站点 id 保留历史值 aheapi：站方 2026-10-13 停用旧域迁到 heyroute.ai，历史价格/事件都挂原 id
  aheapi: { name: "HeyRoute", homepage: "https://heyroute.ai" },
};

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** 服务端一次读取站名外链需要的两张表；拉不到返回空表，站名链接退回内置映射/来源域名，不阻塞页面。 */
export async function loadSiteLinks(): Promise<SiteLinkTables> {
  try {
    const data = await apiGet<{ homepages?: SiteHomepages; origins?: SiteOrigins }>("/api/sites/homepages");
    return { homepages: data.homepages ?? {}, origins: data.origins ?? {} };
  } catch {
    return { homepages: {}, origins: {} };
  }
}

/** 服务端读取站点首页覆盖表；拉不到返回空表，站名链接退回内置映射/来源域名后备，不阻塞页面。 */
export async function loadSiteHomepages(): Promise<SiteHomepages> {
  return (await loadSiteLinks()).homepages;
}

/** 解析站点信息：名称按内置映射（没有就用 id）；官网按「配置的首页 > 内置映射 > 来源 URL 域名」。
 *  homepages 是 loadSiteHomepages 的结果，渲染站名链接的页面/组件要把它传进来；
 *  入口在 API 子域、来源域名不是可看页面的站（如 4aicode）靠它链到真实首页。 */
export function getSiteInfo(siteId: string, sourceUrl?: string, homepages?: SiteHomepages): SiteInfo {
  const known = SITE_MAP[siteId];
  const configured = homepages?.[siteId];
  if (known || configured) {
    return {
      name: known?.name ?? siteId,
      homepage: configured ?? known?.homepage ?? (sourceUrl ? originOf(sourceUrl) ?? "" : ""),
    };
  }
  const fallback = sourceUrl ? originOf(sourceUrl) : null;
  return {
    name: siteId,
    homepage: fallback ?? "",
  };
}
