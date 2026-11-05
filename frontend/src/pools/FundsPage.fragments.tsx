/** 资金中心：纯工具/常量。 */

// 与 backend/app/finance/attributes.py 的 _ALLOWED_ATTRIBUTES_BY_FUND_NATURE 保持一致：
// 资金性质决定可用核算属性，非法组合后端直接 422，此处事前收窄避免误选。
export const ALLOWED_ATTRIBUTES_BY_FUND_NATURE: Record<string, string[]> = {
  BUSINESS: [
    "SELF_REVENUE",
    "SELF_DIRECT_COST",
    "TH_DIRECT_COST",
    "TH_REVENUE",
    "SERVICE_REVENUE",
    "ADDITIONAL_INCOME",
    "ADDITIONAL_EXPENSE",
    "OPERATING_EXPENSE",
    "REVERSAL",
    "REFUND",
  ],
  EXTERNAL: ["DEPOSIT", "EXTERNAL_FUNDING", "REVERSAL"],
  INTERNAL: ["INTERNAL_TRANSFER"],
};

/** 新增流水的 nature 口径（纯函数，供单测矩阵直接覆盖）：
 *  外部/受托 → EXTERNAL_IN；内部调拨 → INTERNAL；本方经营按流向二分。 */
export const deriveCashflowNature = (fundNature: string, direction: string): string =>
  fundNature === "EXTERNAL" ? "EXTERNAL_IN" : fundNature === "INTERNAL" ? "INTERNAL" : direction === "IN" ? "BUSINESS_IN" : "BUSINESS_OUT";

