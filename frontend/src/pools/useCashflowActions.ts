import { Form } from "antd";
import { useState } from "react";
import { appMessage } from "../shared/ui/appFeedback";
import { cashflowsApi } from "../shared/api/cashflows.api";
import type { Cashflow } from "../shared/api/types/finance";
import { ACCOUNTING_ATTRIBUTE_LABEL } from "../shared/lib/labels";
import { useAsyncAction } from "../shared/hooks/useAsyncAction";

interface CashflowActionsDeps {
  load: () => Promise<void>;
  write: ReturnType<typeof useAsyncAction>;
}

/** 资金流水写路径：登记独立流水与冲销流水。 */
export function useCashflowActions({ load, write }: CashflowActionsDeps) {
  const [cashflowOpen, setCashflowOpen] = useState(false);
  const [reverseTarget, setReverseTarget] = useState<Cashflow | null>(null);
  const [cashflowForm] = Form.useForm();
  const [reverseForm] = Form.useForm();
  const cashflowAttributeOptions = Object.entries(ACCOUNTING_ATTRIBUTE_LABEL)
    .map(([value, label]) => ({ value, label }));

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
        operator_user_ids: values.operator_user_ids as number[] | undefined,
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
        operator_user_ids: values.operator_user_ids as number[] | undefined,
      });
      appMessage.success("流水已冲销");
      setReverseTarget(null);
      reverseForm.resetFields();
      await load();
    });
  };

  return {
    cashflowOpen,
    setCashflowOpen,
    reverseTarget,
    setReverseTarget,
    cashflowAttributeOptions,
    cashflowForm,
    reverseForm,
    submitCashflow,
    reverseCashflow,
  };
}
