/** H5（≤640px）客户 / 合作方卡片列表。 */
import { Space } from "antd";
import type { ReactNode } from "react";
import { PermissionButton, StatusTag } from "../shared/ui";
import { COUNTERPARTY_TYPE_LABEL } from "../shared/lib/labels";
import { formatDateTimeMinute } from "../shared/lib/format";
import { orderMobileFields } from "../shared/lib/listColumns";
import type { Counterparty, Customer } from "../shared/api/catalog";

export function MobileCustomerList(props: {
  rows: Customer[];
  onDetail: (row: Customer) => void;
  onMerge: (row: Customer) => void;
  onDisable: (row: Customer) => void;
  /** 手机号脱敏时由父级注入「查看」入口，移动端不重复实现取数逻辑。 */
  renderPhone: (row: Customer) => ReactNode;
  fieldOrder?: string[];
}) {
  if (!props.rows.length) return <div className="customers-mobile-empty muted">暂无客户档案</div>;
  return (
    <div className="customers-mobile-list" aria-label="客户列表">
      {props.rows.map((row) => (
        <article className="customers-mobile-card" key={row.id}>
          <div className="customers-mobile-card__topline"><strong>{row.customer_no} · {row.display_name}</strong><StatusTag status={row.status} optionSet="CUSTOMER_STATUS" /></div>
          <dl>
            {orderMobileFields([
              { key: "display_name", label: "联系人", value: row.contact_name || row.display_name || "-" },
              { key: "phone", label: "手机", value: props.renderPhone(row) },
              { key: "created_at", label: "建立时间", value: formatDateTimeMinute(row.created_at) },
            ], props.fieldOrder).map((field) => <div key={field.key}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}
          </dl>
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
