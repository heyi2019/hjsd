import { DatePicker, Input, InputNumber, Switch } from "antd";
import dayjs from "dayjs";
import type { OrderFormField } from "../../../shared/api/types/forms";
import { formatExtraDisplayValue, resolveOptionItems } from "../../../shared/forms/ConfigurableField";
import { Select } from "../../../shared/ui";

/** 订单详情中的自定义字段按配置类型编辑，保留提交值的类型。 */
export function OrderDetailCustomFieldInput({ label, definition, value, onChange }: {
  label: string;
  definition?: OrderFormField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const ariaLabel = `编辑${label}`;
  switch (definition?.field_type) {
    case "NUMBER":
      return <InputNumber aria-label={ariaLabel} value={typeof value === "number" ? value : null} onChange={onChange} />;
    case "BOOLEAN":
      return <Switch aria-label={ariaLabel} checked={value === true} onChange={onChange} />;
    case "DATE":
      return <DatePicker aria-label={ariaLabel} value={typeof value === "string" && dayjs(value).isValid() ? dayjs(value) : null}
        onChange={(date) => onChange(date ? date.format("YYYY-MM-DD") : null)} />;
    case "SELECT":
      return <Select aria-label={ariaLabel} value={typeof value === "string" ? value : undefined}
        options={resolveOptionItems(definition.options)} allowClear onChange={onChange} />;
    case "MULTI_SELECT":
      return <Select aria-label={ariaLabel} mode="multiple" value={Array.isArray(value) ? value : []}
        options={resolveOptionItems(definition.options)} allowClear onChange={onChange} />;
    default:
      return <Input aria-label={ariaLabel} value={formatExtraDisplayValue(value)} onChange={(event) => onChange(event.target.value)} />;
  }
}
