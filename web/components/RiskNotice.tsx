import { IconAlertCircle } from "@/components/icons";

/**
 * 风险提示条：站点选择建议、榜单口径、消费免责的统一呈现。
 * 与出错告警（SiteAlert 的黄底通栏）刻意区分——这里是常态提醒，不报警，
 * 所以用白卡 + 中性图标，靠「白卡浮在浅灰页底」分层，不加彩色条也不加描边。
 */
export function RiskNotice({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`risk-notice${className ? ` ${className}` : ""}`}>
      <IconAlertCircle size={14} className="risk-notice-icon" />
      <div>
        <div className="risk-notice-title">{title}</div>
        <div className="risk-notice-desc">{children}</div>
      </div>
    </div>
  );
}
