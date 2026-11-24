import type { OrderFormField } from "../shared/api/types/forms";

/** DatePicker 值是 dayjs 对象；不引入 dayjs 依赖，按鸭子类型取 format。 */
export function toDateText(value: unknown): string | null {
  const candidate = value as { format?: (pattern: string) => string } | null;
  if (candidate && typeof candidate.format === "function") {
    return candidate.format("YYYY-MM-DD");
  }
  return typeof value === "string" ? value : null;
}

/** 从表单值里收集扩展字段：跳过空值，日期统一转 YYYY-MM-DD 字符串。 */
export function collectExtras(
  values: Record<string, unknown>,
  defs: OrderFormField[],
  options: { includeEmpty?: boolean } = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const def of defs) {
    const raw = values[def.field_key];
    if (raw === undefined) continue;
    if (!options.includeEmpty && (raw === null || raw === "" || (Array.isArray(raw) && raw.length === 0))) continue;
    const value = raw === null || raw === "" || (Array.isArray(raw) && raw.length === 0)
      ? (def.field_type === "MULTI_SELECT" ? [] : null)
      : raw;
    out[def.field_key] = def.field_type === "DATE" ? toDateText(value) : value;
  }
  return out;
}
