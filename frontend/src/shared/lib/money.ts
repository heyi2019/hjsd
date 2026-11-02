/**
 * 前端金额运算的**唯一入口**：一律换算成整数「分」再算，禁止直接对元做浮点加减乘除。
 *
 * 为什么不直接用 Number：`0.1 + 0.2 = 0.30000000000000004`、`1.005 * 100 = 100.49999999999999`，
 * 累加几笔费用就会在末位漂移，展示层再 `toFixed(2)` 只能把错误四舍五入得"看起来对"。
 *
 * 职责边界：这里只做**输入期**的本地换算（表单还没提交，后端拿不到值）。
 * 凡数据已经落库、或后端能算出来的派生值（合计、剩余、可冲销额、余额等），
 * 一律走后端字段，不在前端重算。
 */

/** 元 → 分。非数字返回 NaN，由调用方判空（不要静默当 0，否则错误输入会被吞掉）。 */
export function toCents(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return Number.NaN;
  // 先 `×100` 再去掉浮点尾巴再取整：直接 Math.round(1.005 * 100) 会因
  // 100.49999999999999 退到 100（少 1 分）。toFixed(4) 只用来抹掉尾数噪声。
  return Math.round(Number((numeric * 100).toFixed(4)));
}

/** 分 → 2 位小数字符串（只做展示格式化，不参与后续运算）。 */
export function fromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** 百分比 → 基点（1% = 100bp）。用于「比率 × 金额」这类互算，避免比率本身带浮点。 */
export function toBasisPoints(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) : Number.NaN;
}

/** 基点 → 2 位小数字符串。 */
export function fromBasisPoints(bp: number): string {
  return (bp / 100).toFixed(2);
}

/** 多笔金额（元）求和，返回分。空值/非法值按 0 计（表单里空着就等于没填）。 */
export function sumCents(values: Array<unknown>): number {
  return values.reduce<number>((sum, value) => {
    const cents = toCents(value);
    return sum + (Number.isFinite(cents) ? cents : 0);
  }, 0);
}

/** 多笔金额（元）求和，返回 2 位小数字符串。 */
export function sumMoney(values: Array<unknown>): string {
  return fromCents(sumCents(values));
}

/** 按比率（基点）求金额：`金额 × 比率 / 100`，四舍五入到分。 */
export function amountByBasisPoints(amountCents: number, bp: number): number {
  return Math.round((amountCents * bp) / 10000);
}

/** 按金额求比率（基点）：`部分 / 总额 × 100`，四舍五入到 0.01%。总额为 0 时抛错由调用方判。 */
export function basisPointsByAmount(totalCents: number, partCents: number): number {
  if (!totalCents) return Number.NaN;
  return Math.round((partCents * 10000) / totalCents);
}
