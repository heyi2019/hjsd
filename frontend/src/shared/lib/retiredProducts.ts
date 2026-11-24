type ValueOption = { value: string };
type OrderTypeRow = { code: string };

const RETIRED_ORDER_TYPE_CODES = new Set(["DFQ"]);

export function filterRetiredOrderTypeOptions<T extends ValueOption>(options: T[]): T[] {
  return options.filter((option) => !RETIRED_ORDER_TYPE_CODES.has(option.value));
}

export function filterRetiredOrderTypes<T extends OrderTypeRow>(rows: T[]): T[] {
  return rows.filter((row) => !RETIRED_ORDER_TYPE_CODES.has(row.code));
}
