import { Form } from "antd";
import { useState } from "react";
import { appMessage } from "../shared/ui/appFeedback";
import { reconciliationsApi } from "../shared/api/reconciliations.api";
import type { Reconciliation } from "../shared/api/types/finance";
import { useAsyncAction } from "../shared/hooks/useAsyncAction";

interface ReconciliationActionsDeps {
  load: () => Promise<void>;
  reconciliations: Reconciliation[];
  write: ReturnType<typeof useAsyncAction>;
}

/** 资金对账写路径：创建对账记录与核销差异。 */
export function useReconciliationActions({ load, reconciliations, write }: ReconciliationActionsDeps) {
  const [reconciliationOpen, setReconciliationOpen] = useState(false);
  const [resolveTarget, setResolveTarget] = useState<Reconciliation | null>(null);
  const [reconciliationForm] = Form.useForm();
  const [resolveForm] = Form.useForm();

  const submitReconciliation = async (values: Record<string, unknown>) => {
    const poolId = Number(values.pool_id);
    const reconciledOn = values.reconciled_on as string;
    const accountLabel = (values.account_label as string).trim();
    if (
      reconciliations.some(
        (row) => row.pool_id === poolId && row.reconciled_on === reconciledOn && row.account_label === accountLabel,
      )
    ) {
      appMessage.warning("同一资金账户、对账账户和日期只能对账一次，请调整对账日期或账户");
      return;
    }

    await write.run(async () => {
      await reconciliationsApi.create({
        pool_id: poolId,
        reconciled_on: reconciledOn,
        account_label: values.account_label as string,
        statement_balance: values.statement_balance as string,
        reason: values.reason as string,
        note: values.note as string,
        operator_user_ids: values.operator_user_ids as number[] | undefined,
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
      await reconciliationsApi.resolve(targetId, values.reason as string, values.operator_user_ids as number[] | undefined);
      appMessage.success("对账差异已核销");
      setResolveTarget(null);
      resolveForm.resetFields();
      await load();
    });
  };

  return {
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
