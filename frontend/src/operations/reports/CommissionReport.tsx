import { TimeOrderControl } from "../../shared/ui/TimeOrderControl";
import { ToolbarSelect } from "../../shared/ui/ToolbarSelect";
/** Commission：从 ReportsPage.tsx 拆出的单个报表视图。 */

import { Card, Segmented, Space } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useState } from "react";
import { useEmployeeOptions } from "../../shared/hooks/useEmployeeOptions";
import { reportsApi } from "../../shared/api/reports.api";
import type { CommissionOrderGroup, CommissionReport, CommissionRow } from "../../shared/api/types/reporting";
import { normalizeError } from "../../shared/api/client";
import { useListViewColumns } from "../../shared/lib/listColumns";
import { DataTable, ErrorBanner, MoneyText, StatRow } from "../../shared/ui";
import { Note, type ReportRange, useReport, useReportPagination } from "./shared";
import { ReportExportButton } from "./ReportExportButton";
import { CommissionDetailsTable } from "./CommissionDetailsTable";
import { useSession } from "../../shared/state/session";

export function Commission({ range, mine = false, onMineChange }: { range: ReportRange; mine?: boolean; onMineChange?: (mine: boolean) => void }) {
  const { params, picker } = range;
  const { can } = useSession();
  const [sortDesc, setSortDesc] = useState(true);
  const { employees, error: employeeCause, reloadFresh: reloadEmployees } = useEmployeeOptions();
  const employeeError = employeeCause ? { ...normalizeError(employeeCause), message: `员工目录加载失败：${normalizeError(employeeCause).message}` } : null;
  const [selectedUserId, setSelectedUserId] = useState<number>(0);
  const { page, pageSize, onPageChange } = useReportPagination(JSON.stringify([params.from, params.to, mine, selectedUserId, sortDesc]));
  const commissionParams = {
    ...(params.from ? { from: params.from } : {}),
    ...(params.to ? { to: params.to } : {}),
    ...(mine ? { mine: true } : {}),
    ...(!mine ? { all_people: true } : {}),
    ...(!mine && selectedUserId ? { user_id: selectedUserId } : {}),
  };
  const { data, loading, error, reload } = useReport<CommissionReport>(
    () => reportsApi.commission({ ...commissionParams, limit: pageSize, offset: (page - 1) * pageSize, sort_desc: sortDesc }),
    [params.from, params.to, mine, selectedUserId, page, pageSize, sortDesc],
  );
  const count = data?.total.order_count ?? 0;
  useEffect(() => {
    const lastPage = Math.max(1, Math.ceil(count / pageSize));
    if (data && page > lastPage) onPageChange(lastPage, pageSize);
  }, [count, data, page, pageSize, onPageChange]);
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
    { title: "分润人员", key: "user_name", width: 180, render: (_value, row) => peopleText(row) || "—" },
    { title: "分润合计", key: "profit_base", dataIndex: "profit_base", align: "right", render: (v: string) => <MoneyText value={v} /> },
  ];
  return (
    <Card className="glass" title={mine ? "我的收益" : "分润对账"}>
      <ErrorBanner error={error} onRetry={reload} retrying={loading} />
      <Space wrap className="ui-filter-bar ui-filter-bar--spaced">
        {picker}
        {onMineChange && can("report.read") ? <Segmented aria-label="分润范围" value={mine ? "mine" : "all"}
          options={[{ label: "我的收益", value: "mine" }, { label: "全员分润", value: "all" }]}
          onChange={(value) => onMineChange(value === "mine")} /> : null}
        {!mine ? (
          <ToolbarSelect
            value={selectedUserId}
            onChange={(value) => setSelectedUserId((value as number) || 0)}
            options={personOptions}
          />
        ) : null}
        <TimeOrderControl descending={sortDesc} onChange={setSortDesc} />
        <ReportExportButton name="commission" params={{ ...commissionParams, sort_desc: sortDesc }} />
      </Space>
      <ErrorBanner error={employeeError} onRetry={() => { void reloadEmployees().catch(() => undefined); }} />
      {mine ? <Note>仅展示当前登录用户在分润配置中获得的收益。</Note> : null}
      <StatRow
        items={[
          { label: mine ? "收益订单数" : "订单数", kind: "count", amount: data ? String(data.total.order_count) : null },
          { label: mine ? "我的收益" : "分润合计", amount: data?.total.profit_base ?? "-" },
        ]}
      />
      <DataTable<CommissionOrderGroup>
         className="ui-datatable--expandable"
         columns={arrangeCommission(columns)}
         rows={data?.order_groups ?? []}
         loading={loading}
         controlledPaging
         page={page}
         pageSize={pageSize}
         total={count}
         rowKey="order_id"
         expandable={{
           expandRowByClick: true,
           expandedRowRender: (row) => (
             <CommissionDetailsTable row={row} personName={personName} />
           ),
         }}
         emptyText={error ? "分润数据不可用，请点击重新加载" : "所选区间无分润记录"}
         onPageChange={onPageChange}
      />
    </Card>
  );
}
