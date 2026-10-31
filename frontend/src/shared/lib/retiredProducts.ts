type ValueOption = { value: string };
type OrderTypeRow = { code: string };

const RETIRED_ORDER_TYPE_CODES = new Set(["DFQ"]);
const RETIRED_VALUE_ADDED_SERVICE_CODES = new Set(["ADVANCE_PURCHASE"]);

export function filterRetiredOrderTypeOptions<T extends ValueOption>(options: T[]): T[] {
  return options.filter((option) => !RETIRED_ORDER_TYPE_CODES.has(option.value));
}

export function filterRetiredValueAddedServiceOptions<T extends ValueOption>(options: T[]): T[] {
  return options.filter((option) => !RETIRED_VALUE_ADDED_SERVICE_CODES.has(option.value));
}

export function filterRetiredOrderTypes<T extends OrderTypeRow>(rows: T[]): T[] {
  return rows.filter((row) => !RETIRED_ORDER_TYPE_CODES.has(row.code));
}
