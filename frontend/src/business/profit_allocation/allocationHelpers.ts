export type AllocationType = "BUY" | "SELL" | "OPERATION" | "COMPANY";
export const ALLOCATION_TYPE_LABEL: Record<AllocationType, string> = {
  BUY: "买号",
  SELL: "售出",
  OPERATION: "运营",
  COMPANY: "公司",
};

export type AllocationFormRow = {
  employee?: number | "COMPANY";
  employee_ids?: number[];
  role?: string;
  allocation_type?: AllocationType | "";
  allocation_rate?: string;
  allocation_amount?: string;
};

export type ActionAllocationCandidates = Record<AllocationType, number[]>;

function hundredths(value: string): bigint | null {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const result = BigInt(match[2]) * 100n + BigInt((match[3] ?? "").padEnd(2, "0"));
  return match[1] ? -result : result;
}

function roundedDivision(numerator: bigint, denominator: bigint): bigint {
  const negative = (numerator < 0n) !== (denominator < 0n);
  const dividend = numerator < 0n ? -numerator : numerator;
  const divisor = denominator < 0n ? -denominator : denominator;
  const quotient = dividend / divisor;
  const rounded = quotient + ((dividend % divisor) * 2n >= divisor ? 1n : 0n);
  return negative ? -rounded : rounded;
}

function formatHundredths(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

/** 使用后端总利润做输入联动；以整数分计算并与后端一样四舍五入。 */
export function convertAllocationValue(profit: string, direction: "RATE_TO_AMOUNT" | "AMOUNT_TO_RATE", value: string): string | null {
  const base = hundredths(profit);
  const input = hundredths(value);
  if (base === null || input === null) return null;
  if (direction === "RATE_TO_AMOUNT") {
    if (input < 0n || input > 10000n) return null;
    return formatHundredths(roundedDivision(base * input, 10000n));
  }
  if (base === 0n) return null;
  return formatHundredths(roundedDivision(input * 10000n, base));
}

export function buildAllocationOptionGroups<T extends { value: number | "COMPANY" }>(
  candidates: ActionAllocationCandidates,
  options: T[],
): { BUY: T[]; SELL: T[]; other: T[] } {
  const buyIds = new Set(candidates.BUY);
  const sellIds = new Set(candidates.SELL);
  const groups: { BUY: T[]; SELL: T[]; other: T[] } = { BUY: [], SELL: [], other: [] };
  for (const option of options) {
    const value = option.value;
    if (typeof value === "number" && buyIds.has(value)) groups.BUY.push(option);
    if (typeof value === "number" && sellIds.has(value)) groups.SELL.push(option);
    if (value !== "COMPANY") groups.other.push(option);
  }
  return groups;
}

