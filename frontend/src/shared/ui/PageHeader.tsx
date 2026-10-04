/** 页面标题条：标题 + 说明 + 右侧动作区（动作受权限门控）。 */
import type { ReactNode } from "react";

export function PageHeader(props: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="ui-page-header">
      <div className="ui-page-header__text">
        <h2 className="ui-page-header__title">{props.title}</h2>
        {props.description ? (
          <p className="ui-page-header__desc muted">{props.description}</p>
        ) : null}
      </div>
      {props.actions ? <div className="ui-page-header__actions">{props.actions}</div> : null}
    </header>
  );
}
