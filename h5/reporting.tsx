/** H5（≤640px）经营中心报表卡片列表。
 *
 * 通用实现：复用各报表已有 columns（title→标签、render/dataIndex→值），
 * 只为小屏换一种排布。仅 ≤640px（useCompactLayout）挂载，桌面与 jsdom 测试只渲染表格，
 * 卡片不进 DOM，单测零破坏。
 */
import type { ReactNode } from "react";

export type ReportCardColumn<T> = {
  title?: ReactNode;
  dataIndex?: string | string[];
  render?: (value: any, row: T, index: number) => ReactNode;
};

export function MobileReportCards<T>({
  rows,
  columns,
}: {
  rows: readonly T[];
  columns: readonly ReportCardColumn<T>[];
}) {
  return (
    <div className="data-mobile-list">
      {rows.map((row, index) => (
        <article className="data-mobile-card" key={index}>
          <dl className="data-mobile-meta">
            {columns.map((col, i) => {
              const value: ReactNode = col.render
                ? col.render((row as Record<string, unknown>)[col.dataIndex as string], row, index)
                : col.dataIndex
                ? ((row as Record<string, unknown>)[col.dataIndex as string] as ReactNode)
                : null;
              const label = typeof col.title === "string" ? col.title : "";
              return (
                <div key={i}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              );
            })}
          </dl>
        </article>
      ))}
    </div>
  );
}
