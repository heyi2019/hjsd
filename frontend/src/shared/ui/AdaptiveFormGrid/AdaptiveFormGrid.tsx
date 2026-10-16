import type { ReactNode } from "react";
import "./AdaptiveFormGrid.css";

/** 按自身容器宽度自适应为 1/2/3/4 列的通用表单网格。 */
export function AdaptiveFormGrid(props: { children: ReactNode; className?: string }) {
  return <div className={["adaptive-form-grid", props.className].filter(Boolean).join(" ")}>{props.children}</div>;
}
