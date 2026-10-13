/** 统一列表壳：分页、加载、空态一致；列宽与金额右对齐在此收敛。
 *
 * 分页双模式（由 controlledPaging 显式区分，不靠函数体嗅探，避免生产构建被压缩后误判）：
 *  - 前端分页（默认，缺省 controlledPaging）：调用方一次加载全量 rows，DataTable 内部自管
 *    current/pageSize，antd 直接对 dataSource 切片。适用于所有只读/全量展示列表。
 *  - 服务端分页（controlledPaging=true）：调用方自管 page/pageSize 并向后端取数
 *    （如历史批次行用 offset 分页），DataTable 完全受控。
 */
import { Empty, Spin, Table } from "antd";
import type { ColumnsType, TableProps } from "antd/es/table";
import { useEffect, useState } from "react";

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
  /** true=受控服务端分页（调用方自管 page/pageSize 并向后端取数）；
   *  缺省=前端分页（调用方一次加载全量 rows，DataTable 内部自管翻页）。 */
  controlledPaging?: boolean;
  rowKey?: string | ((row: T) => string);
  emptyText?: string;
  /** 需要展开行（如分期期次明细）时透传，其余场景不必传。 */
  expandable?: TableProps<T>["expandable"];
  size?: TableProps<T>["size"];
}) {
  // 前端分页自管状态：默认开启；显式 controlledPaging 时交回调用方做服务端分页。
  const [innerPage, setInnerPage] = useState(1);
  const [innerSize, setInnerSize] = useState(props.pageSize ?? 10);
  const controlled = props.controlledPaging === true;

  useEffect(() => {
    // 前端分页：尊重调用方期望的每页大小（缺省 10）；prop 变化时同步，覆盖初始值。
    // 受控分页（controlledPaging）完全由调用方驱动，无需内管页大小。
    if (!controlled && props.pageSize) setInnerSize(props.pageSize);
  }, [controlled, props.pageSize]);

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

  const pagination = controlled
    ? {
        current: props.page,
        pageSize: props.pageSize,
        total: props.total,
        showSizeChanger: true,
        onChange: props.onPageChange,
      }
    : {
        current: innerPage,
        pageSize: innerSize,
        total: props.total,
        showSizeChanger: true,
        onChange: (p: number, s: number) => {
          setInnerPage(p);
          setInnerSize(s);
        },
      };

  return (
    <div className="ui-table-wrap">
      <Table<T>
        size={props.size ?? "small"}
        columns={props.columns}
        dataSource={props.rows}
        rowKey={props.rowKey ?? ("id" as never)}
        expandable={props.expandable}
        pagination={pagination}
      />
    </div>
  );
}
