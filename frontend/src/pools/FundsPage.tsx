/** 资金中心：总览 / 押金（页面原型 §5，FIN-01/04）。 */
import { Card, Form, Input, Modal as AntdModal, Space, Tabs, Tooltip, Typography } from "antd";
import { appMessage } from "../shared/ui/appFeedback";
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
import { NATURE_LABEL, POOL_OWNERSHIP_LABEL } from "../shared/lib/labels";
import { RebatesPanel } from "../rebates/RebatesPanel";
import { StudioExpensePanel } from "./StudioExpensePanel";
import {
  ConfirmButton,
  BusinessActionModal,
  BusinessForm,
  DataTable,
  ErrorBanner,
  InlineError,
  MoneyInput,
  MoneyText,
  PermissionButton,
  Select,
  StatRow,
  StatusTag,
  useCompactLayout,
} from "../shared/ui";
import { useAsyncAction } from "../shared/hooks/useAsyncAction";
import { useReloadOnActive } from "../shared/state/reloadOnActive";
import { configurableLabel, useOptionSet } from "../shared/lib/optionSets";
import { requiredMoneyRules } from "../shared/lib/validators";
import { ACCOUNTING_ATTRIBUTE_LABEL, FUND_NATURE_LABEL, RECONCILIATION_STATUS_LABEL } from "../shared/lib/labels";
import { CfgItem, FieldConfigScope } from "../orders/ConfigurableField";
import { useListViewColumns } from "../shared/lib/listColumns";

// 资金操作弹窗统一复用建单弹窗外壳（拖拽、缩放、滚动和窄屏适配）。
const Modal = BusinessActionModal;

// 与 backend/app/finance/attributes.py 的 _ALLOWED_ATTRIBUTES_BY_FUND_NATURE 保持一致：
// 资金性质决定可用核算属性，非法组合后端直接 422，此处事前收窄避免误选。
const ALLOWED_ATTRIBUTES_BY_FUND_NATURE: Record<string, string[]> = {
  BUSINESS: [
    "SELF_REVENUE",
    "SELF_DIRECT_COST",
    "TH_DIRECT_COST",
    "TH_REVENUE",
    "DFQ_PRINCIPAL",
    "SERVICE_REVENUE",
    "REBATE_INCOME",
    "OPERATING_EXPENSE",
    "REVERSAL",
    "REFUND",
  ],
  EXTERNAL: ["DEPOSIT", "EXTERNAL_FUNDING", "REVERSAL"],
  INTERNAL: ["INTERNAL_TRANSFER"],
};

/** 新增流水的 nature 口径（纯函数，供单测矩阵直接覆盖）：
 *  外部/受托 → EXTERNAL_IN；内部调拨 → INTERNAL；本方经营按流向二分。 */
export const deriveCashflowNature = (fundNature: string, direction: string): string =>
  fundNature === "EXTERNAL" ? "EXTERNAL_IN" : fundNature === "INTERNAL" ? "INTERNAL" : direction === "IN" ? "BUSINESS_IN" : "BUSINESS_OUT";

/** 移动端（≤640px）资金池总览卡片列表。桌面由 useCompactLayout 控制不挂载，故不影响桌面表格与单测。 */
function MobilePoolList({ rows, balances }: { rows: Pool[]; balances: Record<number, PoolBalance> }) {
  if (rows.length === 0) return <div className="data-mobile-empty">尚未配置资金池</div>;
  return (
    <div className="data-mobile-list">
      {rows.map((row) => (
        <article className="data-mobile-card" key={row.id}>
          <div className="data-mobile-card__topline">
            <span>{`${row.name}（${row.code}）`}</span>
            <StatusTag status={row.status} optionSet="POOL_STATUS" />
          </div>
          <dl className="data-mobile-card__meta">
            <div><dt>归属</dt><dd>{POOL_OWNERSHIP_LABEL[row.ownership] ?? row.ownership}</dd></div>
            <div><dt>收入</dt><dd><MoneyText value={balances[row.id]?.income} /></dd></div>
            <div><dt>支出</dt><dd><MoneyText value={balances[row.id]?.expense} /></dd></div>
            <div><dt>押金</dt><dd><MoneyText value={balances[row.id]?.deposit_held} /></dd></div>
            <div><dt>可用余额</dt><dd><MoneyText value={balances[row.id]?.available} strong /></dd></div>
          </dl>
        </article>
      ))}
    </div>
  );
}

