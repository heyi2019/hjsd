/**
 * 售卖分期的金额规划：**单点算法**，全程整数「分」运算。
 *
 * 为什么单独成模块：售卖弹窗里原来有三套各自为政的算法——
 * 1. 自动填每期金额（`Math.ceil(... / count) / 100`，向上取整到分）；
 * 2. 提示「最后一期」（`(总额 − 每期 × (n−1))`，反推尾差）；
 * 3. 「每期金额」校验（`amount*count`、`amount*(count−1)` 与总额比大小）。
 * 三者对「尾差归谁」的理解不一致，用 float 又各自四舍五入，改一处就会与另两处打架。
 * 现在统一：总额换算成分 → 每期向上取整到分 → 末期吸收尾差；校验也用同一套分。
 *
 * 边界：期数非正整数、金额非数字时返回 null（由对应字段自己的规则报错，这里不重复）。
 */

import { fromCents as formatCents, toCents } from "../shared/lib/money";

export interface SaleInstallmentPlan {
  /** 期数（正整数）。 */
  count: number;
  /** 本金：售出金额 − 首付，单位分。 */
  baseCents: number;
  /** 每期金额×期数 应覆盖的总额：本金 + 分期服务费，单位分。 */
  totalCents: number;
  /** 自动建议的每期金额（向上取整到分），单位分。 */
  perPeriodCents: number;
  /** 按建议每期金额算出的末期金额（吸收尾差），单位分。 */
  lastPeriodCents: number;
  /** 建议每期金额（2 位小数字符串）。 */
  perPeriod: string;
  /** 末期金额（2 位小数字符串）。 */
  lastPeriod: string;
}

// 分换算统一由 shared/lib/money 提供；此处仅按原名字导出，避免调用方改动。
export { fromCents as formatCents, toCents } from "../shared/lib/money";

export function saleInstallmentPlan(input: {
  saleAmount: unknown;
  downPayment?: unknown;
  serviceFee?: unknown;
  periods: unknown;
}): SaleInstallmentPlan | null {
  const count = Number(input.periods);
  const baseCents = toCents(input.saleAmount) - toCents(input.downPayment ?? 0);
  const feeCents = toCents(input.serviceFee ?? 0);
  if (!Number.isFinite(baseCents) || !Number.isFinite(feeCents)) return null;
  if (!Number.isInteger(count) || count <= 0) return null;
  const totalCents = baseCents + feeCents;
  const perPeriodCents = Math.ceil(totalCents / count);
  const lastPeriodCents = totalCents - perPeriodCents * (count - 1);
  return {
    count,
    baseCents,
    totalCents,
    perPeriodCents,
    lastPeriodCents,
    perPeriod: formatCents(perPeriodCents),
    lastPeriod: formatCents(lastPeriodCents),
  };
}

/** 按用户当前填写的每期金额反推末期金额；金额非法时返回 null。 */
export function lastPeriodAmount(plan: SaleInstallmentPlan, perPeriod: unknown): string | null {
  const perCents = toCents(perPeriod);
  if (!Number.isFinite(perCents)) return null;
  return formatCents(plan.totalCents - perCents * (plan.count - 1));
}

/** 每期金额与分期总额是否不匹配（不匹配即为校验失败）。 */
export function saleInstallmentMismatch(
  plan: SaleInstallmentPlan | null,
  perPeriod: unknown,
): boolean {
  // 期数/金额本身非法时由各自字段报错，此处不重复拦截。
  if (!plan) return false;
  const perCents = toCents(perPeriod);
  if (!Number.isFinite(perCents) || perCents < 0) return true;
  // 期数×每期金额 收不回本金；或末期会被算成负数。
  if (perCents * plan.count < plan.baseCents) return true;
  if (perCents * (plan.count - 1) > plan.totalCents) return true;
  return false;
}

/** 每期服务费 = 服务费总额 / 期数（四舍五入到分），返回数值供表单写入。 */
export function perPeriodServiceFee(totalServiceFee: unknown, periods: unknown): number | null {
  const count = Number(periods);
  const totalCents = toCents(totalServiceFee);
  if (!Number.isFinite(totalCents) || !Number.isInteger(count) || count <= 0) return null;
  return Math.round(totalCents / count) / 100;
}
