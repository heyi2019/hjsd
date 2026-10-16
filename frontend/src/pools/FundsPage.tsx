/** 资金中心：总览 / 押金（页面原型 §5，FIN-01/04）。 */
import { Card, Form, Input, Modal, Select, Tabs, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import {
  cashflowsApi,
  depositsApi,
  poolsApi,
  type Cashflow,
  type Deposit,
  type Pool,
  type PoolBalance,
} from "../shared/api/catalog";
import { errorMessage, normalizeError } from "../shared/api/client";
import { today } from "../shared/lib/format";
import { POOL_OWNERSHIP_LABEL } from "../shared/lib/labels";
import {
  DataTable,
  ErrorBanner,
  MoneyText,
  PermissionButton,
  StatRow,
  StatusTag,
} from "../shared/ui";

export function FundsPage() {
  const [pools, setPools] = useState<Pool[]>([]);
  const [balances, setBalances] = useState<Record<number, PoolBalance>>({});
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [cashflows, setCashflows] = useState<Cashflow[]>([]);
  const [depositOpen, setDepositOpen] = useState(false);
  const [returnTarget, setReturnTarget] = useState<Deposit | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [depositForm] = Form.useForm();
  const [returnForm] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await poolsApi.list();
      setPools(list);
      const entries = await Promise.all(
        list.map(async (pool) => [pool.id, await poolsApi.balance(pool.id)] as const),
      );
      setBalances(Object.fromEntries(entries));
      setDeposits(await depositsApi.list());
      setCashflows(await cashflowsApi.list({ limit: 500 }));
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submitDeposit = async (values: Record<string, unknown>) => {
    try {
      await depositsApi.create({
        pool_id: Number(values.pool_id),
        amount: values.amount as string,
        paid_on: values.paid_on as string,
        note: values.note as string,
      });
      message.success("押金占用已登记，不影响经营损益");
      setDepositOpen(false);
      depositForm.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const submitReturn = async (values: Record<string, unknown>) => {
    if (!returnTarget) return;
    try {
      await depositsApi.release(returnTarget.id, {
        amount: values.amount as string,
        released_on: values.released_on as string,
      });
      message.success("押金释放已登记");
      setReturnTarget(null);
      returnForm.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  // 只读合计：仅用于统计卡展示，不回流到任何写路径。
  const totalCash = Object.values(balances)
    .reduce((sum, balance) => sum + Number(balance.cash_balance), 0)
    .toFixed(2);
  const totalAvailable = Object.values(balances)
    .reduce((sum, balance) => sum + Number(balance.available), 0)
    .toFixed(2);
  const totalDeposit = Object.values(balances)
    .reduce((sum, balance) => sum + Number(balance.deposit_held), 0)
    .toFixed(2);

  const poolColumns: ColumnsType<Pool> = [
    { title: "资金池", dataIndex: "name", render: (_v, row) => `${row.name}（${row.code}）` },
    { title: "归属", dataIndex: "ownership", render: (v: string) => POOL_OWNERSHIP_LABEL[v] ?? v },
    { title: "状态", dataIndex: "status", width: 100, render: (v: string) => <StatusTag status={v} /> },
    {
      title: "收入",
      align: "right",
      render: (_v, row) => <MoneyText value={balances[row.id]?.income} />,
    },
    {
      title: "支出",
      align: "right",
      render: (_v, row) => <MoneyText value={balances[row.id]?.expense} />,
    },
    {
      title: "押金",
      align: "right",
      render: (_v, row) => <MoneyText value={balances[row.id]?.deposit_held} />,
    },
    {
      title: "可用余额",
      align: "right",
      render: (_v, row) => <MoneyText value={balances[row.id]?.available} strong />,
    },
  ];

  const depositColumns: ColumnsType<Deposit> = [
    {
      title: "占用金额",
      dataIndex: "paid_amount",
      align: "right",
      render: (v: string) => <MoneyText value={v} />,
    },
    {
      title: "已释放",
      dataIndex: "returned_amount",
      align: "right",
      render: (v: string) => <MoneyText value={v} />,
    },
    {
      title: "剩余",
      align: "right",
      render: (_v, row) => (
        <MoneyText value={(Number(row.paid_amount) - Number(row.returned_amount)).toFixed(2)} />
      ),
    },
    { title: "状态", dataIndex: "status", width: 110, render: (v: string) => <StatusTag status={v} /> },
    {
      title: "操作",
      width: 100,
      render: (_v, row) => (
        <PermissionButton
          permission="deposit.post"
          size="small"
          disabled={row.status === "RETURNED"}
          onClick={() => {
            setReturnTarget(row);
            returnForm.setFieldsValue({ released_on: today() });
          }}
        >
          释放
        </PermissionButton>
      ),
    },
  ];

  const cashflowColumns: ColumnsType<Cashflow> = [
    { title: "订单号", dataIndex: "order_no", render: (v: string | null) => v || "—" },
    { title: "流水号", dataIndex: "flow_no" },
    { title: "日期", dataIndex: "occurred_on" },
    { title: "类别", dataIndex: "category" },
    {
      title: "收支",
      dataIndex: "direction",
      render: (v: string) => (v === "IN" ? "收入" : "支出"),
    },
    {
      title: "金额",
      dataIndex: "amount",
      align: "right",
      render: (v: string) => <MoneyText value={v} />,
    },
    { title: "来源", dataIndex: "source" },
    { title: "备注", dataIndex: "note", render: (v: string | null) => v || "—" },
  ];

  const totalFlowIncome = cashflows
    .filter((row) => row.direction === "IN")
    .reduce((sum, row) => sum + Number(row.amount), 0)
    .toFixed(2);
  const totalFlowExpense = cashflows
    .filter((row) => row.direction === "OUT")
    .reduce((sum, row) => sum + Number(row.amount), 0)
    .toFixed(2);

  return (
    <section className="ui-stack">
      <ErrorBanner error={error} onRetry={() => void load()} retrying={loading} />

      <Tabs
        defaultActiveKey="overview"
        items={[
          {
            key: "overview",
            label: "总览",
            children: (
              <Card className="glass" title="资金池卡片">
                <StatRow
                  items={[
                    { label: "现金头寸合计", amount: totalCash },
                    { label: "可用余额合计", amount: totalAvailable },
                    { label: "押金占用", amount: totalDeposit },
                  ]}
                />
                <DataTable<Pool>
                  columns={poolColumns}
                  rows={pools}
                  page={1}
                  pageSize={10}
                  total={pools.length}
                  emptyText="尚未配置资金池"
                  onPageChange={() => undefined}
                />
              </Card>
            ),
          },
          {
            key: "cashflows",
            label: "流水",
            children: (
              <Card className="glass" title="资金明细">
                <StatRow
                  items={[
                    { label: "总收入", amount: totalFlowIncome },
                    { label: "总支出", amount: totalFlowExpense },
                  ]}
                />
                <DataTable<Cashflow>
                  columns={cashflowColumns}
                  rows={cashflows}
                  page={1}
                  pageSize={10}
                  total={cashflows.length}
                  emptyText="暂无资金流水"
                  onPageChange={() => undefined}
                />
              </Card>
            ),
          },
          {
            key: "deposits",
            label: "押金",
            children: (
              <Card
                className="glass"
                title="押金占用"
                extra={
                  <PermissionButton
                    permission="deposit.post"
                    type="primary"
                    onClick={() => setDepositOpen(true)}
                  >
                    新增占用
                  </PermissionButton>
                }
              >
                <DataTable<Deposit>
                  columns={depositColumns}
                  rows={deposits}
                  page={1}
                  pageSize={10}
                  total={deposits.length}
                  emptyText="暂无押金占用"
                  onPageChange={() => undefined}
                />
              </Card>
            ),
          },
        ]}
      />

      <Modal title="新增押金占用" open={depositOpen} onCancel={() => setDepositOpen(false)} footer={null}>
        <Form form={depositForm} layout="vertical" onFinish={submitDeposit} initialValues={{ paid_on: today() }}>
          <Form.Item name="pool_id" label="资金池" rules={[{ required: true }]}>
            <Select options={pools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))} />
          </Form.Item>
          <Form.Item name="amount" label="占用金额" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="paid_on" label="占用日期" rules={[{ required: true }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
          <Form.Item name="note" label="说明">
            <Input.TextArea rows={2} />
          </Form.Item>
          <PermissionButton permission="deposit.post" type="primary" htmlType="submit">
            提交
          </PermissionButton>
        </Form>
      </Modal>

      <Modal
        title="押金释放"
        open={Boolean(returnTarget)}
        onCancel={() => setReturnTarget(null)}
        footer={null}
      >
        <Form form={returnForm} layout="vertical" onFinish={submitReturn}>
          <Form.Item name="amount" label="释放金额" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="released_on" label="释放日期" rules={[{ required: true }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
          <PermissionButton permission="deposit.post" type="primary" htmlType="submit">
            确认释放
          </PermissionButton>
        </Form>
      </Modal>
    </section>
  );
}

