import { useEffect, useState } from "react";
import { Form } from "antd";
import { appMessage } from "../shared/ui/appFeedback";
import {
  cashflowsApi,
  depositsApi,
  reconciliationsApi,
  transfersApi,
  type Cashflow,
  type Deposit,
  type PoolBalance,
  type Reconciliation,
} from "../shared/api/catalog";
import { ACCOUNTING_ATTRIBUTE_LABEL } from "../shared/lib/labels";
import { useAsyncAction } from "../shared/hooks/useAsyncAction";
import { ALLOWED_ATTRIBUTES_BY_FUND_NATURE, deriveCashflowNature } from "./FundsPage.fragments";

/** 资金中心写操作层：全部弹窗表单、目标状态与提交处理器。
 *  逐字切片自原 useFundsPageController；load/balances/reconciliations/write 由主 controller 注入，
 *  避免与数据层形成循环依赖。 */
interface FundsFormActionsDeps {
  load: () => Promise<void>;
  balances: Record<number, PoolBalance>;
  reconciliations: Reconciliation[];
  write: ReturnType<typeof useAsyncAction>;
}

export function useFundsFormActions({ load, balances, reconciliations, write }: FundsFormActionsDeps) {
  const [depositOpen, setDepositOpen] = useState(false);
  const [cashflowOpen, setCashflowOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [reconciliationOpen, setReconciliationOpen] = useState(false);
  const [resolveTarget, setResolveTarget] = useState<Reconciliation | null>(null);
  const [reverseTarget, setReverseTarget] = useState<Cashflow | null>(null);
  const [returnTarget, setReturnTarget] = useState<Deposit | null>(null);
  const [lossTarget, setLossTarget] = useState<Deposit | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Deposit | null>(null);
  const [repairTarget, setRepairTarget] = useState<Cashflow | null>(null);
  const [unmatchedTarget, setUnmatchedTarget] = useState<Reconciliation | null>(null);

  // L1527-①：全部资金弹窗共用同一 write.error。任一弹窗开/关切换时清除该错误，
  // 避免 A 弹窗提交失败后其 alert 在 B 弹窗（或重新打开 A）中残留。
  // 提交失败停留当前弹窗时 open 态不变，错误仍可见；仅状态切换（开/关）触发清理。
  useEffect(() => {
    write.clearError();
  }, [
    depositOpen,
    cashflowOpen,
    transferOpen,
    reconciliationOpen,
    resolveTarget,
    reverseTarget,
    returnTarget,
    lossTarget,
    cancelTarget,
    repairTarget,
    unmatchedTarget,
    write.clearError,
  ]);

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
  const [reverseForm] = Form.useForm();
  const [lossForm] = Form.useForm();
  const [cancelForm] = Form.useForm();
  const [repairForm] = Form.useForm();

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
      appMessage.success("独立资金流水已提交，已入账");
      setCashflowOpen(false);
      cashflowForm.resetFields();
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
      const sourcePoolId = Number(values.source_pool_id);
      const targetPoolId = Number(values.target_pool_id);
      const amount = Number(values.amount);
      const available = balances[sourcePoolId]?.available;
      if (sourcePoolId === targetPoolId) {
        throw new Error("转入和转出资金池不能相同");
      }
      if (available != null && Number.isFinite(amount) && amount > Number(available) + 0.000001) {
        throw new Error("转出资金池可用余额不足");
      }
      await transfersApi.create({
        source_pool_id: sourcePoolId,
        target_pool_id: targetPoolId,
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

  return {
    depositOpen,
    setDepositOpen,
    cashflowOpen,
    setCashflowOpen,
    transferOpen,
    setTransferOpen,
    reconciliationOpen,
    setReconciliationOpen,
    resolveTarget,
    setResolveTarget,
    reverseTarget,
    setReverseTarget,
    returnTarget,
    setReturnTarget,
    lossTarget,
    setLossTarget,
    cancelTarget,
    setCancelTarget,
    repairTarget,
    setRepairTarget,
    unmatchedTarget,
    setUnmatchedTarget,
    cashflowAttributeOptions,
    depositForm,
    returnForm,
    cashflowForm,
    transferForm,
    reconciliationForm,
    resolveForm,
    reverseForm,
    lossForm,
    cancelForm,
    repairForm,
    submitDeposit,
    submitReturn,
    submitLoss,
    submitCancelDeposit,
    submitCashflow,
    reverseCashflow,
    submitTransfer,
    submitRepair,
    submitReconciliation,
    resolveReconciliation,
  };
}
