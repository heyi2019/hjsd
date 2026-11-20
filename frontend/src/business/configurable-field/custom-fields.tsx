/** 自定义字段渲染与选项解析；拆分自 ConfigurableField.tsx。 */
import { DatePicker, Form, Input, InputNumber, Switch, Typography } from "antd";
import type { ReactElement } from "react";
import { dateValueFromEvent, dateValueProps, Select } from "../../shared/ui";
import type { OrderFormField } from "../../shared/api/types/forms";
import { useFieldConfig, useSectionLabels } from "./context";
import { isConditionActive, useConditionFieldValue } from "./rules";
import { requiredTextRules } from "../../shared/lib/validators";

const CUSTOM_SECTION_LABEL: Record<NonNullable<OrderFormField["section"]>, string> = {
  ACCOUNT_PRODUCT: "账号 / 产品补充信息",
  BUSINESS: "业务方案补充信息",
  DELIVER: "交付补充信息",
  OPERATION: "运营信息",
  FINANCE: "费用与资金补充信息",
  PARTICIPANT: "客户 / 供货方补充信息",
  EXTRA: "其他补充信息",
};

/** 渲染当前作用域（FieldConfigContext）下的自定义字段区块；无自定义字段时不渲染。
 *  值通过 CustomFormField 归集到 form_extra.<field_key>，随表单提交上报。 */
export function CustomFieldSection(props: { testIdSuffix?: string; section?: OrderFormField["section"] } = {}): ReactElement | null {
  const cfg = useFieldConfig();
  const sectionLabels = useSectionLabels();
  const defs = Object.values(cfg)
    .filter((field) => field.is_custom && field.is_active && (field.section ?? "EXTRA") === (props.section ?? "EXTRA"))
    .sort((a, b) => a.sort_order - b.sort_order);
  if (defs.length === 0) return null;
  return (
    <section className="ui-stack custom-field-section" data-testid={`custom-fields${props.testIdSuffix ? `-${props.testIdSuffix}` : ""}`}>
      <Typography.Text type="secondary" strong>{sectionLabels[props.section ?? "EXTRA"] ?? CUSTOM_SECTION_LABEL[props.section ?? "EXTRA"] ?? props.section}</Typography.Text>
      {defs.map((def) => (
        <CustomFormField key={def.id} def={def} />
      ))}
    </section>
  );
}

/** 在没有固定板块布局的表单中展示所有已配置的自定义字段。 */
export function CustomFieldSections({ testIdSuffix, excludeSections = [] }: { testIdSuffix?: string; excludeSections?: string[] }): ReactElement {
  const cfg = useFieldConfig();
  const sections = [...new Set(Object.values(cfg)
    .filter((field) => field.is_custom && field.is_active && !excludeSections.includes(field.section ?? "EXTRA"))
    .map((field) => field.section ?? "EXTRA"))];
  return <>{sections.map((section) => <CustomFieldSection key={section} section={section}
    testIdSuffix={testIdSuffix ? `${testIdSuffix}-${section.toLowerCase()}` : undefined} />)}</>;
}

/** 解析配置选项：后端只返回 {value,label} 对象。 */
export function resolveOptionItems(
  options: Array<{ value: string; label: string }> | null | undefined,
): Array<{ value: string; label: string }> {
  return (options ?? []).map((item) => {
    if (!item || typeof item !== "object" || typeof item.value !== "string" || typeof item.label !== "string") {
      throw new Error("选项必须使用 value/label 对象");
    }
    return item;
  });
}

/** 默认将值归集到 form_extra；flat 用于已有的平铺字段表单。 */
export function CustomFormField({ def, flat = false }: { def: OrderFormField; flat?: boolean }): ReactElement {
  const name = flat ? def.field_key : ["form_extra", def.field_key] as [string, string];
  const condField = def.required_when?.field;
  const depValue = useConditionFieldValue(condField);
  const required =
    def.required ||
    isConditionActive(def.required_when, condField ? { [condField]: depValue } : undefined);
  const baseRules = required ? [{ required: true, message: `${def.label}必填` }] : [];
  const rules = def.field_type === "TEXT" ? requiredTextRules(baseRules) : baseRules;
  const options = resolveOptionItems(def.options);
  switch (def.field_type) {
    case "NUMBER":
      return (
        <Form.Item name={name} label={def.label} rules={rules}>
          <InputNumber className="ui-control-full" />
        </Form.Item>
      );
    case "DATE":
      return (
        <Form.Item
          name={name}
          label={def.label}
          rules={rules}
          getValueFromEvent={dateValueFromEvent}
          getValueProps={dateValueProps}
        >
          <DatePicker className="ui-control-full" />
        </Form.Item>
      );
    case "BOOLEAN":
      return (
        <Form.Item name={name} label={def.label} valuePropName="checked" rules={rules}>
          <Switch />
        </Form.Item>
      );
    case "SELECT":
      return (
        <Form.Item name={name} label={def.label} rules={rules}>
          <Select options={options} allowClear />
        </Form.Item>
      );
    case "MULTI_SELECT":
      return (
        <Form.Item name={name} label={def.label} rules={rules}>
          <Select mode="multiple" options={options} allowClear />
        </Form.Item>
      );
    default:
      return (
        <Form.Item name={name} label={def.label} rules={rules}>
          <Input />
        </Form.Item>
      );
  }
}
