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

