/** 资金对账 Tab：对账记录列表、创建与处理。 */
import { Card, Space, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { DataTable, ErrorBanner, MoneyText, PermissionButton, StatusTag } from "../../shared/ui";
import { useListViewColumns } from "../../shared/lib/listColumns";
import { today } from "../../shared/lib/format";
import { configurableLabel } from "../../shared/lib/optionSets";
import { RECONCILIATION_STATUS_LABEL } from "../../shared/lib/labels";
import type { FinancePageController } from "../useFinancePageController";
import type { Reconciliation } from "../../shared/api/types/finance";

export function ReconciliationTab({ ctrl }: { ctrl: FinancePageController }) {
  const { reconciliations, pools, employees, reconciliationForm, setReconciliationOpen, reconciliationsLoading, reconciliationsReady, reconciliationsError, reloadReconciliations, fundsReady } = ctrl;
  const reconciliationUnavailable = !reconciliationsReady || Boolean(reconciliationsError);
  const { arrange: arrangeReconciliationColumns } = useListViewColumns("RECONCILIATIONS");
  const reconciliationColumns: ColumnsType<Reconciliation> = [
    { title: "资金账户", key: "pool", render: (_v, row) => (fundsReady ? pools.find((pool) => pool.id === row.pool_id)?.name : undefined) ?? row.pool_id },
    { title: "对账日期", dataIndex: "reconciled_on" },
    { title: "账户", dataIndex: "account_label" },
    { title: <Tooltip title="创建对账时，截至对账日期已入账流水的累计净额">系统余额</Tooltip>, key: "system_balance", align: "right", render: (_v, row) => <MoneyText value={row.system_balance} /> },
    { title: "账面余额", key: "statement_balance", align: "right", render: (_v, row) => <MoneyText value={row.statement_balance} /> },
    { title: "差异", key: "difference", align: "right", render: (_v, row) => <MoneyText value={row.difference} /> },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} label={configurableLabel("RECONCILIATION_STATUS", v, RECONCILIATION_STATUS_LABEL)} /> },
    { title: "操作人", dataIndex: "operator", render: (v: string | null | undefined) => v || "—" },
    {
      title: "动作操作人",
      key: "operation_operators",
      render: (_v, row) => (row.operation_operators ?? []).map((operation) => {
        const names = operation.operator_user_ids.map((id) => employees.find((employee) => employee.id === id)?.display_name ?? `#${id}`);
        return `${operation.operation_key}: ${names.join("、")}`;
      }).join("；") || "—",
    },
    {
      title: "操作",
      key: "actions",
      render: (_v, row) => (
        <Space size={2}>
          {row.status === "OPEN" ? (
            <PermissionButton permission="deposit.post" size="small" onClick={() => ctrl.setResolveTarget(row)}>核销</PermissionButton>
          ) : null}
        </Space>
      ),
    },
  ];
  return (
    <Card className="glass" title="资金对账" extra={<PermissionButton permission="deposit.post" type="primary" disabled={reconciliationUnavailable || !fundsReady} onClick={() => { reconciliationForm.setFieldsValue({ reconciled_on: today() }); setReconciliationOpen(true); }}>新增对账</PermissionButton>}>
      <ErrorBanner error={reconciliationsError} onRetry={() => void reloadReconciliations()} retrying={reconciliationsLoading} />
      <Typography.Text type="secondary">系统余额是创建对账时截至对账日期的已入账流水累计净额。之后修改流水或押金不会改变已保存的对账和首次快照。</Typography.Text>
      <DataTable<Reconciliation>
        columns={arrangeReconciliationColumns(reconciliationColumns)}
        rows={reconciliationUnavailable ? [] : reconciliations}
        controlledPaging
        page={ctrl.reconciliationsPaging.page}
        pageSize={ctrl.reconciliationsPaging.pageSize}
        total={reconciliationUnavailable ? 0 : ctrl.reconciliationsPaging.total}
        emptyText={reconciliationUnavailable ? "资金对账数据不可用，请点击重新加载" : "暂无对账记录"}
        loading={reconciliationsLoading}
        pagination={reconciliationsError ? false : undefined}
        onPageChange={ctrl.setReconciliationsPage}
      />
    </Card>
  );
}
