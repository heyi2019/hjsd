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

/** 新增独立流水的 nature 口径（纯函数，供单测矩阵直接覆盖）。
 *
 * 必须与后端 create_cashflow 的准入校验一致（finance/cashflows.py:97-105）：
 * - 独立流水**禁止** INTERNAL（内部调拨请走池间划转接口，submitCashflow 另有前置拦截）；
 * - 支出（OUT）的 nature 只能是 BUSINESS_OUT，与资金性质无关——外部/受托性质的支出
 *   仍以 BUSINESS_OUT 入账（后端只校验 nature↔direction 与 fund_nature↔accounting_attribute）；
 * - 收入（IN）才按资金性质二分：EXTERNAL → EXTERNAL_IN，其余 → BUSINESS_IN。
 *
 * 旧实现把 EXTERNAL/INTERNAL 无条件放在 direction 之前判断，导致
 * EXTERNAL+OUT 派生成自相矛盾的 EXTERNAL_IN、INTERNAL+任意方向派生成后端硬拒的 INTERNAL。 */
export const deriveCashflowNature = (fundNature: string, direction: string): string => {
  if (direction === "OUT") return "BUSINESS_OUT";
  return fundNature === "EXTERNAL" ? "EXTERNAL_IN" : "BUSINESS_IN";
};

