/** Commission：从 ReportsPage.tsx 拆出的单个报表视图。 */

import { Card, Space } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useState, type MouseEvent } from "react";
import { employeesApi } from "../../shared/api/org.api";
import { reportsApi } from "../../shared/api/reports.api";
import type { CommissionOrderGroup, CommissionReport, CommissionRow } from "../../shared/api/types/reporting";
import { normalizeError } from "../../shared/api/client";
import { useListViewColumns } from "../../shared/lib/listColumns";
import { DataTable, ErrorBanner, MoneyText, Select, StatRow } from "../../shared/ui";
import { Note, type ReportRange, useReport } from "./shared";
import { ReportExportButton } from "./ReportExportButton";

export function Commission({ range, mine = false }: { range: ReportRange; mine?: boolean }) {
  const { params, picker } = range;
  const [employees, setEmployees] = useState<{ id: number; username: string; display_name: string; is_active: boolean }[]>([]);
  const [employeeError, setEmployeeError] = useState<{ message: string; code?: string } | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<number>(0);
  useEffect(() => {
    if (mine) return;
    let mounted = true;
    employeesApi.list()
      .then((items) => {
        if (!mounted) return;
        setEmployees(items);
        setEmployeeError(null);
      })
      .catch((error) => {
        if (mounted) setEmployeeError(normalizeError(error));
      });
    return () => { mounted = false; };
  }, [mine]);
  const commissionParams = {
    ...(params.from ? { from: params.from } : {}),
    ...(params.to ? { to: params.to } : {}),
    ...(mine ? { mine: true } : {}),
    ...(!mine ? { all_people: true } : {}),
    ...(!mine && selectedUserId ? { user_id: selectedUserId } : {}),
  };
  const { data, loading, error, reload } = useReport<CommissionReport>(
    () => reportsApi.commission(commissionParams),
    [params.from, params.to, mine, selectedUserId],
  );
  const orderRows = data?.order_groups ?? [];
  const employeeNames = new Map(employees.map((employee) => [employee.id, employee.display_name]));
  const personName = (row: CommissionRow) => row.user_id == null ? "公司" : employeeNames.get(row.user_id) ?? `人员${row.user_id}`;
  const peopleText = (row: CommissionOrderGroup) => Array.from(new Set(row.orders.map(personName))).join("、");
  const dateText = (value?: string | null) => value || "—";
  const { arrange: arrangeCommission } = useListViewColumns("RPT_COMMISSION");
  const columns: ColumnsType<CommissionOrderGroup> = [
    { title: "订单号", key: "order_no", dataIndex: "order_no", width: 160 },
    { title: "入库日期", key: "inventory_date", dataIndex: "inventory_date", width: 120, render: (v: string | null) => dateText(v) },
    { title: "出库日期", key: "outbound_date", dataIndex: "outbound_date", width: 120, render: (v: string | null) => dateText(v) },
    { title: "分润人员", key: "people", width: 180, render: (_value, row) => peopleText(row) || "—" },
    { title: "分润合计", key: "profit_base", dataIndex: "profit_base", align: "right", render: (v: string) => <MoneyText value={v} /> },
  ];
  return (
    <Card className="glass" title={mine ? "我的收益" : "分润对账"}>
      <ErrorBanner error={error} onRetry={reload} retrying={loading} />
      <Space className="ui-filter-bar ui-filter-bar--spaced">
        {!mine ? (
          <Select
            value={selectedUserId}
            onChange={(value) => setSelectedUserId((value as number) || 0)}
            options={[
              { value: 0, label: "全部" },
              ...employees.map((employee) => ({ value: employee.id, label: employee.display_name })),
            ]}
            className="ui-control-width-import"
          />
        ) : null}
        {picker}
      </Space>
      <ErrorBanner error={employeeError} />
      {mine ? <Note>仅展示当前登录用户在分润配置中获得的收益。</Note> : null}
      <StatRow
        items={[
          { label: mine ? "收益订单数" : "订单数", kind: "count", amount: String(data?.total.order_count ?? 0) },
          { label: mine ? "我的收益" : "分润合计", amount: data?.total.profit_base ?? "-" },
        ]}
      />
      <DataTable<CommissionOrderGroup>
         columns={arrangeCommission(columns)}
         rows={orderRows}
         loading={loading}
         page={1}
         pageSize={10}
         total={data?.total.order_count ?? 0}
         rowKey="order_id"
         expandable={{
           expandedRowRender: (row) => (
             <table className="commission-detail-table">
               <thead><tr><th>分润人员</th><th>分润基数</th><th>费率</th></tr></thead>
               <tbody>
                 {row.orders.map((detail, index) => (
                   <tr key={`${row.order_id}-${detail.user_id ?? "company"}-${index}`}>
                     <td>{personName(detail)}</td>
                     <td><MoneyText value={detail.profit_base} /></td>
                     <td>{detail.rate}</td>
                   </tr>
                 ))}
               </tbody>
             </table>
           ),
           expandIcon: ({ expanded, onExpand, record }) => (
             <span
               role="button"
               tabIndex={0}
               aria-label={`${expanded ? "收起" : "展开"}${record.order_no}分润明细`}
               onClick={(event) => onExpand(record, event)}
               onKeyDown={(event) => {
                 if (event.key === "Enter" || event.key === " ") onExpand(record, event as unknown as MouseEvent<HTMLElement>);
               }}
             >
               {expanded ? "收起" : "展开"}
             </span>
           ),
         }}
         emptyText="所选区间无分润记录"
         onPageChange={() => undefined}
      />
      {/* 复用与列表完全相同的筛选对象，确保「我的收益/指定员工」导出与页面同口径（#8）。 */}
      <ReportExportButton name="commission" params={commissionParams} />
    </Card>
  );
}