/** 移动端（≤640px）资金流水卡片列表。 */
function MobileCashflowList({
  rows,
  onApprove,
  onReject,
  onReverse,
}: {
  rows: Cashflow[];
  onApprove: (row: Cashflow) => void;
  onReject: (row: Cashflow) => void;
  onReverse: (row: Cashflow) => void;
}) {
  if (rows.length === 0) return <div className="data-mobile-empty">暂无资金流水</div>;
  return (
    <div className="data-mobile-list">
      {rows.map((row) => (
        <article className="data-mobile-card" key={row.id}>
          <div className="data-mobile-card__topline">
            <span>{row.flow_no}</span>
            <StatusTag
              status={row.status}
              label={configurableLabel("FUND_FLOW_STATUS", row.status, { PENDING: "待审核", APPROVED: "已审核", REJECTED: "已拒绝" })}
            />
          </div>
          <dl className="data-mobile-card__meta">
            <div><dt>订单号</dt><dd>{row.order_no || "—"}</dd></div>
            <div><dt>日期</dt><dd>{row.occurred_on}</dd></div>
            <div><dt>类别</dt><dd>{row.category}</dd></div>
            <div><dt>资金性质</dt><dd>{FUND_NATURE_LABEL[row.fund_nature ?? (row.nature?.startsWith("EXTERNAL") ? "EXTERNAL" : "BUSINESS")] ?? row.fund_nature ?? "—"}</dd></div>
            <div><dt>核算属性</dt><dd>{ACCOUNTING_ATTRIBUTE_LABEL[row.accounting_attribute ?? ""] ?? row.accounting_attribute ?? "—"}</dd></div>
            <div><dt>收支</dt><dd>{row.direction === "IN" ? "收入" : "支出"}</dd></div>
            <div><dt>金额</dt><dd><MoneyText value={row.amount} strong /></dd></div>
            <div><dt>来源</dt><dd>{row.source || "—"}</dd></div>
            {row.note ? <div><dt>备注</dt><dd>{row.note}</dd></div> : null}
          </dl>
          <Space size={2}>
            {row.status === "PENDING" && (
              <PermissionButton permission="deposit.post" size="small" onClick={() => onApprove(row)}>审核</PermissionButton>
            )}
            {row.status === "PENDING" && (
              <PermissionButton permission="deposit.post" size="small" onClick={() => onReject(row)}>拒绝</PermissionButton>
            )}
            {row.status === "APPROVED" && !row.order_id && !row.deposit_id && !row.transfer_id && !row.order_event_id && (
              <PermissionButton permission="deposit.post" size="small" onClick={() => onReverse(row)}>冲销</PermissionButton>
            )}
          </Space>
        </article>
      ))}
    </div>
  );
}

/** 移动端（≤640px）押金占用卡片列表。 */
function MobileDepositList({
  rows,
  pools,
  onRelease,
  onLoss,
  onCancel,
}: {
  rows: Deposit[];
  pools: Pool[];
  onRelease: (row: Deposit) => void;
  onLoss: (row: Deposit) => void;
  onCancel: (row: Deposit) => void;
}) {
  if (rows.length === 0) return <div className="data-mobile-empty">暂无押金占用</div>;
  return (
    <div className="data-mobile-list">
      {rows.map((row) => (
        <article className="data-mobile-card" key={row.id}>
          <div className="data-mobile-card__topline">
            <span>{pools.find((pool) => pool.id === row.pool_id)?.name ?? row.pool_id}</span>
            <StatusTag status={row.status} optionSet="DEPOSIT_STATUS" />
          </div>
          <dl className="data-mobile-card__meta">
            <div><dt>占用金额</dt><dd><MoneyText value={row.paid_amount} /></dd></div>
            <div><dt>对手方</dt><dd>{row.counterparty_id == null ? "—" : `#${row.counterparty_id}`}</dd></div>
            <div><dt>来源订单</dt><dd>{row.source_order_id == null ? "—" : `#${row.source_order_id}`}</dd></div>
            <div><dt>预计释放</dt><dd>{row.expected_release_on || "—"}</dd></div>
            <div><dt>已释放</dt><dd><MoneyText value={row.returned_amount} /></dd></div>
            <div><dt>已损失</dt><dd><MoneyText value={row.lost_amount ?? "0.00"} /></dd></div>
            <div>
              <dt>剩余</dt>
              <dd>
                <MoneyText
                  value={(Number(row.paid_amount) - Number(row.returned_amount) - Number(row.lost_amount ?? 0)).toFixed(2)}
                />
              </dd>
            </div>
          </dl>
          <Space size={2}>
            <PermissionButton
              permission="deposit.post"
              size="small"
              disabled={row.status === "RETURNED" || row.status === "LOST" || row.status === "CANCELLED"}
              onClick={() => onRelease(row)}
            >
              释放
            </PermissionButton>
            <PermissionButton
              permission="deposit.post"
              size="small"
              disabled={row.status === "RETURNED" || row.status === "LOST" || row.status === "CANCELLED"}
              onClick={() => onLoss(row)}
            >
              登记损失
            </PermissionButton>
            <PermissionButton
              permission="deposit.post"
              size="small"
              danger
              disabled={row.status !== "PAID"}
              onClick={() => onCancel(row)}
            >
              取消
            </PermissionButton>
          </Space>
        </article>
      ))}
    </div>
  );
}

