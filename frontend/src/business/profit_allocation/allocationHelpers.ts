export type AllocationType = "BUY" | "SELL" | "OPERATION" | "COMPANY";
export const ALLOCATION_TYPES: readonly AllocationType[] = ["BUY", "SELL", "OPERATION", "COMPANY"];

export const ALLOCATION_TYPE_LABEL: Record<AllocationType, string> = {
  BUY: "买号",
  SELL: "售出",
  OPERATION: "运营",
  COMPANY: "公司",
};

export const ALLOCATION_TYPE_ROLE: Record<AllocationType, string> = {
  BUY: "BUYER",
  SELL: "SALES",
  OPERATION: "SERVICE",
  COMPANY: "OWNER",
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

/** 正整数 ID 去重：所有来源统一走这里，避免各写一遍。 */
function ids(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0))];
}

/** 依次取第一个非空人员列表。 */
function firstNonEmpty(...sources: number[][]): number[] {
  return sources.find((source) => source.length > 0) ?? [];
}

/**
 * 按操作四项构建表单行。每个动作固定一行，人员使用多选，比例或金额只填动作合计；
 * 保存时由后端按所选人数均分并校验。
 */
export function buildActionAllocationRows(
  items: Array<{
    allocation_type?: AllocationType | null;
    user_id?: number | null;
    role?: string;
    allocation_rate?: string;
    allocation_amount?: string;
  }>,
  candidates: ActionAllocationCandidates,
  totalsByType: Partial<Record<AllocationType, { allocation_rate: string; allocation_amount: string }>> = {},
): AllocationFormRow[] {
  return ALLOCATION_TYPES.map((kind) => {
    const isCompany = kind === "COMPANY";
    const existed = items.filter((item) => item.allocation_type === kind);
    const existedIds = ids(existed.map((item) => item.user_id));
    const selectedIds = isCompany ? undefined : firstNonEmpty(candidates[kind], existedIds);
    return {
      allocation_type: kind,
      employee: isCompany ? "COMPANY" : undefined,
      employee_ids: selectedIds,
      role: existed[0]?.role || ALLOCATION_TYPE_ROLE[kind],
      allocation_rate: totalsByType[kind]?.allocation_rate ?? "",
      allocation_amount: totalsByType[kind]?.allocation_amount ?? "",
    };
  });
}

