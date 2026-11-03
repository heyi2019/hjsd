import type { ReactNode } from "react";

type LightweightColumn<T> = {
  title?: ReactNode;
  dataIndex?: string | readonly string[];
  render?: (value: unknown, row: T, index: number) => ReactNode;
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
}: {
  columns: LightweightColumn<T>[];
  rows: T[];
  loading?: boolean;
}) {
  if (loading) return <div role="status">正在加载数据</div>;
  return (
    <table>
      <thead>
        <tr>{columns.map((column, index) => <th key={index}>{column.title}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {columns.map((column, columnIndex) => {
              const value = readValue(row, column.dataIndex);
              return (
                <td key={columnIndex}>
                  {column.render ? column.render(value, row, rowIndex) : String(value ?? "")}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