export function FundsPage({ active = true }: { active?: boolean } = {}) {
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
  const [cancelTarget, setCancelTarget] = useState<Deposit | null>(null);
  const [repairTarget, setRepairTarget] = useState<Cashflow | null>(null);
  const [periodLockOpen, setPeriodLockOpen] = useState(false);
  const [unmatchedTarget, setUnmatchedTarget] = useState<Reconciliation | null>(null);
  const [cashflowKeyword, setCashflowKeyword] = useState("");
  const [cashflowPoolId, setCashflowPoolId] = useState<number | undefined>();
  const [cashflowDirection, setCashflowDirection] = useState<string | undefined>();
  const [cashflowStatus, setCashflowStatus] = useState<string | undefined>();
  const [cashflowFrom, setCashflowFrom] = useState("");
  const [cashflowTo, setCashflowTo] = useState("");
  const [cashflowFundNature, setCashflowFundNature] = useState("");
  const [cashflowAttribute, setCashflowAttribute] = useState("");
  const [cashflowCategory, setCashflowCategory] = useState("");
  const compact = useCompactLayout();
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  // T20：资金流水筛选项从「选项词典」配置读取（方向 / 状态 / 资金性质 / 核算属性）。
  const flowDirectionOptions = useOptionSet("FUND_FLOW_DIRECTION");
  const flowStatusOptions = useOptionSet("FUND_FLOW_STATUS");
  const flowFundNatureOptions = useOptionSet("FUND_FLOW_FUND_NATURE");
  const flowAttributeOptions = useOptionSet("FUND_FLOW_ACCOUNTING_ATTRIBUTE");
  // 资金流向（nature）从 CASHFLOW_NATURE 词典读取，设置页改文案可同步；词典未加载时回落 NATURE_LABEL。
  const natureOptionSet = useOptionSet("CASHFLOW_NATURE");
  // 弹窗不会同时打开，故全部写操作共用一个 pending/error 即可覆盖。
  const write = useAsyncAction();
  const [loading, setLoading] = useState(false);
  const [depositForm] = Form.useForm();
  const [returnForm] = Form.useForm();
  const [cashflowForm] = Form.useForm();
  const cashflowFormNature = Form.useWatch("fund_nature", cashflowForm) as string | undefined;
  const cashflowAttributeOptions = (
    ALLOWED_ATTRIBUTES_BY_FUND_NATURE[cashflowFormNature ?? "BUSINESS"]
    ?? Object.keys(ACCOUNTING_ATTRIBUTE_LABEL)
  ).map((value) => ({ value, label: ACCOUNTING_ATTRIBUTE_LABEL[value] ?? value }));
  const [transferForm] = Form.useForm();
  const [reconciliationForm] = Form.useForm();
  const [resolveForm] = Form.useForm();
  const [rejectForm] = Form.useForm();
  const [reverseForm] = Form.useForm();
  const [lossForm] = Form.useForm();
  const [cancelForm] = Form.useForm();
  const [repairForm] = Form.useForm();
  const [periodLockForm] = Form.useForm();

  // 用 ref 持有最新筛选值，使全局 load()（含写操作后刷新）也能套用当前筛选条件。
  const cashflowFromRef = useRef(cashflowFrom);
  cashflowFromRef.current = cashflowFrom;
  const cashflowToRef = useRef(cashflowTo);
  cashflowToRef.current = cashflowTo;
  const cashflowPoolIdRef = useRef(cashflowPoolId);
  cashflowPoolIdRef.current = cashflowPoolId;
  const cashflowDirectionRef = useRef(cashflowDirection);
  cashflowDirectionRef.current = cashflowDirection;
  const cashflowStatusRef = useRef(cashflowStatus);
  cashflowStatusRef.current = cashflowStatus;
  const cashflowFundNatureRef = useRef(cashflowFundNature);
  cashflowFundNatureRef.current = cashflowFundNature;
  const cashflowAttributeRef = useRef(cashflowAttribute);
  cashflowAttributeRef.current = cashflowAttribute;
  const cashflowCategoryRef = useRef(cashflowCategory);
  cashflowCategoryRef.current = cashflowCategory;

  // 资金流水：筛选全部走服务端（对齐 finance/router.py list_cashflows 的 11 个参数），
  // 避免 2000 条上限把池/方向/状态之外的结果挡在客户端之外。
  const fetchCashflows = useCallback(async () => {
    const result = await cashflowsApi.list({
      occurred_from: cashflowFromRef.current || undefined,
      occurred_to: cashflowToRef.current || undefined,
      pool_id: cashflowPoolIdRef.current ?? undefined,
      direction: cashflowDirectionRef.current || undefined,
      status: cashflowStatusRef.current || undefined,
      fund_nature: cashflowFundNatureRef.current || undefined,
      accounting_attribute: cashflowAttributeRef.current || undefined,
      category: cashflowCategoryRef.current.trim() || undefined,
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

  // keep-alive：建单（initial_buy/initial_costs）与退款都会生成资金流水，重新激活时重拉避免资金中心过期。
  useReloadOnActive(active, load);

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
      appMessage.success("押金占用已登记，不影响经营损益");
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
      appMessage.success("押金释放已登记");
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
      appMessage.success("押金损失已登记");
      setLossTarget(null);
      lossForm.resetFields();
      await load();
    });
  };

  const submitCancelDeposit = async (values: Record<string, unknown>) => {
    if (!cancelTarget) return;
    const targetId = cancelTarget.id;
    await write.run(async () => {
      await depositsApi.cancel(targetId, {
        cancelled_on: values.cancelled_on as string,
        reason: values.reason as string,
      });
      appMessage.success("押金已取消，已生成全额冲正流水");
      setCancelTarget(null);
      cancelForm.resetFields();
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
        nature: deriveCashflowNature(fundNature, direction),
        fund_nature: fundNature,
        accounting_attribute: String(values.accounting_attribute ?? "OPERATING_EXPENSE"),
        category: values.category as string,
        amount: values.amount as string,
        note: values.note as string,
      });
      appMessage.success("独立资金流水已提交，等待审核");
      setCashflowOpen(false);
      cashflowForm.resetFields();
      await load();
    });
  };

  const reviewCashflow = async (action: "approve" | "reject", row: Cashflow, reason?: string) => {
    await write.run(async () => {
      if (action === "approve") await cashflowsApi.approve(row.id);
      else await cashflowsApi.reject(row.id, reason ?? "");
      appMessage.success(action === "approve" ? "流水已审核" : "流水已拒绝");
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
      appMessage.success("流水已冲销");
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
      appMessage.success("资金池划转已登记");
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
      appMessage.success("单边划转已修复");
      setRepairTarget(null);
      repairForm.resetFields();
      await load();
    });
  };

  const submitPeriodLock = async (values: Record<string, unknown>) => {
    await write.run(async () => {
      await periodLocksApi.create({ period: values.period as string, note: values.note as string });
      appMessage.success("账期已锁定");
      setPeriodLockOpen(false);
      periodLockForm.resetFields();
      await load();
    });
  };

  const submitReconciliation = async (values: Record<string, unknown>) => {
    const poolId = Number(values.pool_id);
    const reconciledOn = values.reconciled_on as string;
    const accountLabel = (values.account_label as string).trim();
    // 唯一约束（domain/trade.py uq_reconciliations_scope：池+池内账户+日期+账户标签）客户端预检，
    // 命中重复即阻断并提示调整，避免用户直接吃到后端校验错误。
    if (
      reconciliations.some(
        (row) => row.pool_id === poolId && row.reconciled_on === reconciledOn && row.account_label === accountLabel,
      )
    ) {
      appMessage.warning("同一资金池、对账账户和日期只能对账一次，请调整对账日期或账户");
      return;
    }
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
      appMessage.success("对账记录已提交");
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
      appMessage.success("对账差异已核销");
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
  // 自有权益口径（domain/enums.py PoolOwnership：OWNED 计入权益，CUSTODY/THIRD_PART 只计现金头寸）。
  // 归属以资金池主数据为准；权益按现金头寸计、不扣押金占用——押金占用仍是自有资金，只是暂时不可用。
  const totalOwned = pools
    .filter((pool) => pool.ownership === "OWNED")
    .reduce((sum, pool) => sum + Number(balances[pool.id]?.cash_balance ?? 0), 0)
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
    {
      title: "资金池",
      dataIndex: "name",
      render: (_v, row) => `${row.name}（${row.code}）`,
      className: "ui-col-wrap",
      onCell: () => ({ className: "ui-col-wrap" }),
    },
    { title: "归属", dataIndex: "ownership", render: (v: string) => POOL_OWNERSHIP_LABEL[v] ?? v },
    { title: "状态", dataIndex: "status", width: 100, render: (v: string) => <StatusTag status={v} optionSet="POOL_STATUS" /> },
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
    { title: "状态", dataIndex: "status", width: 110, render: (v: string) => <StatusTag status={v} optionSet="DEPOSIT_STATUS" /> },
    {
      title: "操作",
      width: 270,
      render: (_v, row) => (
        <Space size={2}>
          <PermissionButton
            permission="deposit.post"
            size="small"
            disabled={row.status === "RETURNED" || row.status === "LOST" || row.status === "CANCELLED"}
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
            disabled={row.status === "RETURNED" || row.status === "LOST" || row.status === "CANCELLED"}
            onClick={() => {
              setLossTarget(row);
              lossForm.setFieldsValue({ lost_on: today() });
            }}
          >
            登记损失
          </PermissionButton>
          <PermissionButton
            permission="deposit.post"
            size="small"
            danger
            disabled={row.status !== "PAID"}
            onClick={() => {
              setCancelTarget(row);
              cancelForm.setFieldsValue({ cancelled_on: today() });
            }}
          >
            取消
          </PermissionButton>
        </Space>
      ),
    },
  ];

  const { arrange: arrangeCashflowColumns } = useListViewColumns("CASHFLOW");
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
      title: "流向",
      dataIndex: "nature",
      render: (v: string | null | undefined) =>
        natureOptionSet?.find((o) => o.value === (v ?? ""))?.label ?? NATURE_LABEL[v ?? ""] ?? v ?? "—",
    },
    {
      title: "金额",
      dataIndex: "amount",
      align: "right",
      render: (v: string) => <MoneyText value={v} />,
    },
    { title: "来源", dataIndex: "source" },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} label={configurableLabel("FUND_FLOW_STATUS", v, { PENDING: "待审核", APPROVED: "已审核", REJECTED: "已拒绝" })} /> },
    {
      title: "审核追溯",
      key: "audit",
      width: 190,
      render: (_v, row) => (
        <span className="muted">
          {row.reviewed_by
            ? `${row.reviewed_by}${row.reviewed_at ? ` · ${row.reviewed_at.replace("T", " ").slice(0, 16)}` : ""}`
            : "—"}
          {row.reversal_of_id ? ` · 冲销#${row.reversal_of_id}` : ""}
        </span>
      ),
    },
    { title: "备注", dataIndex: "note", render: (v: string | null) => v || "—" },
    {
      title: "操作",
      key: "actions",
      width: 170,
      render: (_v, row) => (
        <Space size={2}>
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
        </Space>
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
    { title: <Tooltip title="期初余额（账户级对账）+ 截至对账日已审核流水，剔除待审核/已拒绝">系统余额</Tooltip>, align: "right", render: (_v, row) => <MoneyText value={row.system_balance} /> },
    { title: "账面余额", align: "right", render: (_v, row) => <MoneyText value={row.statement_balance} /> },
    { title: "差异", align: "right", render: (_v, row) => <MoneyText value={row.difference} /> },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} label={configurableLabel("RECONCILIATION_STATUS", v, RECONCILIATION_STATUS_LABEL)} /> },
    {
      title: "操作",
      render: (_v, row) => (
        <Space size={2}>
          {row.status === "OPEN" ? (
            <PermissionButton permission="finance.read" size="small" onClick={() => setUnmatchedTarget(row)}>查看未达流水</PermissionButton>
          ) : null}
          {row.status === "OPEN" ? (
              <PermissionButton permission="deposit.post" size="small" onClick={() => setResolveTarget(row)}>核销</PermissionButton>
          ) : null}
        </Space>
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
                    { label: "自有权益合计", amount: totalOwned },
                  ]}
                />
                <Typography.Paragraph type="secondary" className="ui-card-hint">
                  口径：现金头寸含全部资金池；自有权益仅计归属为「{POOL_OWNERSHIP_LABEL.OWNED}」的池，「{POOL_OWNERSHIP_LABEL.CUSTODY}/{POOL_OWNERSHIP_LABEL.THIRD_PART}」只计头寸、不计权益；押金占用仍为自有资金，故权益不扣减占用。
                </Typography.Paragraph>
                {compact ? (
                  <MobilePoolList rows={pools} balances={balances} />
                ) : (
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
                )}
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
                  <Select aria-label="流水方向" allowClear value={cashflowDirection} placeholder="全部收支" options={flowDirectionOptions ?? []} onChange={setCashflowDirection} />
                  <Select aria-label="流水状态" allowClear value={cashflowStatus} placeholder="全部状态" options={flowStatusOptions ?? []} onChange={setCashflowStatus} />
                  <Select aria-label="流水资金性质" allowClear value={cashflowFundNature || undefined} placeholder="全部资金性质" options={flowFundNatureOptions ?? []} onChange={(value) => setCashflowFundNature(value ?? "")} />
                  <Select aria-label="流水核算属性" allowClear value={cashflowAttribute || undefined} placeholder="全部核算属性" options={flowAttributeOptions ?? []} onChange={(value) => setCashflowAttribute(value ?? "")} />
                  <Input aria-label="流水中类别筛选" allowClear value={cashflowCategory} placeholder="类别，如 REVERSAL" onChange={(event) => setCashflowCategory(event.target.value)} />
                  <Input aria-label="流水开始日期" value={cashflowFrom} placeholder="开始日期" onChange={(event) => setCashflowFrom(event.target.value)} />
                  <Input aria-label="流水结束日期" value={cashflowTo} placeholder="结束日期" onChange={(event) => setCashflowTo(event.target.value)} />
                  <PermissionButton permission="finance.read" onClick={() => void fetchCashflows()}>查询</PermissionButton>
                </div>
                <Typography.Paragraph type="secondary" className="ui-drawer-hint">
                  状态口径：订单事件过账生成的流水直接为「已审核」；本页手工登记的独立流水需审核通过后才计入系统余额。
                </Typography.Paragraph>
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
                {compact ? (
                  <MobileCashflowList
                    rows={visibleCashflows}
                    onApprove={(row) => reviewCashflow("approve", row)}
                    onReject={(row) => setRejectTarget(row)}
                    onReverse={(row) => { reverseForm.setFieldsValue({ reversed_on: today() }); setReverseTarget(row); }}
                  />
                ) : (
                  <DataTable<Cashflow>
                    columns={arrangeCashflowColumns(cashflowColumns)}
                    rows={visibleCashflows}
                    page={1}
                    pageSize={10}
                    total={visibleCashflows.length}
                    emptyText="暂无资金流水"
                    loading={loading}
                    onPageChange={() => undefined}
                 />
                )}
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
                {compact ? (
                  <MobileDepositList
                    rows={deposits}
                    pools={pools}
                    onRelease={(row) => { setReturnTarget(row); returnForm.setFieldsValue({ released_on: today() }); }}
                    onLoss={(row) => { setLossTarget(row); lossForm.setFieldsValue({ lost_on: today() }); }}
                    onCancel={(row) => { setCancelTarget(row); cancelForm.setFieldsValue({ cancelled_on: today() }); }}
                  />
                ) : (
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
                )}
              </Card>
            ),
          },
          {
            key: "reconciliations",
            label: "对账",
            children: (
              <Card className="glass" title="资金对账" extra={<PermissionButton permission="deposit.post" type="primary" onClick={() => { reconciliationForm.setFieldsValue({ reconciled_on: today() }); setReconciliationOpen(true); }}>新增对账</PermissionButton>}>
                <Typography.Paragraph type="secondary" className="ui-card-hint">
                  系统余额口径：截至对账日期「已审核」流水的累计（待审核/已拒绝不计入）；按池内账户对账时另含该账户期初余额。差异 = 账面余额 − 系统余额。
                </Typography.Paragraph>
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
            key: "rebates",
            label: "返点明细",
            children: <RebatesPanel />,
          },
          {
            key: "studio-expenses",
            label: "工作室支出",
            children: <StudioExpensePanel pools={pools} />,
          },
        ]}
      />

      <Modal title="新增押金占用" open={depositOpen} onCancel={() => setDepositOpen(false)} footer={null}>
        <InlineError error={write.error} />
        <FieldConfigScope scope="FUNDDEPOSIT" active={depositOpen}>
          <BusinessForm scope="FUNDDEPOSIT" form={depositForm} onFinish={submitDeposit} initialValues={{ paid_on: today() }}>
          <CfgItem name="pool_id" label="资金池" rules={[{ required: true }]}>
            <Select options={pools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))} />
          </CfgItem>
          <CfgItem name="counterparty_id" label="对手方 ID" extra="可选，填写已建档合作方 ID">
            <Input inputMode="numeric" />
          </CfgItem>
          <CfgItem name="source_order_id" label="来源订单 ID" extra="可选，填写关联订单 ID">
            <Input inputMode="numeric" />
          </CfgItem>
          <CfgItem name="amount" label="占用金额" rules={requiredMoneyRules("占用金额")}>
            <MoneyInput />
          </CfgItem>
          <CfgItem name="paid_on" label="占用日期" rules={[{ required: true }]}>
            <Input placeholder="YYYY-MM-DD" />
          </CfgItem>
          <CfgItem name="expected_release_on" label="预计释放日期">
            <Input placeholder="YYYY-MM-DD" />
          </CfgItem>
          <CfgItem name="note" label="说明">
            <Input.TextArea rows={2} />
          </CfgItem>
          <PermissionButton permission="deposit.post" type="primary" htmlType="submit" loading={write.pending}>
            提交
          </PermissionButton>
        </BusinessForm>
        </FieldConfigScope>
      </Modal>

      <Modal title="新增独立资金流水" open={cashflowOpen} onCancel={() => setCashflowOpen(false)} footer={null}>
        <InlineError error={write.error} />
        <FieldConfigScope scope="FUNDFLOW" active={cashflowOpen}>
          <BusinessForm scope="FUNDFLOW" form={cashflowForm} onFinish={submitCashflow} initialValues={{ occurred_on: today(), direction: "IN", fund_nature: "BUSINESS", accounting_attribute: "SELF_REVENUE" }}>
          <CfgItem name="pool_id" label="资金池" rules={[{ required: true }]}><Select options={pools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))} /></CfgItem>
          <CfgItem name="occurred_on" label="发生日期" rules={[{ required: true }]}><Input placeholder="YYYY-MM-DD" /></CfgItem>
          <CfgItem name="direction" label="收支方向" rules={[{ required: true }]}><Select /></CfgItem>
          <CfgItem name="fund_nature" label="资金性质" rules={[{ required: true }]}>
            <Select
              onChange={(value: string) => {
                // 资金性质切换后，原核算属性可能不在白名单内，自动改选首个合法项
                const allowed = ALLOWED_ATTRIBUTES_BY_FUND_NATURE[value] ?? [];
                const current = cashflowForm.getFieldValue("accounting_attribute") as string | undefined;
                if (current && !allowed.includes(current)) {
                  cashflowForm.setFieldsValue({ accounting_attribute: allowed[0] });
                }
              }}
            />
          </CfgItem>
          <CfgItem name="accounting_attribute" label="核算属性" rules={[{ required: true }]} help="可选范围由资金性质决定（与后端白名单一致）">
            <Select options={cashflowAttributeOptions} />
          </CfgItem>
          <CfgItem name="category" label="类别" rules={[{ required: true }]}><Input /></CfgItem>
          <CfgItem name="amount" label="金额" rules={requiredMoneyRules("金额")}><MoneyInput /></CfgItem>
          <CfgItem name="note" label="摘要" rules={[{ required: true }]}><Input.TextArea rows={2} /></CfgItem>
          <PermissionButton permission="deposit.post" type="primary" htmlType="submit" loading={write.pending}>提交审核</PermissionButton>
        </BusinessForm>
        </FieldConfigScope>
      </Modal>

      <Modal title="资金池划转" open={transferOpen} onCancel={() => setTransferOpen(false)} footer={null}>
        <InlineError error={write.error} />
        <FieldConfigScope scope="FUNDTRANSFER" active={transferOpen}>
          <BusinessForm scope="FUNDTRANSFER" form={transferForm} onFinish={submitTransfer} initialValues={{ occurred_on: today() }}>
          <CfgItem name="source_pool_id" label="转出资金池" rules={[{ required: true }]}><Select options={pools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))} /></CfgItem>
          <CfgItem name="target_pool_id" label="转入资金池" rules={[{ required: true }]}><Select options={pools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))} /></CfgItem>
          <CfgItem name="amount" label="划转金额" rules={requiredMoneyRules("划转金额")}><MoneyInput /></CfgItem>
          <CfgItem name="occurred_on" label="划转日期" rules={[{ required: true }]}><Input placeholder="YYYY-MM-DD" /></CfgItem>
          <CfgItem name="note" label="说明"><Input.TextArea rows={2} /></CfgItem>
          <PermissionButton permission="finance.transfer" type="primary" htmlType="submit" loading={write.pending}>确认划转</PermissionButton>
        </BusinessForm>
        </FieldConfigScope>
      </Modal>

      <Modal title="新增资金对账" open={reconciliationOpen} onCancel={() => setReconciliationOpen(false)} footer={null}>
        <InlineError error={write.error} />
        <FieldConfigScope scope="FUNDRECON" active={reconciliationOpen}>
          <BusinessForm scope="FUNDRECON" form={reconciliationForm} onFinish={submitReconciliation} initialValues={{ reconciled_on: today() }}>
          <CfgItem name="pool_id" label="资金池" rules={[{ required: true }]}><Select options={pools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))} /></CfgItem>
          <CfgItem name="reconciled_on" label="对账日期" rules={[{ required: true }]}><Input placeholder="YYYY-MM-DD" /></CfgItem>
          <CfgItem name="account_label" label="对账账户" rules={[{ required: true }]} extra="同一资金池 + 对账账户 + 对账日期只能对账一次，重复提交会被拒绝"><Input /></CfgItem>
          <CfgItem name="statement_balance" label="账面余额" rules={requiredMoneyRules("账面余额")}><MoneyInput /></CfgItem>
          <CfgItem name="unmatched_flow_ids" label="未达流水 ID" extra="多个 ID 用逗号分隔"><Input /></CfgItem>
          <CfgItem name="reason" label="差异原因" extra="账面余额与系统余额不一致时必填（系统余额=期初余额+已审核流水）"><Input.TextArea rows={2} /></CfgItem>
          <CfgItem name="note" label="说明"><Input.TextArea rows={2} /></CfgItem>
          <PermissionButton permission="deposit.post" type="primary" htmlType="submit" loading={write.pending}>提交对账</PermissionButton>
        </BusinessForm>
        </FieldConfigScope>
      </Modal>

      <Modal title="核销对账差异" open={Boolean(resolveTarget)} onCancel={() => setResolveTarget(null)} footer={null}>
        <InlineError error={write.error} />
        <FieldConfigScope scope="FUNDCLEAR" active={Boolean(resolveTarget)}>
          <BusinessForm scope="FUNDCLEAR" form={resolveForm} onFinish={resolveReconciliation}>
          <CfgItem name="reason" label="处理说明" rules={[{ required: true }]}><Input.TextArea rows={3} /></CfgItem>
          <PermissionButton permission="deposit.post" type="primary" htmlType="submit" loading={write.pending}>确认核销</PermissionButton>
        </BusinessForm>
        </FieldConfigScope>
      </Modal>

      <Modal title="拒绝资金流水" open={Boolean(rejectTarget)} onCancel={() => setRejectTarget(null)} footer={null}>
        <InlineError error={write.error} />
        <FieldConfigScope scope="FUNDREJECT" active={Boolean(rejectTarget)}>
          <BusinessForm scope="FUNDREJECT" form={rejectForm} onFinish={(values) => rejectTarget && void reviewCashflow("reject", rejectTarget, values.reason as string)}>
          <CfgItem name="reason" label="拒绝原因" rules={[{ required: true }]}><Input.TextArea rows={3} /></CfgItem>
          <PermissionButton permission="deposit.post" type="primary" htmlType="submit" loading={write.pending}>确认拒绝</PermissionButton>
        </BusinessForm>
        </FieldConfigScope>
      </Modal>

      <Modal title="冲销资金流水" open={Boolean(reverseTarget)} onCancel={() => setReverseTarget(null)} footer={null}>
        <InlineError error={write.error} />
        <FieldConfigScope scope="FUNDREVERSE" active={Boolean(reverseTarget)}>
          <BusinessForm scope="FUNDREVERSE" form={reverseForm} onFinish={reverseCashflow}>
          <Typography.Paragraph type="secondary" className="ui-drawer-hint">
            冲销会生成一笔方向相反、金额相同的流水：自动继承原流水的资金性质，核算属性固定为「冲销」，
            状态直接为「已审核」——不经过审核流程，提交即入账。原流水保留并标记为已冲销，不可重复冲销。
          </Typography.Paragraph>
          <CfgItem name="reversed_on" label="冲销日期" rules={[{ required: true }]}>
            <Input placeholder="YYYY-MM-DD" />
          </CfgItem>
          <CfgItem name="reason" label="冲销原因" rules={[{ required: true }]}>
            <Input.TextArea rows={3} />
          </CfgItem>
          <PermissionButton permission="deposit.post" type="primary" htmlType="submit" loading={write.pending}>
            确认冲销
          </PermissionButton>
        </BusinessForm>
        </FieldConfigScope>
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
        <FieldConfigScope scope="FUNDRELEASE" active={Boolean(returnTarget)}>
          <BusinessForm scope="FUNDRELEASE" form={returnForm} onFinish={submitReturn}>
          <CfgItem
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
          </CfgItem>
          <CfgItem name="released_on" label="释放日期" rules={[{ required: true }]}>
            <Input placeholder="YYYY-MM-DD" />
          </CfgItem>
          <PermissionButton permission="deposit.post" type="primary" htmlType="submit" loading={write.pending}>
            确认释放
          </PermissionButton>
        </BusinessForm>
        </FieldConfigScope>
      </Modal>

      <Modal title="登记押金损失" open={Boolean(lossTarget)} onCancel={() => setLossTarget(null)} footer={null}>
        <InlineError error={write.error} />
        <Typography.Paragraph type="warning">
          登记损失后该押金占用相应扣减，操作不可撤销，请核对金额与费用分类。
        </Typography.Paragraph>
        <FieldConfigScope scope="FUNDLOSS" active={Boolean(lossTarget)}>
          <BusinessForm scope="FUNDLOSS" form={lossForm} onFinish={submitLoss}>
          <CfgItem name="amount" label="损失金额" rules={requiredMoneyRules("损失金额")}><MoneyInput /></CfgItem>
          <CfgItem name="lost_on" label="损失日期" rules={[{ required: true }]}><Input placeholder="YYYY-MM-DD" /></CfgItem>
          <CfgItem name="category" label="费用分类" rules={[{ required: true }]}><Input /></CfgItem>
          <CfgItem name="reason" label="损失原因" rules={[{ required: true }]}><Input.TextArea rows={3} /></CfgItem>
          <PermissionButton permission="deposit.post" type="primary" htmlType="submit" loading={write.pending}>确认损失</PermissionButton>
        </BusinessForm>
        </FieldConfigScope>
      </Modal>

      <Modal
        title="取消押金"
        open={Boolean(cancelTarget)}
        onCancel={() => setCancelTarget(null)}
        footer={null}
      >
        <InlineError error={write.error} />
        {cancelTarget ? (
          <Typography.Paragraph type="secondary">
            押金占用合计 <MoneyText value={cancelTarget.paid_amount} />，尚未发生任何退还或损失。
          </Typography.Paragraph>
        ) : null}
        <Typography.Paragraph type="warning">
          取消用于「押金登记有误 / 租约取消且押金从未实际占用」。系统会按占用全额自动写一笔
          DEPOSIT_CANCEL 冲正流水把资金池占用冲平，操作不可撤销；已发生退还或损失的押金请改用释放 / 登记损失。
        </Typography.Paragraph>
        <FieldConfigScope scope="FUNDCANCEL" active={Boolean(cancelTarget)}>
          <BusinessForm scope="FUNDCANCEL" form={cancelForm} onFinish={submitCancelDeposit}>
            <CfgItem name="cancelled_on" label="取消日期" rules={[{ required: true }]}>
              <Input placeholder="YYYY-MM-DD" />
            </CfgItem>
            <CfgItem name="reason" label="取消原因" rules={[{ required: true, message: "请填写取消原因" }]}>
              <Input.TextArea rows={3} />
            </CfgItem>
            <PermissionButton permission="deposit.post" type="primary" danger htmlType="submit" loading={write.pending}>
              确认取消
            </PermissionButton>
          </BusinessForm>
        </FieldConfigScope>
      </Modal>

      <Modal title="修复单边划转" open={Boolean(repairTarget)} onCancel={() => setRepairTarget(null)} footer={null}>
        <Typography.Paragraph type="secondary">
          划转号：{repairTarget?.transfer_id}；现有流水：{repairTarget?.flow_no}
        </Typography.Paragraph>
        <InlineError error={write.error} />
        <FieldConfigScope scope="FUNDREPAIR" active={Boolean(repairTarget)}>
          <BusinessForm scope="FUNDREPAIR" form={repairForm} onFinish={submitRepair}>
          <CfgItem name="counterpart_pool_id" label="缺失对端资金池" rules={[{ required: true }]}>
            <Select options={pools.filter((pool) => pool.id !== repairTarget?.pool_id).map((pool) => ({ value: pool.id, title: `${pool.name}（${pool.code}）`, label: `${pool.name}（${pool.code}）` }))} />
          </CfgItem>
          <CfgItem name="reason" label="修复原因" rules={[{ required: true }]}><Input.TextArea rows={3} /></CfgItem>
          <PermissionButton permission="finance.transfer" type="primary" htmlType="submit" loading={write.pending}>确认修复</PermissionButton>
        </BusinessForm>
        </FieldConfigScope>
      </Modal>

      <Modal title="锁定账期" open={periodLockOpen} onCancel={() => setPeriodLockOpen(false)} footer={null}>
        <InlineError error={write.error} />
        <FieldConfigScope scope="FUNDLOCK" active={periodLockOpen}>
          <BusinessForm scope="FUNDLOCK" form={periodLockForm} onFinish={submitPeriodLock}>
          <CfgItem name="period" label="会计账期" rules={[{ required: true }, { pattern: /^\d{4}-\d{2}$/, message: "请输入 YYYY-MM" }]}><Input placeholder="YYYY-MM" /></CfgItem>
          <CfgItem name="note" label="说明"><Input.TextArea rows={3} /></CfgItem>
          <PermissionButton permission="deposit.post" type="primary" htmlType="submit" loading={write.pending}>确认锁定</PermissionButton>
        </BusinessForm>
        </FieldConfigScope>
      </Modal>

      <AntdModal title="未达流水" open={Boolean(unmatchedTarget)} onCancel={() => setUnmatchedTarget(null)} footer={null} width={900}>
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
      </AntdModal>
    </section>
  );
}

