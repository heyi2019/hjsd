/** form_extra 历史值展示兜底口径；拆分自 ConfigurableField.tsx。 */
import type { OrderFormField } from "../../api/types/forms";

export type FormExtraStatus = "active" | "inactive" | "deleted";

export type FormExtraDisplayItem = {
  key: string;
  label: string;
  value: unknown;
  status: FormExtraStatus;
};

/** 把 form_extra 原始值展开为展示列表，统一「定义缺失/停用」的兜底口径：
 *  - 有定义：label 取配置名，status 按 is_active 区分 active / inactive；
 *  - 无定义（字段已删除）：label 回退裸 key，status = deleted。
 * 空值（null / "" / 空数组）过滤。客户列表、客户详情、订单详情共用本函数，
 * 确保删除/停用字段的历史值始终可见且口径一致（修复「列表看到、详情消失」的矛盾）。 */
export function buildFormExtraDisplay(
  extra: Record<string, unknown> | null | undefined,
  fieldDefs?: Array<Pick<OrderFormField, "field_key" | "label" | "is_active">>,
): FormExtraDisplayItem[] {
  if (!extra) return [];
  const defMap = new Map((fieldDefs ?? []).map((d) => [d.field_key, d]));
  const items: FormExtraDisplayItem[] = [];
  for (const [key, value] of Object.entries(extra)) {
    if (
      value === null ||
      value === undefined ||
      value === "" ||
      (Array.isArray(value) && value.length === 0)
    ) {
      continue;
    }
    const def = defMap.get(key);
    items.push({
      key,
      label: def ? def.label : key,
      value,
      status: def ? (def.is_active ? "active" : "inactive") : "deleted",
    });
  }
  return items;
}

/** 历史扩展字段值的通用格式化（与展示兜底共用，避免各页面重复实现）。 */
export function formatExtraDisplayValue(value: unknown, options?: OrderFormField["options"]): string {
  if (value === null || value === undefined || value === "") return "";
  const label = (item: unknown) => typeof item === "string"
    ? options?.find((option) => option.value === item)?.label ?? item
    : item;
  if (Array.isArray(value)) return value.map((item) => String(label(item))).join("、");
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(label(value));
}
