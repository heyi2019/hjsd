/** 统一列表壳：分页、加载、空态一致；列宽与金额右对齐在此收敛。 */
import { Empty, Spin, Table } from "antd";
import type { ColumnsType, TableProps } from "antd/es/table";

export interface ListQuery {
  page: number;
  page_size: number;
  keyword?: string;
  from?: string;
  to?: string;
}

export function DataTable<T>(props: {
  columns: ColumnsType<T>;
  rows: T[];
  loading?: boolean;
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number, pageSize: number) => void;
  rowKey?: string | ((row: T) => string);
  emptyText?: string;
  /** 需要展开行（如分期期次明细）时透传，其余场景不必传。 */
  expandable?: TableProps<T>["expandable"];
  size?: TableProps<T>["size"];
}) {
  if (props.loading) {
    return (
      <div className="ui-table-loading">
        <Spin />
      </div>
    );
  }
  if (!props.rows.length) {
    return <Empty description={props.emptyText ?? "暂无数据"} />;
  }
  return (
    <div className="ui-table-wrap">
      <Table<T>
        size={props.size ?? "small"}
        columns={props.columns}
        dataSource={props.rows}
        rowKey={props.rowKey ?? ("id" as never)}
        expandable={props.expandable}
        pagination={{
          current: props.page,
          pageSize: props.pageSize,
          total: props.total,
          showSizeChanger: true,
          onChange: props.onPageChange,
        }}
      />
    </div>
  );
}
