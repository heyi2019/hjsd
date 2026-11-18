/**
 * 分期取消的文案唯一源：成功提示与退款弹窗说明。
 *
 * 口径依据 backend/app/orders/cancellation_model.py::_settle_account_on_installment_cancel：
 * 终止分期按合约类型分流——PICKUP_SALE（提号分期）走 CANCEL_SELL_END（账号终止），
 * 其余走 CANCEL_STOCK（账号回流库存）。两种分支讲的都是**账号**归宿，
 * 故文案统一用「账号」，不写「交易」（历史曾两处写成「交易已结束」，已收敛）。
 *
 * 分期面板（installments）与订单页取消弹窗（orders）是同一取消业务的两个入口，
 * 调同一个 installmentsApi.cancel，必须共用本模块，避免同一动作出现两种说法。
 */
import { money } from "./format";

/** 终止分期后，该账号是「结束」还是「回到库存」。 */
export function isPickupSaleCancel(contractType: string | undefined): boolean {
  return contractType === "PICKUP_SALE";
}

/** 取消成功的提示：含退款金额与账号归宿。 */
export function cancelRefundSuccess(
  refundAmount: string | number | null | undefined,
  contractType: string | undefined,
): string {
  const summary = `退款已登记：¥${money(refundAmount)}`;
  return isPickupSaleCancel(contractType)
    ? `${summary}，提号账号已结束`
    : `${summary}，账号已回到库存`;
}

/** 退款确认弹窗的说明文案。 */
export function cancelRefundIntro(contractType: string | undefined): string {
  return isPickupSaleCancel(contractType)
    ? "按已收款原资金账户退款，提号取消后账号直接结束。"
    : "按已收款原资金账户退款，取消后账号回到库存。";
}
