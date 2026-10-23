/** 资金中心：总览 / 押金（页面原型 §5，FIN-01/04）。 */
import { Card, Form, Input, Modal, Select, Tabs, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cashflowsApi,
  depositsApi,
  poolsApi,
  transfersApi,
  periodLocksApi,
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
import { PoolAccountsPanel } from "./PoolAccountsPanel";
import {
  ConfirmButton,
  DataTable,
  ErrorBanner,
  InlineError,
  MoneyInput,
  MoneyText,
  PermissionButton,
  StatRow,
  StatusTag,
} from "../shared/ui";
import { useAsyncAction } from "../shared/hooks/useAsyncAction";
import { requiredMoneyRules } from "../shared/lib/validators";

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
  const [cashflowTotal, setCashflowTotal] = useState(0);
  const [reconciliations, setReconciliations] = useState<Reconciliation[]>([]);
  const [periodLocks, setPeriodLocks] = useState<import("../shared/api/catalog").PeriodLock[]>([]);
  const [depositOpen, setDepositOpen] = useState(false);
  const [cashflowOpen, setCashflowOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [reconciliationOpen, setReconciliationOpen] = useState(false);
  const [resolveTarget, setResolveTarget] = useState<Reconciliation | null>(null);
  const [rejectTarget, setRejectTarget] = useState<Cashflow | null>(null);
  const [reverseTarget, setReverseTarget] = useState<Cashflow | null>(null);
  const [returnTarget, setReturnTarget] = useState<Deposit | null>(null);
  const [lossTarget, setLossTarget] = useState<Deposit | null>(null);
  const [repairTarget, setRepairTarget] = useState<Cashflow | null>(null);
  const [periodLockOpen, setPeriodLockOpen] = useState(false);
  const [unmatchedTarget, setUnmatchedTarget] = useState<Reconciliation | null>(null);
  const [cashflowKeyword, setCashflowKeyword] = useState("");
  const [cashflowPoolId, setCashflowPoolId] = useState<number | undefined>();
  const [cashflowDirection, setCashflowDirection] = useState<string | undefined>();
  const [cashflowStatus, setCashflowStatus] = useState<string | undefined>();
  const [cashflowFrom, setCashflowFrom] = useState("");
  const [cashflowTo, setCashflowTo] = useState("");
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  // 弹窗不会同时打开，故全部写操作共用一个 pending/error 即可覆盖。
  const write = useAsyncAction();
  const [loading, setLoading] = useState(false);
  const [depositForm] = Form.useForm();
  const [returnForm] = Form.useForm();
  const [cashflowForm] = Form.useForm();
  const [transferForm] = Form.useForm();
  const [reconciliationForm] = Form.useForm();
  const [resolveForm] = Form.useForm();
  const [rejectForm] = Form.useForm();
  const [reverseForm] = Form.useForm();
  const [lossForm] = Form.useForm();
  const [repairForm] = Form.useForm();
  const [periodLockForm] = Form.useForm();

  // 用 ref 持有最新日期筛选值，使全局 load()（含写操作后刷新）也能套用当前日期区间。
  const cashflowFromRef = useRef(cashflowFrom);
  cashflowFromRef.current = cashflowFrom;
  const cashflowToRef = useRef(cashflowTo);
  cashflowToRef.current = cashflowTo;

  // 资金流水：日期区间改为服务端过滤（移除 500 硬截断），total 为服务端命中总数。
  const fetchCashflows = useCallback(async () => {
    const result = await cashflowsApi.list({
      occurred_from: cashflowFromRef.current || undefined,
      occurred_to: cashflowToRef.current || undefined,
      limit: 2000,
      offset: 0,
    });
    setCashflows(result.items);
    setCashflowTotal(result.total);
  }, []);

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
      await fetchCashflows();
      setReconciliations(await reconciliationsApi.list());
      setPeriodLocks(await periodLocksApi.list());
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, [fetchCashflows]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitDeposit = async (values: Record<string, unknown>) => {
    await write.run(async () => {
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
    });
  };

  const submitReturn = async (values: Record<string, unknown>) => {
    if (!returnTarget) return;
    const targetId = returnTarget.id;
    await write.run(async () => {
      await depositsApi.release(targetId, {
        amount: values.amount as string,
        released_on: values.released_on as string,
      });
      message.success("押金释放已登记");
      setReturnTarget(null);
      returnForm.resetFields();
      await load();
    });
  };

  const submitLoss = async (values: Record<string, unknown>) => {
    if (!lossTarget) return;
    const targetId = lossTarget.id;
    await write.run(async () => {
      await depositsApi.loss(targetId, {
        amount: values.amount as string,
        lost_on: values.lost_on as string,
        category: values.category as string,
        reason: values.reason as string,
      });
      message.success("押金损失已登记");
      setLossTarget(null);
      lossForm.resetFields();
      await load();
    });
  };

  const submitCashflow = async (values: Record<string, unknown>) => {
    await write.run(async () => {
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
    });
  };

  const reviewCashflow = async (action: "approve" | "reject", row: Cashflow, reason?: string) => {
    await write.run(async () => {
      if (action === "approve") await cashflowsApi.approve(row.id);
      else await cashflowsApi.reject(row.id, reason ?? "");
      message.success(action === "approve" ? "流水已审核" : "流水已拒绝");
      setRejectTarget(null);
      rejectForm.resetFields();
      await load();
    });
  };

  const reverseCashflow = async (values: Record<string, unknown>) => {
    if (!reverseTarget) return;
    const targetId = reverseTarget.id;
    await write.run(async () => {
      await cashflowsApi.reverse(targetId, {
        reversed_on: values.reversed_on as string,
        reason: values.reason as string,
      });
      message.success("流水已冲销");
      setReverseTarget(null);
      reverseForm.resetFields();
      await load();
    });
  };

  const submitTransfer = async (values: Record<string, unknown>) => {
    await write.run(async () => {
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
    });
  };

  const submitRepair = async (values: Record<string, unknown>) => {
    if (!repairTarget?.transfer_id) return;
    const targetId = repairTarget.transfer_id;
    await write.run(async () => {
      await transfersApi.repair(targetId, {
        counterpart_pool_id: Number(values.counterpart_pool_id),
        reason: values.reason as string,
      });
      message.success("单边划转已修复");
      setRepairTarget(null);
      repairForm.resetFields();
      await load();
    });
  };

  const submitPeriodLock = async (values: Record<string, unknown>) => {
    await write.run(async () => {
      await periodLocksApi.create({ period: values.period as string, note: values.note as string });
      message.success("账期已锁定");
      setPeriodLockOpen(false);
      periodLockForm.resetFields();
      await load();
    });
  };

  const submitReconciliation = async (values: Record<string, unknown>) => {
    await write.run(async () => {
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
    });
  };

  const resolveReconciliation = async (values: Record<string, unknown>) => {
    if (!resolveTarget) return;
    const targetId = resolveTarget.id;
    await write.run(async () => {
      await reconciliationsApi.resolve(targetId, values.reason as string);
      message.success("对账差异已核销");
      setResolveTarget(null);
      resolveForm.resetFields();
      await load();
    });
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

  const transferAnomalies = useMemo(() => {
    const grouped = new Map<string, Cashflow[]>();
    for (const row of cashflows) {
      if (!row.transfer_id) continue;
      const rows = grouped.get(row.transfer_id) ?? [];
      rows.push(row);
      grouped.set(row.transfer_id, rows);
    }
    return [...grouped.entries()]
      .filter(([, rows]) => rows.length === 1)
      .map(([transfer_id, rows]) => ({ transfer_id, flow: rows[0] }));
  }, [cashflows]);

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
      title: "已损失",
      dataIndex: "lost_amount",
      align: "right",
      render: (v: string | null | undefined) => <MoneyText value={v ?? "0.00"} />,
    },
    {
      title: "剩余",
      align: "right",
      render: (_v, row) => (
        <MoneyText value={(Number(row.paid_amount) - Number(row.returned_amount) - Number(row.lost_amount ?? 0)).toFixed(2)} />
      ),
    },
    { title: "状态", dataIndex: "status", width: 110, render: (v: string) => <StatusTag status={v} /> },
    {
      title: "操作",
      width: 190,
      render: (_v, row) => (
        <>
          <PermissionButton
            permission="deposit.post"
            size="small"
            disabled={row.status === "RETURNED" || row.status === "LOST"}
            onClick={() => {
              setReturnTarget(row);
              returnForm.setFieldsValue({ released_on: today() });
            }}
          >
            释放
          </PermissionButton>
          <PermissionButton
            permission="deposit.post"
            size="small"
            disabled={row.status === "RETURNED" || row.status === "LOST"}
            onClick={() => {
              setLossTarget(row);
              lossForm.setFieldsValue({ lost_on: today() });
            }}
          >
            登记损失
          </PermissionButton>
        </>
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
            <ConfirmButton
              permission="deposit.post"
              size="small"
              title="审核通过这笔流水"
              description="审核后流水计入损益且不可撤销。如金额有误，请先冲销或拒绝。"
              okText="确认审核"
              onConfirm={() => reviewCashflow("approve", row)}
            >
              审核
            </ConfirmButton>
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

  const transferAnomalyColumns: ColumnsType<{ transfer_id: string; flow: Cashflow }> = [
    { title: "划转号", dataIndex: "transfer_id" },
    { title: "现有流水", render: (_v, row) => row.flow.flow_no },
    { title: "资金池", render: (_v, row) => pools.find((pool) => pool.id === row.flow.pool_id)?.name ?? row.flow.pool_id },
    { title: "方向", render: (_v, row) => row.flow.direction === "IN" ? "转入" : "转出" },
    { title: "金额", align: "right", render: (_v, row) => <MoneyText value={row.flow.amount} /> },
    {
      title: "操作",
      render: (_v, row) => (
        <PermissionButton permission="finance.transfer" size="small" onClick={() => {
          repairForm.resetFields();
          setRepairTarget(row.flow);
        }}>
          修复划转
        </PermissionButton>
      ),
    },
  ];

  const periodLockColumns: ColumnsType<import("../shared/api/catalog").PeriodLock> = [
    { title: "账期", dataIndex: "period" },
    { title: "锁定时间", dataIndex: "locked_at", render: (v: string | undefined) => v ? new Date(v).toLocaleString("zh-CN") : "—" },
    { title: "锁定人", dataIndex: "locked_by" },
    { title: "说明", dataIndex: "note", render: (v: string | null | undefined) => v || "—" },
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
                  loading={loading}
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
                  <PermissionButton permission="finance.read" onClick={() => void fetchCashflows()}>查询</PermissionButton>
                </div>
                {cashflowTotal > cashflows.length ? (
                  <Typography.Text type="warning">
                    共匹配 {cashflowTotal} 笔，已加载 {cashflows.length} 笔（单次上限 2000 条，请用日期区间缩小范围）。
                  </Typography.Text>
                ) : (
                  <Typography.Text type="secondary">共 {cashflowTotal} 笔资金流水。</Typography.Text>
                )}
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
                  loading={loading}
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
                  loading={loading}
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
                  loading={loading}
                  onPageChange={() => undefined}
                />
              </Card>
            ),
          },
          {
            key: "controls",
            label: "异常与月结",
            children: (
              <div className="ui-stack">
                <Card className="glass" title="单边划转异常">
                  <DataTable
                    columns={transferAnomalyColumns}
                    rows={transferAnomalies}
                    page={1}
                    pageSize={10}
                    total={transferAnomalies.length}
                  emptyText="暂无单边划转异常"
                  loading={loading}
                  onPageChange={() => undefined}
                  />
                </Card>
                <Card className="glass" title="月结锁定" extra={<PermissionButton permission="finance.period.lock" type="primary" onClick={() => { periodLockForm.setFieldsValue({ period: new Date().toISOString().slice(0, 7) }); setPeriodLockOpen(true); }}>锁定账期</PermissionButton>}>
                  <DataTable
                    columns={periodLockColumns}
                    rows={periodLocks}
                    page={1}
                    pageSize={10}
                    total={periodLocks.length}
                    emptyText="暂无已锁定账期"
                    loading={loading}
                    onPageChange={() => undefined}
                  />
                </Card>
              </div>
            ),
          },
          {
            key: "pool-accounts",
            label: "池内账户",
            children: <PoolAccountsPanel />,
          },
          {
            key: "rebates",
            label: "返点",
            children: <RebatesPanel />,
          },
        ]}
      />

      <Modal title="新增押金占用" open={depositOpen} onCancel={() => setDepositOpen(false)} footer={null}>
        <InlineError error={write.error} />
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
          <Form.Item name="amount" label="占用金额" rules={requiredMoneyRules("占用金额")}>
            <MoneyInput />
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
          <PermissionButton permission="deposit.post" type="primary" htmlType="submit" loading={write.pending}>
            提交
          </PermissionButton>
        </Form>
      </Modal>

      <Modal title="新增独立资金流水" open={cashflowOpen} onCancel={() => setCashflowOpen(false)} footer={null}>
        <InlineError error={write.error} />
          <Form form={cashflowForm} layout="vertical" onFinish={submitCashflow} initialValues={{ occurred_on: today(), direction: "IN", fund_nature: "BUSINESS", accounting_attribute: "SELF_REVENUE" }}>
          <Form.Item name="pool_id" label="资金池" rules={[{ required: true }]}><Select options={pools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))} /></Form.Item>
          <Form.Item name="occurred_on" label="发生日期" rules={[{ required: true }]}><Input placeholder="YYYY-MM-DD" /></Form.Item>
          <Form.Item name="direction" label="收支方向" rules={[{ required: true }]}><Select options={[{ value: "IN", label: "收入" }, { value: "OUT", label: "支出" }]} /></Form.Item>
          <Form.Item name="fund_nature" label="资金性质" rules={[{ required: true }]}><Select options={Object.entries(FUND_NATURE_LABEL).map(([value, label]) => ({ value, label }))} /></Form.Item>
          <Form.Item name="accounting_attribute" label="核算属性" rules={[{ required: true }]}><Select options={Object.entries(ACCOUNTING_ATTRIBUTE_LABEL).map(([value, label]) => ({ value, label }))} /></Form.Item>
          <Form.Item name="category" label="类别" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="amount" label="金额" rules={requiredMoneyRules("金额")}><MoneyInput /></Form.Item>
          <Form.Item name="note" label="摘要" rules={[{ required: true }]}><Input.TextArea rows={2} /></Form.Item>
          <PermissionButton permission="deposit.post" type="primary" htmlType="submit" loading={write.pending}>提交审核</PermissionButton>
        </Form>
      </Modal>

      <Modal title="资金池划转" open={transferOpen} onCancel={() => setTransferOpen(false)} footer={null}>
        <InlineError error={write.error} />
          <Form form={transferForm} layout="vertical" onFinish={submitTransfer} initialValues={{ occurred_on: today() }}>
          <Form.Item name="source_pool_id" label="转出资金池" rules={[{ required: true }]}><Select options={pools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))} /></Form.Item>
          <Form.Item name="target_pool_id" label="转入资金池" rules={[{ required: true }]}><Select options={pools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))} /></Form.Item>
          <Form.Item name="amount" label="划转金额" rules={requiredMoneyRules("划转金额")}><MoneyInput /></Form.Item>
          <Form.Item name="occurred_on" label="划转日期" rules={[{ required: true }]}><Input placeholder="YYYY-MM-DD" /></Form.Item>
          <Form.Item name="note" label="说明"><Input.TextArea rows={2} /></Form.Item>
          <PermissionButton permission="finance.transfer" type="primary" htmlType="submit" loading={write.pending}>确认划转</PermissionButton>
        </Form>
      </Modal>

      <Modal title="新增资金对账" open={reconciliationOpen} onCancel={() => setReconciliationOpen(false)} footer={null}>
        <InlineError error={write.error} />
          <Form form={reconciliationForm} layout="vertical" onFinish={submitReconciliation} initialValues={{ reconciled_on: today() }}>
          <Form.Item name="pool_id" label="资金池" rules={[{ required: true }]}><Select options={pools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))} /></Form.Item>
          <Form.Item name="reconciled_on" label="对账日期" rules={[{ required: true }]}><Input placeholder="YYYY-MM-DD" /></Form.Item>
          <Form.Item name="account_label" label="对账账户" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="statement_balance" label="账面余额" rules={requiredMoneyRules("账面余额")}><MoneyInput /></Form.Item>
          <Form.Item name="unmatched_flow_ids" label="未达流水 ID" extra="多个 ID 用逗号分隔"><Input /></Form.Item>
          <Form.Item name="reason" label="差异原因"><Input.TextArea rows={2} /></Form.Item>
          <Form.Item name="note" label="说明"><Input.TextArea rows={2} /></Form.Item>
          <PermissionButton permission="deposit.post" type="primary" htmlType="submit" loading={write.pending}>提交对账</PermissionButton>
        </Form>
      </Modal>

      <Modal title="核销对账差异" open={Boolean(resolveTarget)} onCancel={() => setResolveTarget(null)} footer={null}>
        <InlineError error={write.error} />
          <Form form={resolveForm} layout="vertical" onFinish={resolveReconciliation}>
          <Form.Item name="reason" label="处理说明" rules={[{ required: true }]}><Input.TextArea rows={3} /></Form.Item>
          <PermissionButton permission="deposit.post" type="primary" htmlType="submit" loading={write.pending}>确认核销</PermissionButton>
        </Form>
      </Modal>

      <Modal title="拒绝资金流水" open={Boolean(rejectTarget)} onCancel={() => setRejectTarget(null)} footer={null}>
        <InlineError error={write.error} />
          <Form form={rejectForm} layout="vertical" onFinish={(values) => rejectTarget && void reviewCashflow("reject", rejectTarget, values.reason as string)}>
          <Form.Item name="reason" label="拒绝原因" rules={[{ required: true }]}><Input.TextArea rows={3} /></Form.Item>
          <PermissionButton permission="deposit.post" type="primary" htmlType="submit" loading={write.pending}>确认拒绝</PermissionButton>
        </Form>
      </Modal>

      <Modal title="冲销资金流水" open={Boolean(reverseTarget)} onCancel={() => setReverseTarget(null)} footer={null}>
        <InlineError error={write.error} />
          <Form form={reverseForm} layout="vertical" onFinish={reverseCashflow}>
          <Form.Item name="reversed_on" label="冲销日期" rules={[{ required: true }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
          <Form.Item name="reason" label="冲销原因" rules={[{ required: true }]}>
            <Input.TextArea rows={3} />
          </Form.Item>
          <PermissionButton permission="deposit.post" type="primary" htmlType="submit" loading={write.pending}>
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
        <InlineError error={write.error} />
        {returnTarget ? (
          <Typography.Paragraph type="secondary">
            押金占用合计 <MoneyText value={returnTarget.paid_amount} />；已释放 <MoneyText value={returnTarget.returned_amount} />；已损失 <MoneyText value={returnTarget.lost_amount ?? "0.00"} />；剩余可释放 <MoneyText value={(Number(returnTarget.paid_amount) - Number(returnTarget.returned_amount) - Number(returnTarget.lost_amount ?? 0)).toFixed(2)} strong />。
          </Typography.Paragraph>
        ) : null}
        <Typography.Paragraph type="warning">
          释放后相应减少押金占用，操作不可撤销；释放金额不得超过剩余可释放额。
        </Typography.Paragraph>
          <Form form={returnForm} layout="vertical" onFinish={submitReturn}>
          <Form.Item
            name="amount"
            label="释放金额"
            rules={[
              ...requiredMoneyRules("释放金额"),
              () => ({
                validator(_rule, value) {
                  if (!returnTarget || !value) return Promise.resolve();
                  const max = Number(returnTarget.paid_amount) - Number(returnTarget.returned_amount) - Number(returnTarget.lost_amount ?? 0);
                  if (Number(value) > max + 1e-9) {
                    return Promise.reject(new Error(`释放金额不得超过剩余可释放额 ¥${max.toFixed(2)}`));
                  }
                  return Promise.resolve();
                },
              }),
            ]}
          >
            <MoneyInput />
          </Form.Item>
          <Form.Item name="released_on" label="释放日期" rules={[{ required: true }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
          <PermissionButton permission="deposit.post" type="primary" htmlType="submit" loading={write.pending}>
            确认释放
          </PermissionButton>
        </Form>
      </Modal>

      <Modal title="登记押金损失" open={Boolean(lossTarget)} onCancel={() => setLossTarget(null)} footer={null}>
        <InlineError error={write.error} />
        <Typography.Paragraph type="warning">
          登记损失后该押金占用相应扣减，操作不可撤销，请核对金额与费用分类。
        </Typography.Paragraph>
          <Form form={lossForm} layout="vertical" onFinish={submitLoss}>
          <Form.Item name="amount" label="损失金额" rules={requiredMoneyRules("损失金额")}><MoneyInput /></Form.Item>
          <Form.Item name="lost_on" label="损失日期" rules={[{ required: true }]}><Input placeholder="YYYY-MM-DD" /></Form.Item>
          <Form.Item name="category" label="费用分类" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="reason" label="损失原因" rules={[{ required: true }]}><Input.TextArea rows={3} /></Form.Item>
          <PermissionButton permission="deposit.post" type="primary" htmlType="submit" loading={write.pending}>确认损失</PermissionButton>
        </Form>
      </Modal>

      <Modal title="修复单边划转" open={Boolean(repairTarget)} onCancel={() => setRepairTarget(null)} footer={null}>
        <Typography.Paragraph type="secondary">
          划转号：{repairTarget?.transfer_id}；现有流水：{repairTarget?.flow_no}
        </Typography.Paragraph>
        <InlineError error={write.error} />
          <Form form={repairForm} layout="vertical" onFinish={submitRepair}>
          <Form.Item name="counterpart_pool_id" label="缺失对端资金池" rules={[{ required: true }]}>
            <Select options={pools.filter((pool) => pool.id !== repairTarget?.pool_id).map((pool) => ({ value: pool.id, title: `${pool.name}（${pool.code}）`, label: `${pool.name}（${pool.code}）` }))} />
          </Form.Item>
          <Form.Item name="reason" label="修复原因" rules={[{ required: true }]}><Input.TextArea rows={3} /></Form.Item>
          <PermissionButton permission="finance.transfer" type="primary" htmlType="submit" loading={write.pending}>确认修复</PermissionButton>
        </Form>
      </Modal>

      <Modal title="锁定账期" open={periodLockOpen} onCancel={() => setPeriodLockOpen(false)} footer={null}>
        <InlineError error={write.error} />
          <Form form={periodLockForm} layout="vertical" onFinish={submitPeriodLock}>
          <Form.Item name="period" label="会计账期" rules={[{ required: true }, { pattern: /^\d{4}-\d{2}$/, message: "请输入 YYYY-MM" }]}><Input placeholder="YYYY-MM" /></Form.Item>
          <Form.Item name="note" label="说明"><Input.TextArea rows={3} /></Form.Item>
          <PermissionButton permission="deposit.post" type="primary" htmlType="submit" loading={write.pending}>确认锁定</PermissionButton>
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

