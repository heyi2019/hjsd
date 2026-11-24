/** 统一列表壳：分页、加载、空态一致；列宽与金额右对齐在此收敛。
 *
 * 分页双模式（由 controlledPaging 显式区分，不靠函数体嗅探，避免生产构建被压缩后误判）：
 *  - 前端分页（默认，缺省 controlledPaging）：调用方一次加载全量 rows，DataTable 内部自管
 *    current/pageSize，antd 直接对 dataSource 切片。适用于所有只读/全量展示列表。
 *  - 服务端分页（controlledPaging=true）：调用方自管 page/pageSize 并向后端取数
 *    （如历史批次行用 offset 分页），DataTable 完全受控。
 */
import { Spin, Table } from "antd";
import type { ColumnsType, TableProps } from "antd/es/table";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

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
  /** 前端分页的筛选或时序变化时，重置到第一页；页大小保持不变。 */
  resetKey?: string | number | boolean;
  rowKey?: string | ((row: T) => string);
  ariaLabel?: string;
  emptyText?: string;
  /** 需要展开行（如分期期次明细）时透传，其余场景不必传。 */
  expandable?: TableProps<T>["expandable"];
  /** 横向滚动默认已开（x:"max-content"）：内容超出容器时自动可滑动；传此 prop 可覆盖默认值。 */
  scroll?: TableProps<T>["scroll"];
  /** 需要隐藏或自定义分页时透传给 antd；未传时保持统一默认分页。 */
  pagination?: TableProps<T>["pagination"];
  /** 需要行选择（批量操作）时透传给 antd；未传时不渲染选择框。 */
  rowSelection?: TableProps<T>["rowSelection"];
  /** 需要给行挂事件/属性（如拖拽排序）时透传给 antd；未传时用默认渲染。 */
  onRow?: TableProps<T>["onRow"];
  className?: string;
  size?: TableProps<T>["size"];
}) {
  const defaultRowKey = (row: T) => {
    const candidate = row as T & {
      id?: string | number;
      key?: string | number;
      code?: string | number;
      no?: string | number;
    };
    return String(candidate.id ?? candidate.key ?? candidate.code ?? candidate.no ?? JSON.stringify(row));
  };
  // 前端分页自管状态：默认开启；显式 controlledPaging 时交回调用方做服务端分页。
  const [innerPage, setInnerPage] = useState(1);
  const [innerSize, setInnerSize] = useState(props.pageSize ?? 10);
  const controlled = props.controlledPaging === true;
  // 记录调用方上一次传入的 page 值：仅当该值「真的发生变化」时才重置内部页码。
  // 不依赖 innerPage 判断，否则内部翻页（onChange→setInnerPage）会被立刻拉回 props.page，
  // 形成反馈闭环，使客户端自管翻页永远停在首页（行 11 永不出现）。回归见 DataTable.test
  // 用例“前端分页（默认）内部自管翻页，不回调调用方”。
  const prevPageRef = useRef(props.page);
  const settledRows = useRef<T[]>([]);
  const tableContent = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!props.loading) settledRows.current = props.rows;
  }, [props.loading, props.rows]);
  const displayedRows = props.loading ? settledRows.current : props.rows;
  const refreshing = Boolean(props.loading && displayedRows.length);
  useLayoutEffect(() => {
    tableContent.current?.toggleAttribute("inert", refreshing);
  }, [refreshing]);

  useEffect(() => {
    // 前端分页：尊重调用方期望的每页大小（缺省 10）；prop 变化时同步，覆盖初始值。
    // 受控分页（controlledPaging）完全由调用方驱动，无需内管页大小。
    if (!controlled && props.pageSize) setInnerSize(props.pageSize);
  }, [controlled, props.pageSize]);

  useEffect(() => {
    // 前端分页时同步调用方的页码期望：仅当「调用方把 page 改成了新值」（如筛选变化后
    // setPage(1)）才重置内部页码，避免吞掉翻页信号导致空白页。
    // 依赖只放 [controlled, props.page] —— 不放 innerPage，否则内部翻页会被立即拉回。
    if (controlled) return;
    if (props.page && props.page !== prevPageRef.current) {
      prevPageRef.current = props.page;
      setInnerPage(props.page);
    }
  }, [controlled, props.page]);

  useEffect(() => {
    if (!controlled && props.resetKey !== undefined) setInnerPage(1);
  }, [controlled, props.resetKey]);

  if (props.loading && !refreshing) {
    return (
      <div className="ui-table-loading" role="status" aria-live="polite" aria-busy="true" aria-label="正在加载数据">
        <Spin />
      </div>
    );
  }
  const defaultPagination = controlled
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
  const pagination = props.pagination !== undefined ? props.pagination : defaultPagination;
  const tableScroll = displayedRows.length > 0 ? (props.scroll ?? { x: "max-content" }) : undefined;

  return (
    <div className={`ui-table-wrap ui-datatable${props.className ? ` ${props.className}` : ""}`}>
      <div ref={tableContent} aria-hidden={refreshing || undefined} aria-busy={refreshing || undefined}>
        <Table<T>
          aria-label={props.ariaLabel}
          size={props.size ?? "small"}
          columns={props.columns}
          dataSource={displayedRows}
          rowKey={props.rowKey ?? defaultRowKey}
          expandable={props.expandable}
          rowSelection={props.rowSelection}
          onRow={props.onRow}
          // 有数据时横向滚动为默认标准；空数据不启用滚动容器，避免 antd 空态被固定高度或
          // max-content 撑高。调用方传 scroll 仍只对有数据的表格生效。
          scroll={tableScroll}
          pagination={pagination}
          locale={{
            emptyText: <div className="ui-datatable__empty">{props.emptyText ?? "暂无数据"}</div>,
          }}
        />
      </div>
      {refreshing ? <div className="ui-table-refresh" role="status" aria-live="polite" aria-label="正在更新数据"><Spin size="small" /><span>正在更新数据…</span></div> : null}
    </div>
  );
}
