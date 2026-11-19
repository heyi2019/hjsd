/** 分期售出取消后，回收和提号账号均回到库存。 */
import { money } from "./format";

/** 取消成功的提示：含退款金额与账号归宿。 */
export function cancelRefundSuccess(
  refundAmount: string | number | null | undefined,
  _contractType: string | undefined,
): string {
  const summary = `退款已登记：¥${money(refundAmount)}`;
  return `${summary}，账号已回到库存`;
}

/** 退款确认弹窗的说明文案。 */
export function cancelRefundIntro(_contractType: string | undefined): string {
  return "按已收款原资金账户退款，取消后账号回到库存。";
}
