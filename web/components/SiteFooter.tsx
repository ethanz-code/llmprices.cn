"use client";

import Link from "next/link";
import { IconGithub, IconMail } from "./icons";
import { LogoMark } from "./LogoMark";
import { CONTACT_EMAIL, CONTACT_WECOM_URL, footer, site } from "@/lib/copy";
import { useAuthPage } from "@/lib/useAuthPage";

/** 全站页脚：品牌 + 一句话说明合并数据免责；企业微信二维码（联系人名片码）平铺右列，客服是紧邻的文字链接。 */
export function SiteFooter() {
  if (useAuthPage()) return null;
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-brand">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <LogoMark size={20} />
            <span style={{ fontFamily: "var(--mono)", fontWeight: 600, lineHeight: 1, translate: "0 1px", color: "var(--text)" }}>{site.name}</span>
          </div>
          {/* 文案里的 \n 是真实换行：免责声明一行，祝语另起一行 */}
          <p style={{ whiteSpace: "pre-line" }}>{footer.brandLine}</p>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <a
              className="footer-icon"
              href="https://github.com/ethanz-code/llmprices.cn"
              target="_blank"
              rel="noreferrer"
              aria-label={footer.aria.github}
            >
              <IconGithub size={18} />
            </a>
            <a className="footer-icon" href={`mailto:${CONTACT_EMAIL}`} aria-label={footer.aria.mail}>
              <IconMail size={18} />
            </a>
          </div>
        </div>
        <div className="site-footer-qr">
          {/* 白底内衬是二维码的 quiet zone，被页脚底色包住也能扫。这是企业联系人名片码，客服走下面的文字链接 */}
          <img src={footer.wecomQrSrc} alt="企业微信联系二维码" width={84} height={84} loading="lazy" />
          <div className="site-footer-qr-text">
            <span className="qr-title">扫码加我们企业微信</span>
            <span className="qr-sub">咨询、建议、合作都欢迎</span>
            <a className="qr-link" href={CONTACT_WECOM_URL} target="_blank" rel="noreferrer">
              提建议、报站点，点这里找{footer.wecomContact} →
            </a>
          </div>
        </div>
      </div>
      <div className="site-footer-meta">
        <span>© 2026 {site.name}</span>
        <span className="site-footer-meta-links">
          <Link href="/history">{footer.links.history}</Link>
          <Link href="/articles">{footer.links.articles}</Link>
          <a href={CONTACT_WECOM_URL} target="_blank" rel="noreferrer">{footer.links.feedback}</a>
        </span>
      </div>
    </footer>
  );
}
