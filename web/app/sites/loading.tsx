import { Skel } from "@/components/ui";

/** /sites 骨架：与真实首屏同构（页头两行 + 摘要条三项 + 站点卡网格）。
 *  网格复用 .site-grid 的列宽、卡片复用 .site-card 的内距与节奏，换入时只剩「灰条 → 文字」的原位变化；
 *  条块带负相位错峰（Skel delay），整页 shimmer 呈波浪扫过。 */
export default function Loading() {
  return (
    <div className="page">
      <div className="page-header">
        <div style={{ display: "grid", gap: 12 }}>
          <Skel w={168} h={26} />
          <Skel w="min(640px, 90%)" h={14} />
        </div>
      </div>
      <div className="page-digest" aria-hidden>
        {["站点", "启用中", "已停用"].map((label, index) => (
          <span key={label} className="page-digest-item">
            <Skel w={label.length * 13} h={11} delay={index * 90} />
            <Skel w={56} h={20} delay={index * 90 + 45} />
          </span>
        ))}
      </div>
      <div className="site-grid">
        {Array.from({ length: 18 }, (_, index) => (
          <div key={index} className="site-card" aria-hidden>
            <span className="site-card-head">
              <Skel w={8} h={8} style={{ borderRadius: 9999 }} delay={index * 90} />
              <Skel w="56%" h={13} delay={index * 90 + 40} />
              <Skel w={32} h={13} style={{ marginLeft: "auto" }} delay={index * 90 + 80} />
            </span>
            <Skel h={14} delay={index * 90 + 120} />
            <Skel w="45%" h={12} delay={index * 90 + 160} />
          </div>
        ))}
      </div>
    </div>
  );
}
