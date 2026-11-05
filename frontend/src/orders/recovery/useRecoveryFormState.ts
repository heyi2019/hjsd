import { Form } from "antd";
import type { FormInstance } from "antd";
import { fromCents, sumCents } from "../../shared/lib/money";

export function useRecoveryFormState(form: FormInstance) {
  const intermediaryFee = Form.useWatch("intermediary_fee", form) as number | undefined;
  const intermediaryType = Form.useWatch("intermediary_type", form) as string | undefined;
  const recoveryPrice = Form.useWatch("recovery_price", form) as number | undefined;
  const expenseItems = Form.useWatch("expense_items", form) as Array<{ amount?: number }> | undefined;
  // 输入期合计只能在前端算（还没提交，后端拿不到），但一律换成分后再相加，
  // 避免 `0.1 + 0.2` 这类浮点残渣被原样带到「付款金额」上。
  const totalRecoveryCostCents = sumCents([recoveryPrice, intermediaryFee, ...(expenseItems ?? []).map((item) => item.amount)]);

  return {
    intermediaryFee,
    intermediaryType,
    totalRecoveryCostCents,
    totalRecoveryCost: fromCents(totalRecoveryCostCents),
  };
}
