/** 资金中心：总览 / 划转 / 押金（页面原型 §5，FIN-01/03/04）。 */
import { Card, Form, Input, Modal, Select, Tabs, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import {
  depositsApi,
  poolsApi,
  ordersApi,
  type Deposit,
  type Pool,
  type PoolBalance,
} from "../shared/api/catalog";
import { errorMessage, normalizeError } from "../shared/api/client";
import { today } from "../shared/lib/format";
import {
  DataTable,
  ErrorBanner,
  MoneyText,
  PageHeader,
  PermissionButton,
  StatRow,
  StatusTag,
} from "../shared/ui";

export function FundsPage() {
  const [pools, setPools] = useState<Pool[]>([]);
  const [balances, setBalances] = useState<Record<number, PoolBalance>>({});
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [transferOpen, setTransferOpen] = useState(false);
  const [depositOpen, setDepositOpen] = useState(false);
  const [returnTarget, setReturnTarget] = useState<Deposit | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [transferForm] = Form.useForm();
  const [depositForm] = Form.useForm();
  const [returnForm] = Form.useForm();

  const load = useCallback(async () => {
    try {
      const list = await poolsApi.list();
      setPools(list);
      const entries = await Promise.all(
        list.map(async (pool) => [pool.id, await poolsApi.balance(pool.id)] as const),
      );
      setBalances(Object.fromEntries(entries));
      setDeposits(await depositsApi.list());
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submitTransfer = async (values: Record<string, unknown>) => {
    try {
      const result = await ordersApi.transfer({
        source_pool_id: Number(values.source_pool_id),
        target_pool_id: Number(values.target_pool_id),
        amount: values.amount as string,
        occurred_on: values.occurred_on as string,
      });
      message.success(`划转已过账：${result.out_flow_no} / ${result.in_flow_no}`);
      setTransferOpen(false);
      transferForm.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

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
    { title: "资金池", render: (_v, row) => `${row.code} · ${row.name}` },
    { title: "归属", dataIndex: "ownership" },
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
      title: "TH 代垫",
      align: "right",
      render: (_v, row) => <MoneyText value={balances[row.id]?.th_advance} />,
    },
    {
      title: "可用余额",
      align: "right",
      render: (_v, row) => <MoneyText value={balances[row.id]?.available} strong />,
    },
  ];

  const depositColumns: ColumnsType<Deposit> = [
    { title: "押金编号", dataIndex: "deposit_no" },
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

  return (
    <section className="ui-stack">
      <PageHeader
        title="资金中心"
        description="总览、池间划转与押金占用；现金头寸与可用余额分列，押金不影响经营损益。"
      />

      <ErrorBanner error={error} />

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
                  pageSize={Math.max(pools.length, 10)}
                  total={pools.length}
                  emptyText="尚未配置资金池"
                  onPageChange={() => undefined}
                />
              </Card>
            ),
          },
          {
            key: "transfer",
            label: "划转",
            children: (
              <Card
                className="glass"
                title="池间划转"
                extra={
                  <PermissionButton
                    permission="finance.transfer"
                    type="primary"
                    onClick={() => setTransferOpen(true)}
                  >
                    发起划转
                  </PermissionButton>
                }
              >
                <Typography.Paragraph type="secondary">
                  一次划转原子生成两条 INTERNAL 流水，同 transfer_id、金额相等、日期一致（A07）。
                </Typography.Paragraph>
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
                  pageSize={Math.max(deposits.length, 10)}
                  total={deposits.length}
                  emptyText="暂无押金占用"
                  onPageChange={() => undefined}
                />
              </Card>
            ),
          },
        ]}
      />

      <Modal title="发起池间划转" open={transferOpen} onCancel={() => setTransferOpen(false)} footer={null}>
        <Form form={transferForm} layout="vertical" onFinish={submitTransfer} initialValues={{ occurred_on: today() }}>
          <Form.Item name="source_pool_id" label="转出池" rules={[{ required: true }]}>
            <Select options={pools.map((pool) => ({ value: pool.id, label: `${pool.code} ${pool.name}` }))} />
          </Form.Item>
          <Form.Item name="target_pool_id" label="转入池" rules={[{ required: true }]}>
            <Select options={pools.map((pool) => ({ value: pool.id, label: `${pool.code} ${pool.name}` }))} />
          </Form.Item>
          <Form.Item name="amount" label="金额" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="occurred_on" label="日期" rules={[{ required: true }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
          <PermissionButton permission="finance.transfer" type="primary" htmlType="submit">
            提交
          </PermissionButton>
        </Form>
      </Modal>

      <Modal title="新增押金占用" open={depositOpen} onCancel={() => setDepositOpen(false)} footer={null}>
        <Form form={depositForm} layout="vertical" onFinish={submitDeposit} initialValues={{ paid_on: today() }}>
          <Form.Item name="pool_id" label="资金池" rules={[{ required: true }]}>
            <Select options={pools.map((pool) => ({ value: pool.id, label: `${pool.code} ${pool.name}` }))} />
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
        title={returnTarget ? `押金释放 · ${returnTarget.deposit_no}` : "押金释放"}
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

