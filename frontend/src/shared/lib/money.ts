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

/** 多笔金额（元）求和，返回分。空值/非法值按 0 计（表单里空着就等于没填）。 */
export function sumCents(values: Array<unknown>): number {
  return values.reduce<number>((sum, value) => {
    const cents = toCents(value);
    return sum + (Number.isFinite(cents) ? cents : 0);
  }, 0);
}

/** 多笔金额（元）求和，返回 2 位小数字符串；字符串金额不经过浮点数。 */
export function sumMoney(values: Array<unknown>): string {
  const total = values.reduce<bigint>((sum, value) => {
    if (typeof value !== "string" && typeof value !== "number") return sum;
    const match = String(value).trim().match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/);
    if (!match) {
      const cents = toCents(value);
      return Number.isSafeInteger(cents) ? sum + BigInt(cents) : sum;
    }
    const fraction = match[3] ?? match[4] ?? "";
    let cents = BigInt(match[2] ?? "0") * 100n + BigInt((fraction + "00").slice(0, 2));
    const roundUp = match[1] === "-"
      ? fraction[2] > "5" || (fraction[2] === "5" && /[1-9]/.test(fraction.slice(3)))
      : fraction[2] >= "5";
    if (roundUp) cents += 1n;
    return sum + (match[1] === "-" ? -cents : cents);
  }, 0n);
  const absolute = total < 0n ? -total : total;
  return `${total < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}
