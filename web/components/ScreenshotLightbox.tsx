"use client";

import { Modal } from "./ui";
import { formatTime } from "@/lib/format";
import { shotSrc, type SiteShot } from "@/lib/screenshots";

/** 站点首页实拍大图：总览表缩略图点开的查看弹窗；点图新标签打开原站。 */
export function ScreenshotLightbox({
  siteId,
  siteName,
  shot,
  onClose,
}: {
  siteId: string | null;
  siteName?: string;
  shot: SiteShot | null;
  onClose: () => void;
}) {
  if (!siteId || !shot) return null;
  const name = siteName || siteId;
  return (
    <Modal open onClose={onClose} title={`站点首页实拍 · ${name}`} width={960}>
      <div style={{ display: "grid", gap: 10 }}>
        <a href={shot.url} target="_blank" rel="noreferrer" title="打开原站">
          <img
            src={shotSrc(siteId, shot)}
            alt={`${name} 首页截图`}
            style={{ width: "100%", height: "auto", borderRadius: 8, display: "block" }}
          />
        </a>
        <span style={{ color: "var(--text-3)", fontSize: 12.5 }}>
          {formatTime(shot.captured_at)} 拍摄 · 点图打开原站
        </span>
      </div>
    </Modal>
  );
}
