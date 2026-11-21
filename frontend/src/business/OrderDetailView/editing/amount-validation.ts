import { moneyValidationError } from "../../../shared/lib/validators";

/** 订单详情金额与后端 DECIMAL(18,2) 输入限制保持一致。 */
export function editedMoneyError(value: string): string | undefined {
  if (!value) return "请输入金额";
  return moneyValidationError(value, "金额", { maxIntegerDigits: 16 });
}
