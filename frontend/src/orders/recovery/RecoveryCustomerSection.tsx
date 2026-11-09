import { Form, Input } from "antd";
import type { Customer } from "../../shared/api/catalog";
import { CfgItem, CfgNestedItem, sectionLabel } from "../ConfigurableField";
import { CustomerSourceFields } from "../CustomerSourceInput";
import { PartyMasterSelect } from "../PartyMasterSelect";
import type { ReactNode } from "react";
import { BusinessRegistrationGroup, BusinessRegistrationSection } from "../../shared/ui";
import "./RecoveryCustomerSection.css";

export function RecoveryCustomerSection(props: {
  customers?: Customer[];
  onCreateCustomer?: () => void;
  customerExtras?: ReactNode;
  title?: string;
  /** 售出库存时允许直接录入新客户昵称；建单场景支持主数据联想或直接录入新名称。 */
  customerInputMode?: "master" | "nickname";
} = {}) {
  const form = Form.useFormInstance();
  const configuredTitle = sectionLabel("PARTICIPANT", "客户信息");
  const title = props.title ?? configuredTitle;
  const customerInputMode = props.customerInputMode ?? "master";
  const customerOptions = (props.customers ?? [])
    .filter((item) => item.status === "ACTIVE")
    .map((item) => ({ value: item.id, label: `${item.customer_no} · ${item.display_name}` }));
  return (
    <BusinessRegistrationSection className="customer-section" title={title}>
      {customerInputMode === "nickname" ? (
        <CfgItem name="customer_nickname" label="客户昵称" fixedLabel="客户昵称" rules={[{ required: true, whitespace: true, message: "请输入客户昵称" }]}>
          <Input placeholder="请输入客户昵称" />
        </CfgItem>
      ) : (
        <CfgItem
          name="customer_id"
          label="客户"
          fixedLabel="客户"
          alwaysActive
          rules={[{ validator: async (_rule, value) => {
            if (Number(value) > 0 || String(form.getFieldValue("customer_lookup") ?? "").trim()) return;
            throw new Error("请输入客户名称或选择已有客户");
          } }]}
        >
          <PartyMasterSelect
            options={customerOptions}
            placeholder="输入客户名称，或选择已有客户"
            createLabel="新建客户"
            emptyText="暂无客户，可直接新建"
            onCreate={props.onCreateCustomer ?? (() => undefined)}
            onSearch={(value) => {
              if (!value.trim()) return;
              form.setFieldValue("customer_lookup", value);
              if (form.getFieldValue("customer_id") != null) form.setFieldValue("customer_id", undefined);
            }}
            onClear={() => form.setFieldsValue({ customer_id: undefined, customer_lookup: undefined })}
            onChange={(value) => {
              const customer = customerOptions.length
                ? (props.customers ?? []).find((item) => item.id === Number(value))
                : undefined;
              if (!customer) return;
              form.setFieldsValue({
                customer_id: customer.id,
                customer_lookup: undefined,
                customer_source: customer.source ?? undefined,
                customer_source_other: undefined,
                customer_contact_name: customer.contact_name ?? undefined,
                customer_phone: customer.phone ?? undefined,
                customer_wechat: customer.wechat ?? undefined,
                customer_qq: customer.qq ?? undefined,
                note: customer.note ?? undefined,
              });
            }}
          />
        </CfgItem>
      )}
      <Form.Item name="customer_lookup" hidden><Input /></Form.Item>
      <CustomerSourceFields name="customer_source" otherName="customer_source_other" />
      <BusinessRegistrationGroup className="customer-contacts" title="联系方式">
        <CfgNestedItem name="customer_contact_name" label="姓名"><Input placeholder="可选填" /></CfgNestedItem>
        <CfgNestedItem name="customer_phone" label="手机号"><Input placeholder="可选填" /></CfgNestedItem>
        <CfgNestedItem name="customer_wechat" label="微信号"><Input placeholder="可选填" /></CfgNestedItem>
        <CfgNestedItem name="customer_qq" label="QQ"><Input placeholder="可选填" /></CfgNestedItem>
      </BusinessRegistrationGroup>
      <CfgItem className="customer-note" name="note" label="客户备注">
        <Input placeholder="可选填" />
      </CfgItem>
      {props.customerExtras}
    </BusinessRegistrationSection>
  );
}
