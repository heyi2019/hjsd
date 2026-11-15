import { Fragment, useState, type ReactNode } from "react";

type LightweightColumn<T> = {
  title?: ReactNode;
  dataIndex?: string | readonly string[];
  render?: (value: unknown, row: T, index: number) => ReactNode;
};

type LightweightExpandable<T> = {
  expandedRowRender: (row: T, index: number) => ReactNode;
};

function readValue<T>(row: T, dataIndex?: string | readonly string[]): unknown {
  if (!dataIndex) return undefined;
  const path = Array.isArray(dataIndex) ? dataIndex : [dataIndex];
  return path.reduce<unknown>((value, key) => (
    value && typeof value === "object"
      ? (value as Record<string, unknown>)[key]
      : undefined
  ), row);
}

/**
 * 页面测试用的轻量表格边界。DataTable 自身的分页、空态和 AntD 集成
 * 由 DataTable.test.tsx 覆盖；页面测试只需要单元格内容与操作按钮。
 */
export function LightweightDataTable<T>({
  columns,
  rows,
  loading,
  expandable,
}: {
  columns: LightweightColumn<T>[];
  rows: T[];
  loading?: boolean;
  expandable?: LightweightExpandable<T>;
}) {
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  if (loading) return <div role="status">正在加载数据</div>;
  return (
    <table>
      <thead>
        <tr>{columns.map((column, index) => <th key={index}>{column.title}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => {
          const expanded = expandedRows.has(rowIndex);
          return (
            <Fragment key={rowIndex}>
              <tr>
                {expandable ? (
                  <td>
                    <button
                      type="button"
                      aria-label={`${expanded ? "收起" : "展开"}${(row as { order_no?: string }).order_no ?? ""}分润明细`}
                      onClick={() => setExpandedRows((current) => {
                        const next = new Set(current);
                        if (next.has(rowIndex)) next.delete(rowIndex); else next.add(rowIndex);
                        return next;
                      })}
                    >
                      {expanded ? "收起" : "展开"}
                    </button>
                  </td>
                ) : null}
                {columns.map((column, columnIndex) => {
                  const value = readValue(row, column.dataIndex);
                  return (
                    <td key={columnIndex}>
                      {column.render ? column.render(value, row, rowIndex) : String(value ?? "")}
                    </td>
                  );
                })}
              </tr>
              {expanded ? <tr><td colSpan={columns.length + 1}>{expandable?.expandedRowRender(row, rowIndex)}</td></tr> : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
