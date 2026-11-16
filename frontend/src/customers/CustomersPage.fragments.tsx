import { DatePicker, Input, InputNumber, Switch } from "antd";
import { Select } from "../shared/ui";
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

/** 按字段类型渲染表单控件（BAS-04：类型由字段定义决定）。
 *  必须透传 Form.Item 注入的 id / value / onChange：包装组件若吞掉这些 props，
 *  标签的 htmlFor 会指向不存在的 id（a11y 断链），且表单值收集为空。 */
export function ExtraFieldControl({ def, ...controlProps }: { def: OrderFormField; [key: string]: unknown }) {
  const options = def.options ?? [];
  switch (def.field_type) {
    case "NUMBER":
      return <InputNumber {...controlProps} className="ui-control-full" />;
    case "DATE":
      return <DatePicker {...controlProps} className="ui-control-full" />;
    case "BOOLEAN":
      return <Switch {...controlProps} />;
    case "SELECT":
      return <Select {...controlProps} allowClear options={options} />;
    case "MULTI_SELECT":
      return <Select {...controlProps} mode="multiple" options={options} />;
    default:
      return <Input {...controlProps} />;
  }
}

