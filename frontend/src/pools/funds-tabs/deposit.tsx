/** 押金占用区块：从 FundsPage.tabs.tsx 拆出，函数体与拆前逐字等价。 */
import { Card, Space } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ConfirmButton, DataTable, MoneyText, PermissionButton, StatusTag } from "../../shared/ui";
import { useListViewColumns } from "../../shared/lib/listColumns";
import { today } from "../../shared/lib/format";
import type { FundsPageController } from "../useFundsPageController";
import type { Deposit } from "../../shared/api/types/finance";

export function DepositSection({ ctrl }: { ctrl: FundsPageController }) {
  const { deposits, employees, openDepositCreate, openDepositEdit, deleteDeposit, returnForm, setReturnTarget, lossForm, setLossTarget, cancelForm, setCancelTarget, loading } = ctrl;
  const { arrange: arrangeDepositColumns } = useListViewColumns("DEPOSITS");
  const depositColumns: ColumnsType<Deposit> = [
    { title: "押金性质", dataIndex: "ledger_type", width: 120, render: (v: string) => v === "STUDIO" ? "工作室运营押金" : "业务押金" },
    { title: "占用金额", dataIndex: "paid_amount", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "对手方", key: "counterparty", render: (_v, row) => row.counterparty_id == null ? "—" : `#${row.counterparty_id}` },
    { title: "来源订单", key: "source_order", render: (_v, row) => row.source_order_id == null ? "—" : `#${row.source_order_id}` },
    { title: "预计释放", dataIndex: "expected_release_on", render: (v: string | null | undefined) => v || "—" },
    { title: "已释放", dataIndex: "returned_amount", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "已损失", dataIndex: "lost_amount", align: "right", render: (v: string | null | undefined) => <MoneyText value={v ?? "0.00"} /> },
    { title: "剩余", key: "remaining", align: "right", render: (_v, row) => (<MoneyText value={row.remaining_amount} />) },
    { title: "状态", dataIndex: "status", width: 110, render: (v: string) => <StatusTag status={v} optionSet="DEPOSIT_STATUS" /> },
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
      width: 360,
      key: "actions",
      render: (_v, row) => (
        <Space size={2}>
          <PermissionButton
            permission="deposit.post"
            size="small"
            disabled={row.status !== "PAID"}
            onClick={() => openDepositEdit(row)}
          >
            编辑
          </PermissionButton>
          <ConfirmButton
            permission="deposit.post"
            size="small"
            danger
            disabled={row.status !== "PAID"}
            title="删除押金占用"
            description="仅未发生释放或损失的押金可以删除，删除后会同步移除对应的占用流水且不可恢复。"
            okText="确认删除"
            onConfirm={() => deleteDeposit(row.id)}
          >
            删除
          </ConfirmButton>
          <PermissionButton
            permission="deposit.post"
            size="small"
            disabled={row.status === "RETURNED" || row.status === "LOST" || row.status === "CANCELLED"}
            onClick={() => { setReturnTarget(row); returnForm.setFieldsValue({ released_on: today() }); }}
          >
            释放
          </PermissionButton>
          <PermissionButton
            permission="deposit.post"
            size="small"
            disabled={row.status === "RETURNED" || row.status === "LOST" || row.status === "CANCELLED"}
            onClick={() => { setLossTarget(row); lossForm.setFieldsValue({ lost_on: today() }); }}
          >
            登记损失
          </PermissionButton>
          <PermissionButton
            permission="deposit.post"
            size="small"
            danger
            disabled={row.status !== "PAID"}
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
        <PermissionButton permission="deposit.post" type="primary" onClick={openDepositCreate}>
          新增占用
        </PermissionButton>
      }
    >
      <DataTable<Deposit>
        columns={arrangeDepositColumns(depositColumns)}
        rows={deposits}
        page={1}
        pageSize={10}
        total={deposits.length}
        emptyText="暂无押金占用"
        loading={loading}
        onPageChange={() => undefined}
      />
    </Card>
  );
}
