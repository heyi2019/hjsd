import { useEffect, useState } from "react";
import { Form } from "antd";
import { appMessage } from "../shared/ui/appFeedback";
import { cashflowsApi } from "../shared/api/cashflows.api";
import { depositsApi } from "../shared/api/installments.api";
import { reconciliationsApi, transfersApi } from "../shared/api/pools.api";
import type { Cashflow, Deposit, Reconciliation } from "../shared/api/types/finance";
import { ACCOUNTING_ATTRIBUTE_LABEL } from "../shared/lib/labels";
import { today } from "../shared/lib/format";
import { useAsyncAction } from "../shared/hooks/useAsyncAction";

/** 资金中心写操作层：全部弹窗表单、目标状态与提交处理器。
 *  逐字切片自原 useFundsPageController；load/balances/reconciliations/write 由主 controller 注入，
 *  避免与数据层形成循环依赖。 */
interface FundsFormActionsDeps {
  load: () => Promise<void>;
  reconciliations: Reconciliation[];
  write: ReturnType<typeof useAsyncAction>;
}

export function useFundsFormActions({ load, reconciliations, write }: FundsFormActionsDeps) {
  const [depositOpen, setDepositOpen] = useState(false);
  const [depositEditTarget, setDepositEditTarget] = useState<Deposit | null>(null);
  const [cashflowOpen, setCashflowOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [reconciliationOpen, setReconciliationOpen] = useState(false);
  const [resolveTarget, setResolveTarget] = useState<Reconciliation | null>(null);
  const [reverseTarget, setReverseTarget] = useState<Cashflow | null>(null);
  const [returnTarget, setReturnTarget] = useState<Deposit | null>(null);
  const [lossTarget, setLossTarget] = useState<Deposit | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Deposit | null>(null);
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
    unmatchedTarget,
    write.clearError,
  ]);

  const [depositForm] = Form.useForm();
  const [returnForm] = Form.useForm();
  const [cashflowForm] = Form.useForm();
  const cashflowAttributeOptions = Object.entries(ACCOUNTING_ATTRIBUTE_LABEL)
    .map(([value, label]) => ({ value, label }));
  const [transferForm] = Form.useForm();
  const [reconciliationForm] = Form.useForm();
  const [resolveForm] = Form.useForm();
  const [reverseForm] = Form.useForm();
  const [lossForm] = Form.useForm();
  const [cancelForm] = Form.useForm();

  const openDepositCreate = () => {
    setDepositEditTarget(null);
    depositForm.resetFields();
    depositForm.setFieldsValue({ paid_on: today() });
    setDepositOpen(true);
  };

  const openDepositEdit = (target: Deposit) => {
    setDepositEditTarget(target);
    depositForm.setFieldsValue({
      pool_id: target.pool_id,
      amount: target.paid_amount,
      paid_on: target.paid_on,
      counterparty_id: target.counterparty_id ?? undefined,
      source_order_id: target.source_order_id ?? undefined,
      expected_release_on: target.expected_release_on ?? undefined,
      note: target.note ?? undefined,
    });
    setDepositOpen(true);
  };

  const closeDeposit = () => {
    setDepositOpen(false);
    setDepositEditTarget(null);
    depositForm.resetFields();
  };

  const submitDeposit = async (values: Record<string, unknown>) => {
    const editing = depositEditTarget;
    await write.run(async () => {
      const payload = {
        pool_id: Number(values.pool_id),
        amount: values.amount as string,
        paid_on: values.paid_on as string,
        counterparty_id: values.counterparty_id ? Number(values.counterparty_id) : undefined,
        source_order_id: values.source_order_id ? Number(values.source_order_id) : undefined,
        expected_release_on: values.expected_release_on as string | undefined,
        note: values.note as string,
      };
      if (editing) {
        await depositsApi.update(editing.id, payload);
        appMessage.success("押金占用已更新");
      } else {
        await depositsApi.create(payload);
        appMessage.success("押金占用已登记，不影响经营损益");
      }
      closeDeposit();
      await load();
    });
  };

  const deleteDeposit = async (depositId: number) => {
    await write.run(async () => {
      await depositsApi.remove(depositId);
      appMessage.success("押金占用已删除");
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
      const direction = String(values.direction ?? "IN");
      await cashflowsApi.create({
        pool_id: Number(values.pool_id),
        occurred_on: values.occurred_on as string,
        direction,
        fund_nature: String(values.fund_nature ?? "BUSINESS"),
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
    depositEditTarget,
    openDepositCreate,
    openDepositEdit,
    closeDeposit,
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
    submitDeposit,
    deleteDeposit,
    submitReturn,
    submitLoss,
    submitCancelDeposit,
    submitCashflow,
    reverseCashflow,
    submitTransfer,
    submitReconciliation,
    resolveReconciliation,
  };
}
