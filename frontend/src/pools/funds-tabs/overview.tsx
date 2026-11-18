/** 资金账户总览 Tab：从 FundsPage.tabs.tsx 拆出，函数体与拆前逐字等价。 */
import { Card } from "antd";
import type { ColumnsType } from "antd/es/table";
import { DataTable, MoneyText, PermissionButton, StatRow, StatusTag } from "../../shared/ui";
import { useListViewColumns } from "../../shared/lib/listColumns";
import { today } from "../../shared/lib/format";
import { configurableLabel } from "../../shared/lib/optionSets";
import { POOL_OWNERSHIP_LABEL } from "../../shared/lib/labels";
import type { FundsPageController } from "../useFundsPageController";
import type { Pool } from "../../shared/api/types/finance";

export function OverviewTab({ ctrl }: { ctrl: FundsPageController }) {
  const { pools, balances, totalCash, totalAvailable, totalDeposit, totalOwned, transferForm, setTransferOpen, loading, fundsReady, error } = ctrl;
  const { arrange: arrangeFundPoolColumns } = useListViewColumns("FUND_POOLS");
  const poolColumns: ColumnsType<Pool> = [
    {
      title: "资金账户",
      key: "pool_code",
      dataIndex: "name",
      render: (_v, row) => row.name,
      className: "ui-col-wrap",
      onCell: () => ({ className: "ui-col-wrap" }),
    },
    { title: "归属", dataIndex: "ownership", render: (v: string) => configurableLabel("POOL_OWNERSHIP", v, POOL_OWNERSHIP_LABEL) },
    { title: "状态", dataIndex: "status", width: 100, render: (v: string) => <StatusTag status={v} optionSet="POOL_STATUS" /> },
    { title: "收入", key: "income", align: "right", render: (_v, row) => <MoneyText value={balances[row.id]?.income} /> },
    { title: "支出", key: "expense", align: "right", render: (_v, row) => <MoneyText value={balances[row.id]?.expense} /> },
    { title: "押金", key: "deposit_held", align: "right", render: (_v, row) => <MoneyText value={balances[row.id]?.deposit_held} /> },
    { title: "可用余额", key: "available", align: "right", render: (_v, row) => <MoneyText value={balances[row.id]?.available} strong /> },
  ];
  return (
    <Card
      className="glass"
      title="资金账户卡片"
      extra={
        <PermissionButton permission="finance.transfer" type="primary" disabled={!fundsReady || loading || Boolean(error)} onClick={() => { transferForm.setFieldsValue({ occurred_on: today() }); setTransferOpen(true); }}>
          资金账户划转
        </PermissionButton>
      }
    >
      <StatRow
        items={[
          { label: "现金头寸合计", amount: totalCash },
          { label: "可用余额合计", amount: totalAvailable },
          { label: "押金占用", amount: totalDeposit },
          { label: "自有权益合计", amount: totalOwned },
        ]}
      />
      <DataTable<Pool>
        columns={arrangeFundPoolColumns(poolColumns)}
        rows={pools}
        page={1}
        pageSize={10}
        total={pools.length}
        emptyText={error ? "资金数据不可用，请点击重新加载" : "尚未配置资金账户"}
        loading={loading}
        onPageChange={() => undefined}
      />
    </Card>
  );
}
