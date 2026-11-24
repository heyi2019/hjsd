/** 押金占用区块：从 FinancePage.tabs.tsx 拆出，函数体与拆前逐字等价。 */
import { Card, Space } from "antd";
import type { ColumnsType } from "antd/es/table";
import { DataTable, ErrorBanner, MoneyText, PermissionButton, StatusTag } from "../../shared/ui";
import { useListViewColumns } from "../../shared/lib/listColumns";
import { today } from "../../shared/lib/format";
import type { FinancePageController } from "../useFinancePageController";
import type { Deposit } from "../../shared/api/types/finance";

const ACTION_LABEL = { HOLD: "占用", RETURN: "释放", LOSS: "损失", CANCEL: "取消" } as const;

export function DepositSection({ ctrl }: { ctrl: FinancePageController }) {
  const { deposits, employees, openDepositCreate, openDepositEdit, returnForm, setReturnTarget, lossForm, setLossTarget, cancelForm, setCancelTarget, depositsReady, depositsLoading, depositsError, reloadDeposits, fundsReady } = ctrl;
  const depositsUnavailable = !depositsReady || Boolean(depositsError);
  const { arrange: arrangeDepositColumns } = useListViewColumns("DEPOSITS");
  const depositColumns: ColumnsType<Deposit> = [
    { title: "押金性质", dataIndex: "ledger_type", width: 120, render: (v: string) => v === "STUDIO" ? "工作室运营押金" : "业务押金" },
    { title: "占用金额", dataIndex: "paid_amount", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "对手方", key: "counterparty", render: (_v, row) => row.counterparty_id == null ? "—" : `#${row.counterparty_id}` },
    { title: "来源订单", key: "source_order", render: (_v, row) => row.source_order_id == null ? "—" : `#${row.source_order_id}` },
    { title: "预计释放", dataIndex: "expected_release_on", render: (v: string | null | undefined) => v || "—" },
    { title: "已释放", dataIndex: "returned_amount", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "已损失", dataIndex: "lost_amount", align: "right", render: (v: string | null | undefined) => <MoneyText value={v} /> },
    { title: "剩余", key: "remaining", align: "right", render: (_v, row) => (<MoneyText value={row.remaining_amount} />) },
    { title: "状态", dataIndex: "status", width: 110, render: (v: string) => <StatusTag status={v} optionSet="DEPOSIT_STATUS" /> },
    { title: "操作人", dataIndex: "operator", render: (v: string | null | undefined) => v || "—" },
    {
      title: "动作操作人",
      key: "operation_operators",
      render: (_v, row) => {
        const names = (ids: number[]) => ids.map((id) => employees.find((employee) => employee.id === id)?.display_name ?? `#${id}`).join("、");
        const history = row.action_history ?? [];
        const actions = history.map((action) => `${ACTION_LABEL[action.action]} ${action.flow_no} (${action.occurred_on})：${names(action.operator_user_ids) || `登记人 ${action.operator}（历史操作人未留存）`}`);
        const otherOperations = (row.operation_operators ?? [])
          .filter((operation) => !history.length || !["CREATE", "RELEASE", "LOSS", "CANCEL"].includes(operation.operation_key))
          .map((operation) => `${operation.operation_key === "UPDATE" ? "最后编辑" : operation.operation_key}：${names(operation.operator_user_ids)}`);
        return [...actions, ...otherOperations].join("；") || "—";
      },
    },
    {
      title: "操作",
      width: 360,
      key: "actions",
      render: (_v, row) => (
        <Space size={2}>
          <PermissionButton
            permission="deposit.post"
            size="small"
            disabled={!row.available_actions?.includes("EDIT") || !fundsReady}
            onClick={() => openDepositEdit(row)}
          >
            编辑
          </PermissionButton>
          <PermissionButton
            permission="deposit.post"
            size="small"
            disabled={!row.available_actions?.includes("RETURN")}
            onClick={() => { setReturnTarget(row); returnForm.setFieldsValue({ released_on: today() }); }}
          >
            释放
          </PermissionButton>
          <PermissionButton
            permission="deposit.post"
            size="small"
            disabled={!row.available_actions?.includes("LOSS")}
            onClick={() => { setLossTarget(row); lossForm.setFieldsValue({ lost_on: today() }); }}
          >
            登记损失
          </PermissionButton>
          <PermissionButton
            permission="deposit.post"
            size="small"
            danger
            disabled={!row.available_actions?.includes("CANCEL")}
            onClick={() => { setCancelTarget(row); cancelForm.setFieldsValue({ cancelled_on: today() }); }}
          >
            取消
          </PermissionButton>
        </Space>
      ),
    },
  ];
  return (
    <Card
      className="glass"
      title="押金占用"
      extra={
        <PermissionButton permission="deposit.post" type="primary" disabled={depositsUnavailable || !fundsReady} onClick={openDepositCreate}>
          新增占用
        </PermissionButton>
      }
    >
      <ErrorBanner error={depositsError} onRetry={() => void reloadDeposits()} retrying={depositsLoading} />
      <DataTable<Deposit>
        columns={arrangeDepositColumns(depositColumns)}
        rows={depositsUnavailable ? [] : deposits}
        controlledPaging
        page={ctrl.depositsPaging.page}
        pageSize={ctrl.depositsPaging.pageSize}
        total={depositsUnavailable ? 0 : ctrl.depositsPaging.total}
        emptyText={depositsError ? "押金数据不可用，请点击重新加载" : "暂无押金占用"}
        loading={depositsLoading}
        onPageChange={ctrl.setDepositsPage}
      />
    </Card>
  );
}
