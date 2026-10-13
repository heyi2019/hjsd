/** 入口卡片：可点击的导航/动作卡（role=button，支持 Enter/Space 键盘触发）。
 *  用途：工作台「业务速览」区——新建业务动作卡 + 订单统计卡（点击进业务中心）。
 *  卡片只是容器，权限门控由页面层用 PermissionGate 决定是否渲染。 */
import type { ReactNode } from "react";

export type EntryTone = "plain" | "primary" | "warn";

export function EntryCard(props: {
  title: string;
  /** 主数值（计数/金额字符串）；动作卡可省略。 */
  value?: ReactNode;
  /** 说明文案：动作卡写清点击后发生什么；统计卡写清点击后去哪里。 */
  description?: string;
  tone?: EntryTone;
  onClick: () => void;
}) {
  const activate = () => props.onClick();
  return (
    <div
      className={`ui-entry-card ui-entry-card--${props.tone ?? "plain"}`}
      role="button"
      tabIndex={0}
      onClick={activate}
      onKeyDown={(event) => {
        // 键盘可达性：div+role=button 不会自发响应 Enter/Space，必须显式处理。
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
      }}
    >
      <span className="ui-entry-card__title">{props.title}</span>
      {props.value !== undefined && props.value !== null ? (
        <span className="ui-entry-card__value">{props.value}</span>
      ) : null}
      {props.description ? <span className="ui-entry-card__desc muted">{props.description}</span> : null}
    </div>
  );
}

/** 入口卡横向栅格：与 StatRow 同款 auto-fit 节奏，四卡一行、窄屏自动折行。 */
export function EntryRow(props: { children: ReactNode }) {
  return <div className="ui-entry-row">{props.children}</div>;
}
