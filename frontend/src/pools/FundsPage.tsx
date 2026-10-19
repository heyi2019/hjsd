/** 资金中心：总览 / 押金（页面原型 §5，FIN-01/04）。 */
import { Card, Form, Input, Modal, Select, Tabs, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  cashflowsApi,
  depositsApi,
  poolsApi,
  transfersApi,
  reconciliationsApi,
  type Reconciliation,
  type Cashflow,
  type Deposit,
  type Pool,
  type PoolBalance,
} from "../shared/api/catalog";
import { errorMessage, normalizeError } from "../shared/api/client";
import { today } from "../shared/lib/format";
import { POOL_OWNERSHIP_LABEL } from "../shared/lib/labels";
import { RebatesPanel } from "../rebates/RebatesPanel";
import {
  DataTable,
  ErrorBanner,
  MoneyText,
  PermissionButton,
  StatRow,
  StatusTag,
} from "../shared/ui";

const FUND_NATURE_LABEL: Record<string, string> = {
  BUSINESS: "本方经营",
  EXTERNAL: "外部/受托",
  INTERNAL: "内部调拨",
};
const ACCOUNTING_ATTRIBUTE_LABEL: Record<string, string> = {
  SELF_REVENUE: "自营收入",
  SELF_DIRECT_COST: "自营直接成本",
  TH_DIRECT_COST: "提号/代挂直接成本",
  TH_REVENUE: "提号/代挂收入",
  DFQ_PRINCIPAL: "代分期借款本金",
  SERVICE_REVENUE: "增值服务收入",
  REBATE_INCOME: "返点收入",
  OPERATING_EXPENSE: "运营费用",
  DEPOSIT: "押金/保证金",
  EXTERNAL_FUNDING: "外部资金",
  INTERNAL_TRANSFER: "内部调拨",
  REVERSAL: "冲销",
};

