import { useEffect, useState } from "react";
import { Form } from "antd";
import { appMessage } from "../shared/ui/appFeedback";
import { reconciliationsApi } from "../shared/api/reconciliations.api";
import type { Reconciliation } from "../shared/api/types/finance";
import { today } from "../shared/lib/format";
import { useAsyncAction } from "../shared/hooks/useAsyncAction";
import { useCashflowActions } from "./useCashflowActions";
import { useDepositActions } from "./useDepositActions";
import { useTransferActions } from "./useTransferActions";

/** 资金中心写操作层：全部弹窗表单、目标状态与提交处理器。
 *  逐字切片自原 useFundsPageController；load/balances/reconciliations/write 由主 controller 注入，
 *  避免与数据层形成循环依赖。 */
interface FundsFormActionsDeps {
  load: () => Promise<void>;
  reconciliations: Reconciliation[];
  write: ReturnType<typeof useAsyncAction>;
}

export function useFundsFormActions({ load, reconciliations, write }: FundsFormActionsDeps) {
  const [reconciliationOpen, setReconciliationOpen] = useState(false);
  const [resolveTarget, setResolveTarget] = useState<Reconciliation | null>(null);
  const cashflow = useCashflowActions({ load, write });
  const deposit = useDepositActions({ load, write });
  const transfer = useTransferActions({ load, write });

  // L1527-①：全部资金弹窗共用同一 write.error。任一弹窗开/关切换时清除该错误，
  // 避免 A 弹窗提交失败后其 alert 在 B 弹窗（或重新打开 A）中残留。
  // 提交失败停留当前弹窗时 open 态不变，错误仍可见；仅状态切换（开/关）触发清理。
  useEffect(() => {
    write.clearError();
  }, [
    deposit.depositOpen,
    cashflow.cashflowOpen,
    transfer.transferOpen,
    reconciliationOpen,
    resolveTarget,
    cashflow.reverseTarget,
    deposit.returnTarget,
    deposit.lossTarget,
    deposit.cancelTarget,
    write.clearError,
  ]);

  const [reconciliationForm] = Form.useForm();
  const [resolveForm] = Form.useForm();

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
      await reconciliationsApi.create({
        pool_id: Number(values.pool_id),
        reconciled_on: values.reconciled_on as string,
        account_label: values.account_label as string,
        statement_balance: values.statement_balance as string,
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
    ...cashflow,
    ...deposit,
    ...transfer,
    reconciliationOpen,
    setReconciliationOpen,
    resolveTarget,
    setResolveTarget,
    reconciliationForm,
    resolveForm,
    submitReconciliation,
    resolveReconciliation,
  };
}
