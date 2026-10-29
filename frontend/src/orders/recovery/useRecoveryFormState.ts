import { Form } from "antd";
import type { FormInstance } from "antd";

export function useRecoveryFormState(form: FormInstance) {
  const intermediaryFee = Form.useWatch("intermediary_fee", form) as number | undefined;
  const intermediaryType = Form.useWatch("intermediary_type", form) as string | undefined;
  const recoveryPrice = Form.useWatch("recovery_price", form) as number | undefined;
  const expenseItems = Form.useWatch("expense_items", form) as Array<{ amount?: number }> | undefined;
  const extraExpenses = (expenseItems ?? []).reduce((total, item) => total + (Number(item.amount) || 0), 0);

  return {
    intermediaryFee,
    intermediaryType,
    totalRecoveryCost: (Number(recoveryPrice) || 0) + (Number(intermediaryFee) || 0) + extraExpenses,
  };
}