export function FundsPage() {
  const [pools, setPools] = useState<Pool[]>([]);
  const [balances, setBalances] = useState<Record<number, PoolBalance>>({});
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [cashflows, setCashflows] = useState<Cashflow[]>([]);
  const [reconciliations, setReconciliations] = useState<Reconciliation[]>([]);
  const [depositOpen, setDepositOpen] = useState(false);
  const [cashflowOpen, setCashflowOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [reconciliationOpen, setReconciliationOpen] = useState(false);
  const [resolveTarget, setResolveTarget] = useState<Reconciliation | null>(null);
  const [rejectTarget, setRejectTarget] = useState<Cashflow | null>(null);
  const [reverseTarget, setReverseTarget] = useState<Cashflow | null>(null);
  const [returnTarget, setReturnTarget] = useState<Deposit | null>(null);
  const [unmatchedTarget, setUnmatchedTarget] = useState<Reconciliation | null>(null);
  const [cashflowKeyword, setCashflowKeyword] = useState("");
  const [cashflowPoolId, setCashflowPoolId] = useState<number | undefined>();
  const [cashflowDirection, setCashflowDirection] = useState<string | undefined>();
  const [cashflowStatus, setCashflowStatus] = useState<string | undefined>();
  const [cashflowFrom, setCashflowFrom] = useState("");
  const [cashflowTo, setCashflowTo] = useState("");
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [depositForm] = Form.useForm();
  const [returnForm] = Form.useForm();
  const [cashflowForm] = Form.useForm();
  const [transferForm] = Form.useForm();
  const [reconciliationForm] = Form.useForm();
  const [resolveForm] = Form.useForm();
  const [rejectForm] = Form.useForm();
  const [reverseForm] = Form.useForm();

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
      setReconciliations(await reconciliationsApi.list());
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
        counterparty_id: values.counterparty_id ? Number(values.counterparty_id) : undefined,
        source_order_id: values.source_order_id ? Number(values.source_order_id) : undefined,
        expected_release_on: values.expected_release_on as string | undefined,
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

  const submitCashflow = async (values: Record<string, unknown>) => {
    try {
      const fundNature = String(values.fund_nature ?? "BUSINESS");
      const direction = String(values.direction ?? "IN");
      await cashflowsApi.create({
        pool_id: Number(values.pool_id),
        occurred_on: values.occurred_on as string,
        direction,
        nature: fundNature === "EXTERNAL" ? "EXTERNAL_IN" : fundNature === "INTERNAL" ? "INTERNAL" : direction === "IN" ? "BUSINESS_IN" : "BUSINESS_OUT",
        fund_nature: fundNature,
        accounting_attribute: String(values.accounting_attribute ?? "OPERATING_EXPENSE"),
        category: values.category as string,
        amount: values.amount as string,
        note: values.note as string,
      });
      message.success("独立资金流水已提交，等待审核");
      setCashflowOpen(false);
      cashflowForm.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const reviewCashflow = async (action: "approve" | "reject", row: Cashflow, reason?: string) => {
    try {
      if (action === "approve") await cashflowsApi.approve(row.id);
      else await cashflowsApi.reject(row.id, reason ?? "");
      message.success(action === "approve" ? "流水已审核" : "流水已拒绝");
      setRejectTarget(null);
      rejectForm.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const reverseCashflow = async (values: Record<string, unknown>) => {
    if (!reverseTarget) return;
    try {
      await cashflowsApi.reverse(reverseTarget.id, {
        reversed_on: values.reversed_on as string,
        reason: values.reason as string,
      });
      message.success("流水已冲销");
      setReverseTarget(null);
      reverseForm.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const submitTransfer = async (values: Record<string, unknown>) => {
    try {
      await transfersApi.create({
        source_pool_id: Number(values.source_pool_id),
        target_pool_id: Number(values.target_pool_id),
        amount: values.amount as string,
        occurred_on: values.occurred_on as string,
        note: values.note as string,
      });
      message.success("资金池划转已登记");
      setTransferOpen(false);
      transferForm.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const submitReconciliation = async (values: Record<string, unknown>) => {
    try {
      const rawIds = String(values.unmatched_flow_ids ?? "").trim();
      await reconciliationsApi.create({
        pool_id: Number(values.pool_id),
        reconciled_on: values.reconciled_on as string,
        account_label: values.account_label as string,
        statement_balance: values.statement_balance as string,
        unmatched_flow_ids: rawIds ? rawIds.split(",").map((value) => Number(value.trim())).filter(Boolean) : [],
        reason: values.reason as string,
        note: values.note as string,
      });
      message.success("对账记录已提交");
      setReconciliationOpen(false);
      reconciliationForm.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const resolveReconciliation = async (values: Record<string, unknown>) => {
    if (!resolveTarget) return;
    try {
      await reconciliationsApi.resolve(resolveTarget.id, values.reason as string);
      message.success("对账差异已核销");
      setResolveTarget(null);
      resolveForm.resetFields();
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

  const visibleCashflows = useMemo(() => {
    const keyword = cashflowKeyword.trim().toLowerCase();
    return cashflows.filter((row) => {
      const searchable = [row.order_no, row.flow_no, row.category, row.note]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return (
        (!keyword || searchable.includes(keyword))
        && (cashflowPoolId == null || row.pool_id === cashflowPoolId)
        && (!cashflowDirection || row.direction === cashflowDirection)
        && (!cashflowStatus || row.status === cashflowStatus)
        && (!cashflowFrom || row.occurred_on >= cashflowFrom)
        && (!cashflowTo || row.occurred_on <= cashflowTo)
      );
    });
  }, [cashflowDirection, cashflowFrom, cashflowKeyword, cashflowPoolId, cashflowStatus, cashflowTo, cashflows]);

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
      title: "对手方",
      render: (_v, row) => row.counterparty_id == null ? "—" : `#${row.counterparty_id}`,
    },
    {
      title: "来源订单",
      render: (_v, row) => row.source_order_id == null ? "—" : `#${row.source_order_id}`,
    },
    {
      title: "预计释放",
      dataIndex: "expected_release_on",
      render: (v: string | null | undefined) => v || "—",
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
      title: "资金性质",
      dataIndex: "fund_nature",
      render: (v: string | null | undefined, row) => FUND_NATURE_LABEL[v ?? (row.nature?.startsWith("EXTERNAL") ? "EXTERNAL" : "BUSINESS")] ?? v ?? "—",
    },
    {
      title: "核算属性",
      dataIndex: "accounting_attribute",
      render: (v: string | null | undefined) => ACCOUNTING_ATTRIBUTE_LABEL[v ?? ""] ?? v ?? "—",
    },
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
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} label={({ PENDING: "待审核", APPROVED: "已审核", REJECTED: "已拒绝" } as Record<string, string>)[v]} /> },
    { title: "备注", dataIndex: "note", render: (v: string | null) => v || "—" },
    {
      title: "操作",
      width: 170,
      render: (_v, row) => (
        <>
          {row.status === "PENDING" && (
            <PermissionButton permission="deposit.post" size="small" onClick={() => void reviewCashflow("approve", row)}>
              审核
            </PermissionButton>
          )}
          {row.status === "PENDING" && (
            <PermissionButton permission="deposit.post" size="small" onClick={() => setRejectTarget(row)}>
              拒绝
            </PermissionButton>
          )}
          {row.status === "APPROVED" && !row.order_id && !row.deposit_id && !row.transfer_id && !row.order_event_id && (
            <PermissionButton
              permission="deposit.post"
              size="small"
              onClick={() => {
                reverseForm.setFieldsValue({ reversed_on: today() });
                setReverseTarget(row);
              }}
            >
              冲销
            </PermissionButton>
          )}
        </>
      ),
    },
  ];

  const totalFlowIncome = visibleCashflows
    .filter((row) => row.direction === "IN")
    .reduce((sum, row) => sum + Number(row.amount), 0)
    .toFixed(2);
  const totalFlowExpense = visibleCashflows
    .filter((row) => row.direction === "OUT")
    .reduce((sum, row) => sum + Number(row.amount), 0)
    .toFixed(2);

  const reconciliationColumns: ColumnsType<Reconciliation> = [
    { title: "资金池", render: (_v, row) => pools.find((pool) => pool.id === row.pool_id)?.name ?? row.pool_id },
    { title: "对账日期", dataIndex: "reconciled_on" },
    { title: "账户", dataIndex: "account_label" },
    { title: "系统余额", align: "right", render: (_v, row) => <MoneyText value={row.system_balance} /> },
    { title: "账面余额", align: "right", render: (_v, row) => <MoneyText value={row.statement_balance} /> },
    { title: "差异", align: "right", render: (_v, row) => <MoneyText value={row.difference} /> },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} /> },
    {
      title: "操作",
      render: (_v, row) => (
        <>
          {row.status === "OPEN" ? (
            <PermissionButton permission="finance.read" size="small" onClick={() => setUnmatchedTarget(row)}>查看未达流水</PermissionButton>
          ) : null}
          {row.status === "OPEN" ? (
            <PermissionButton permission="deposit.post" size="small" onClick={() => setResolveTarget(row)}>核销</PermissionButton>
          ) : null}
        </>
      ),
    },
  ];

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
              <Card
                className="glass"
                title="资金池卡片"
                extra={
                  <PermissionButton permission="finance.transfer" type="primary" onClick={() => { transferForm.setFieldsValue({ occurred_on: today() }); setTransferOpen(true); }}>
                    资金池划转
                  </PermissionButton>
                }
              >
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
              <Card className="glass" title="资金明细" extra={<PermissionButton permission="deposit.post" type="primary" onClick={() => { cashflowForm.setFieldsValue({ occurred_on: today() }); setCashflowOpen(true); }}>新增流水</PermissionButton>}>
                <div className="ui-filter-bar funds-cashflow-filters">
                  <Input aria-label="流水搜索" allowClear value={cashflowKeyword} placeholder="搜索订单号 / 流水号 / 类别 / 备注" onChange={(event) => setCashflowKeyword(event.target.value)} />
                  <Select aria-label="流水资金池" allowClear value={cashflowPoolId} placeholder="全部资金池" options={pools.map((pool) => ({ value: pool.id, label: pool.name }))} onChange={setCashflowPoolId} />
                  <Select aria-label="流水方向" allowClear value={cashflowDirection} placeholder="全部收支" options={[{ value: "IN", label: "收入" }, { value: "OUT", label: "支出" }]} onChange={setCashflowDirection} />
                  <Select aria-label="流水状态" allowClear value={cashflowStatus} placeholder="全部状态" options={[{ value: "PENDING", label: "待审核" }, { value: "APPROVED", label: "已审核" }, { value: "REJECTED", label: "已拒绝" }]} onChange={setCashflowStatus} />
                  <Input aria-label="流水开始日期" value={cashflowFrom} placeholder="开始日期" onChange={(event) => setCashflowFrom(event.target.value)} />
                  <Input aria-label="流水结束日期" value={cashflowTo} placeholder="结束日期" onChange={(event) => setCashflowTo(event.target.value)} />
                </div>
                <StatRow
                  items={[
                    { label: "总收入", amount: totalFlowIncome },
                    { label: "总支出", amount: totalFlowExpense },
                    { label: "当前结果", kind: "count", amount: visibleCashflows.length },
                  ]}
                />
                <DataTable<Cashflow>
                  columns={cashflowColumns}
                  rows={visibleCashflows}
                  page={1}
                  pageSize={10}
                  total={visibleCashflows.length}
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
          {
            key: "reconciliations",
            label: "对账",
            children: (
              <Card className="glass" title="资金对账" extra={<PermissionButton permission="deposit.post" type="primary" onClick={() => { reconciliationForm.setFieldsValue({ reconciled_on: today() }); setReconciliationOpen(true); }}>新增对账</PermissionButton>}>
                <DataTable<Reconciliation>
                  columns={reconciliationColumns}
                  rows={reconciliations}
                  page={1}
                  pageSize={10}
                  total={reconciliations.length}
                  emptyText="暂无对账记录"
                  onPageChange={() => undefined}
                />
              </Card>
            ),
          },
          {
            key: "rebates",
            label: "返点",
            children: <RebatesPanel />,
          },
        ]}
      />

      <Modal title="新增押金占用" open={depositOpen} onCancel={() => setDepositOpen(false)} footer={null}>
        <Form form={depositForm} layout="vertical" onFinish={submitDeposit} initialValues={{ paid_on: today() }}>
          <Form.Item name="pool_id" label="资金池" rules={[{ required: true }]}>
            <Select options={pools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))} />
          </Form.Item>
          <Form.Item name="counterparty_id" label="对手方 ID" extra="可选，填写已建档合作方 ID">
            <Input inputMode="numeric" />
          </Form.Item>
          <Form.Item name="source_order_id" label="来源订单 ID" extra="可选，填写关联订单 ID">
            <Input inputMode="numeric" />
          </Form.Item>
          <Form.Item name="amount" label="占用金额" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="paid_on" label="占用日期" rules={[{ required: true }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
          <Form.Item name="expected_release_on" label="预计释放日期">
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

      <Modal title="新增独立资金流水" open={cashflowOpen} onCancel={() => setCashflowOpen(false)} footer={null}>
        <Form form={cashflowForm} layout="vertical" onFinish={submitCashflow} initialValues={{ occurred_on: today(), direction: "IN", fund_nature: "BUSINESS", accounting_attribute: "SELF_REVENUE" }}>
          <Form.Item name="pool_id" label="资金池" rules={[{ required: true }]}><Select options={pools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))} /></Form.Item>
          <Form.Item name="occurred_on" label="发生日期" rules={[{ required: true }]}><Input placeholder="YYYY-MM-DD" /></Form.Item>
          <Form.Item name="direction" label="收支方向" rules={[{ required: true }]}><Select options={[{ value: "IN", label: "收入" }, { value: "OUT", label: "支出" }]} /></Form.Item>
          <Form.Item name="fund_nature" label="资金性质" rules={[{ required: true }]}><Select options={Object.entries(FUND_NATURE_LABEL).map(([value, label]) => ({ value, label }))} /></Form.Item>
          <Form.Item name="accounting_attribute" label="核算属性" rules={[{ required: true }]}><Select options={Object.entries(ACCOUNTING_ATTRIBUTE_LABEL).map(([value, label]) => ({ value, label }))} /></Form.Item>
          <Form.Item name="category" label="类别" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="amount" label="金额" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="note" label="摘要" rules={[{ required: true }]}><Input.TextArea rows={2} /></Form.Item>
          <PermissionButton permission="deposit.post" type="primary" htmlType="submit">提交审核</PermissionButton>
        </Form>
      </Modal>

      <Modal title="资金池划转" open={transferOpen} onCancel={() => setTransferOpen(false)} footer={null}>
        <Form form={transferForm} layout="vertical" onFinish={submitTransfer} initialValues={{ occurred_on: today() }}>
          <Form.Item name="source_pool_id" label="转出资金池" rules={[{ required: true }]}><Select options={pools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))} /></Form.Item>
          <Form.Item name="target_pool_id" label="转入资金池" rules={[{ required: true }]}><Select options={pools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))} /></Form.Item>
          <Form.Item name="amount" label="划转金额" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="occurred_on" label="划转日期" rules={[{ required: true }]}><Input placeholder="YYYY-MM-DD" /></Form.Item>
          <Form.Item name="note" label="说明"><Input.TextArea rows={2} /></Form.Item>
          <PermissionButton permission="finance.transfer" type="primary" htmlType="submit">确认划转</PermissionButton>
        </Form>
      </Modal>

      <Modal title="新增资金对账" open={reconciliationOpen} onCancel={() => setReconciliationOpen(false)} footer={null}>
        <Form form={reconciliationForm} layout="vertical" onFinish={submitReconciliation} initialValues={{ reconciled_on: today() }}>
          <Form.Item name="pool_id" label="资金池" rules={[{ required: true }]}><Select options={pools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))} /></Form.Item>
          <Form.Item name="reconciled_on" label="对账日期" rules={[{ required: true }]}><Input placeholder="YYYY-MM-DD" /></Form.Item>
          <Form.Item name="account_label" label="对账账户" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="statement_balance" label="账面余额" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="unmatched_flow_ids" label="未达流水 ID" extra="多个 ID 用逗号分隔"><Input /></Form.Item>
          <Form.Item name="reason" label="差异原因"><Input.TextArea rows={2} /></Form.Item>
          <Form.Item name="note" label="说明"><Input.TextArea rows={2} /></Form.Item>
          <PermissionButton permission="deposit.post" type="primary" htmlType="submit">提交对账</PermissionButton>
        </Form>
      </Modal>

      <Modal title="核销对账差异" open={Boolean(resolveTarget)} onCancel={() => setResolveTarget(null)} footer={null}>
        <Form form={resolveForm} layout="vertical" onFinish={resolveReconciliation}>
          <Form.Item name="reason" label="处理说明" rules={[{ required: true }]}><Input.TextArea rows={3} /></Form.Item>
          <PermissionButton permission="deposit.post" type="primary" htmlType="submit">确认核销</PermissionButton>
        </Form>
      </Modal>

      <Modal title="拒绝资金流水" open={Boolean(rejectTarget)} onCancel={() => setRejectTarget(null)} footer={null}>
        <Form form={rejectForm} layout="vertical" onFinish={(values) => rejectTarget && void reviewCashflow("reject", rejectTarget, values.reason as string)}>
          <Form.Item name="reason" label="拒绝原因" rules={[{ required: true }]}><Input.TextArea rows={3} /></Form.Item>
          <PermissionButton permission="deposit.post" type="primary" htmlType="submit">确认拒绝</PermissionButton>
        </Form>
      </Modal>

      <Modal title="冲销资金流水" open={Boolean(reverseTarget)} onCancel={() => setReverseTarget(null)} footer={null}>
        <Form form={reverseForm} layout="vertical" onFinish={reverseCashflow}>
          <Form.Item name="reversed_on" label="冲销日期" rules={[{ required: true }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
          <Form.Item name="reason" label="冲销原因" rules={[{ required: true }]}>
            <Input.TextArea rows={3} />
          </Form.Item>
          <PermissionButton permission="deposit.post" type="primary" htmlType="submit">
            确认冲销
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

      <Modal title="未达流水" open={Boolean(unmatchedTarget)} onCancel={() => setUnmatchedTarget(null)} footer={null} width={900}>
        <Typography.Paragraph type="secondary">
          对账记录标记的流水 ID：{unmatchedTarget?.unmatched_flow_ids?.join(", ") || "—"}
        </Typography.Paragraph>
        <DataTable<Cashflow>
          columns={cashflowColumns.filter((column) => column.title !== "操作")}
          rows={unmatchedTarget ? cashflows.filter((row) => unmatchedTarget.unmatched_flow_ids?.includes(row.id)) : []}
          page={1}
          pageSize={10}
          total={unmatchedTarget ? cashflows.filter((row) => unmatchedTarget.unmatched_flow_ids?.includes(row.id)).length : 0}
          emptyText="当前列表未加载到对应流水"
          onPageChange={() => undefined}
        />
      </Modal>
    </section>
  );
}

