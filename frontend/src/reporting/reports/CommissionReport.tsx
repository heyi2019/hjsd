/** Commission：从 ReportsPage.tsx 拆出的单个报表视图。 */

import { Card, Space, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useState } from "react";
import { employeesApi, reportsApi, type CommissionReport, type CommissionRow } from "../../shared/api/catalog";
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
  const { arrange: arrangeCommission } = useListViewColumns("RPT_COMMISSION");
  const hasUnassignedRows = (data?.items ?? []).some((row) => row.user_id == null);
  const columns: ColumnsType<CommissionRow> = [
    ...(mine ? [] : [{ title: "人员 ID", dataIndex: "user_id", width: 100 }]),
    { title: "订单号", dataIndex: "order_no", width: 160 },
    { title: "订单利润基数", dataIndex: "profit_base", align: "right", render: (v: string) => <MoneyText value={v} />},
    { title: "费率", dataIndex: "rate", align: "right", width: 90},
    { title: "应付", dataIndex: "payable", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "已付", dataIndex: "paid", align: "right", render: (v: string) => <MoneyText value={v} />},
    {
      title: "差异",
      dataIndex: "difference",
      align: "right",
      render: (v: string) => <MoneyText value={v} tone="auto" strong />,
    },
  ];
  return (
    <Card className="glass" title={mine ? "我的收益" : "提成对账 R3"}>
      <ErrorBanner error={error} onRetry={reload} retrying={loading} />
      <Space className="ui-filter-bar">
        {!mine ? (
          <Select
            value={selectedUserId}
            onChange={(value) => setSelectedUserId((value as number) || 0)}
            options={[
              { value: 0, label: "全部" },
              ...employees.map((employee) => ({ value: employee.id, label: `${employee.display_name}（${employee.username}）` })),
            ]}
            className="ui-control-width-import"
          />
        ) : null}
        {picker}
      </Space>
      <ErrorBanner error={employeeError} />
      {mine ? <Note>仅展示当前登录用户在分润配置中获得的收益。</Note> : null}
      {hasUnassignedRows ? (
        <Typography.Text type="warning" role="alert" className="report-warning">
          存在未分配人员的提成记录，请补充分润人员后再进行对账。
        </Typography.Text>
      ) : null}
      <StatRow
        items={[
          { label: mine ? "收益订单数" : "订单数", kind: "count", amount: String(data?.total.order_count ?? 0) },
          { label: mine ? "我的收益" : "分润基数", amount: data?.total.profit_base ?? "-" },
          { label: "应付合计", amount: data?.total.payable ?? "-" },
          { label: "已付合计", amount: data?.total.paid ?? "-" },
          { label: "差异", amount: data?.total.difference ?? "-", tone: "auto" },
        ]}
      />
             <DataTable<CommissionRow>
         columns={arrangeCommission(columns)}
         rows={data?.items ?? []}
         loading={loading}
         page={1}
         pageSize={10}
         total={data?.items.length ?? 0}
         emptyText="所选区间无提成记录"
         onPageChange={() => undefined}
      />
      <ReportExportButton name="commission" params={params} />
    </Card>
  );
}
