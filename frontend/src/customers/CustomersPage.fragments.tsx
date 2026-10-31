import { DatePicker, Input, InputNumber, Select, Space, Switch } from "antd";
import type { ReactNode } from "react";
import { PermissionButton, StatusTag } from "../shared/ui";
import { COUNTERPARTY_TYPE_LABEL } from "../shared/lib/labels";
import type { Counterparty, Customer, OrderFormField } from "../shared/api/catalog";

/** 订单客户角色兜底文案：词典 ORDER_CUSTOMER_ROLE 未加载/未配置时兜底。
 *  取值与后端 order_customer_roles.role 一致。 */
export const CUSTOMER_ROLE_LABEL: Record<string, string> = {
  SELLER: "卖方",
  BUYER: "买方",
  CONSIGNOR: "寄售方",
  INSTALLMENT_CUSTOMER: "分期客户",
};

export function customerDateKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function MobileCustomerList(props: {
  rows: Customer[];
  onDetail: (row: Customer) => void;
  onMerge: (row: Customer) => void;
  onDisable: (row: Customer) => void;
  /** 手机号脱敏时由父级注入「查看」入口，移动端不重复实现取数逻辑。 */
  renderPhone: (row: Customer) => ReactNode;
}) {
  if (!props.rows.length) return <div className="customers-mobile-empty muted">暂无客户档案</div>;
  return (
    <div className="customers-mobile-list" aria-label="客户列表">
      {props.rows.map((row) => (
        <article className="customers-mobile-card" key={row.id}>
          <div className="customers-mobile-card__topline"><strong>{row.customer_no} · {row.display_name}</strong><StatusTag status={row.status} optionSet="CUSTOMER_STATUS" /></div>
          <dl><div><dt>联系人</dt><dd>{row.contact_name || "-"}</dd></div><div><dt>手机</dt><dd>{props.renderPhone(row)}</dd></div></dl>
          <Space size="small">
            <PermissionButton permission="customer.read" size="small" onClick={() => props.onDetail(row)}>详情</PermissionButton>
            <PermissionButton permission="customer.merge" size="small" disabled={row.status !== "ACTIVE"} onClick={() => props.onMerge(row)}>合并</PermissionButton>
            <PermissionButton permission="customer.update" size="small" onClick={() => props.onDisable(row)}>{row.status === "ACTIVE" ? "拉黑" : "解除拉黑"}</PermissionButton>
          </Space>
        </article>
      ))}
    </div>
  );
}

export function MobileCounterpartyList(props: {
  rows: Counterparty[];
  onDetail: (row: Counterparty) => void;
  onEdit: (row: Counterparty) => void;
  onToggle: (row: Counterparty) => void;
}) {
  if (!props.rows.length) return <div className="customers-mobile-empty muted">暂无合作方</div>;
  return (
    <div className="customers-mobile-list" aria-label="合作方列表">
      {props.rows.map((row) => (
        <article className="customers-mobile-card" key={row.id}>
          <div className="customers-mobile-card__topline"><strong>{row.counterparty_no} · {row.display_name}</strong><StatusTag status={row.status} optionSet="COUNTERPARTY_STATUS" /></div>
          <dl><div><dt>类型</dt><dd>{COUNTERPARTY_TYPE_LABEL[row.type] ?? row.type}</dd></div><div><dt>联系人</dt><dd>{row.contact_name || "-"}</dd></div></dl>
          <Space size="small">
            <PermissionButton permission="counterparty.read" size="small" onClick={() => props.onDetail(row)}>详情</PermissionButton>
            <PermissionButton permission="counterparty.manage" size="small" disabled={row.status !== "ACTIVE"} onClick={() => props.onEdit(row)}>编辑</PermissionButton>
            <PermissionButton permission="counterparty.manage" size="small" onClick={() => props.onToggle(row)}>{row.status === "ACTIVE" ? "拉黑" : "解除拉黑"}</PermissionButton>
          </Space>
        </article>
      ))}
    </div>
  );
}

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
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const def of defs) {
    const raw = values[def.field_key];
    if (raw === undefined || raw === null || raw === "") continue;
    if (Array.isArray(raw) && raw.length === 0) continue;
    out[def.field_key] = def.field_type === "DATE" ? toDateText(raw) : raw;
  }
  return out;
}

/** 按字段类型渲染表单控件（BAS-04：类型由字段定义决定）。
 *  必须透传 Form.Item 注入的 id / value / onChange：包装组件若吞掉这些 props，
 *  标签的 htmlFor 会指向不存在的 id（a11y 断链），且表单值收集为空。 */
export function ExtraFieldControl({ def, ...controlProps }: { def: OrderFormField; [key: string]: unknown }) {
  // 选项兼容纯字符串数组与 {value,label} 对象数组
  const options = (def.options ?? []).map((option) =>
    typeof option === "string"
      ? { value: option, label: option }
      : { value: option.value, label: option.label || option.value },
  );
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

