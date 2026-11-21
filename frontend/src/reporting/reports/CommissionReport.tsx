import { TimeOrderControl } from "../../shared/ui/TimeOrderControl";
import { ToolbarSelect } from "../../shared/ui/ToolbarSelect";
/** Commission：从 ReportsPage.tsx 拆出的单个报表视图。 */

import { Card, Space } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useState } from "react";
import { useEmployeeOptions } from "../../shared/hooks/useEmployeeOptions";
import { reportsApi } from "../../shared/api/reports.api";
import type { CommissionOrderGroup, CommissionReport, CommissionRow } from "../../shared/api/types/reporting";
import { normalizeError } from "../../shared/api/client";
import { useListViewColumns } from "../../shared/lib/listColumns";
import { DataTable, ErrorBanner, MoneyText, StatRow } from "../../shared/ui";
import { Note, type ReportRange, useReport } from "./shared";
import { ReportExportButton } from "./ReportExportButton";
import "./CommissionReport.css";

export function Commission({ range, mine = false }: { range: ReportRange; mine?: boolean }) {
  const { params, picker } = range;
  const [sortDesc, setSortDesc] = useState(true);
  const { employees, error: employeeCause } = useEmployeeOptions();
  const employeeError = employeeCause ? normalizeError(employeeCause) : null;
  const [selectedUserId, setSelectedUserId] = useState<number>(0);
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
  const orderRows = [...(data?.order_groups ?? [])].sort((a, b) => (sortDesc ? -1 : 1) * ((a.outbound_date ?? a.inventory_date ?? "").localeCompare(b.outbound_date ?? b.inventory_date ?? "") || a.order_id - b.order_id));
  const employeeOptions = new Map(employees.map((employee) => [employee.id, { name: employee.display_name, isActive: employee.is_active }]));
  for (const person of data?.people ?? []) {
    employeeOptions.set(person.user_id, { name: person.user_name, isActive: person.is_active });
  }
  const personOptions = [
    { value: 0, label: "全部" },
    ...Array.from(employeeOptions, ([id, employee]) => ({ value: id, label: `${employee.name}${employee.isActive ? "" : "（已停用）"}` })),
  ];
  const personName = (row: CommissionRow) => row.user_id == null ? "公司" : row.user_name || employeeOptions.get(row.user_id)?.name || `人员${row.user_id}`;
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
      <Space wrap className="ui-filter-bar ui-filter-bar--spaced">
        {picker}
        {!mine ? (
          <ToolbarSelect
            value={selectedUserId}
            onChange={(value) => setSelectedUserId((value as number) || 0)}
            options={personOptions}
          />
        ) : null}
        <TimeOrderControl descending={sortDesc} onChange={setSortDesc} />
        <ReportExportButton name="commission" params={commissionParams} />
      </Space>
      <ErrorBanner error={employeeError} />
      {mine ? <Note>仅展示当前登录用户在分润配置中获得的收益。</Note> : null}
      <StatRow
        items={[
          { label: mine ? "收益订单数" : "订单数", kind: "count", amount: data ? String(data.total.order_count) : null },
          { label: mine ? "我的收益" : "分润合计", amount: data?.total.profit_base ?? "-" },
        ]}
      />
      <DataTable<CommissionOrderGroup>
         className="commission-table"
         columns={arrangeCommission(columns)}
         rows={orderRows}
         loading={loading}
         resetKey={JSON.stringify([params.from, params.to, mine, selectedUserId, sortDesc])}
         page={1}
         pageSize={10}
         total={data?.total.order_count ?? 0}
         rowKey="order_id"
         expandable={{
           expandRowByClick: true,
           expandedRowRender: (row) => (
             <div className="ui-table-wrap commission-detail-container">
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
             </div>
           ),
         }}
         emptyText={error ? "分润数据不可用，请点击重新加载" : "所选区间无分润记录"}
         onPageChange={() => undefined}
      />
    </Card>
  );
}
