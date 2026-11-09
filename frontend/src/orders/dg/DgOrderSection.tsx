import { Form, Input } from "antd";
import { CustomFieldSection } from "../ConfigurableField";
import type { Customer, EmployeeOption, GameTypeOption } from "../../shared/api/catalog";
import { RecoveryAccountSection } from "../recovery/RecoveryAccountSection";
import { CfgItem, CfgNestedItem, sectionLabel } from "../ConfigurableField";
import { CustomerSourceFields } from "../CustomerSourceInput";
import { PartyMasterSelect } from "../PartyMasterSelect";
import { BusinessRegistrationGroup, BusinessRegistrationSection } from "../../shared/ui";
import "./DgOrderSection.css";

/** 代挂前端表单：沿用统一出售事实登记，订单创建阶段只登记寄售账号与委托客户。 */
export function DgOrderSection(props: {
  customers?: Customer[];
  onCreateCustomer?: () => void;
  gameTypes?: GameTypeOption[];
  employees?: EmployeeOption[];
}) {
  const form = Form.useFormInstance();
  const participantTitle = sectionLabel("PARTICIPANT", "委托客户");
  const customerOptions = (props.customers ?? [])
    .filter((item) => item.status === "ACTIVE")
    .map((item) => ({ value: item.id, label: `${item.customer_no} · ${item.display_name}` }));
  return (
    <>
      <RecoveryAccountSection gameTypes={props.gameTypes} employees={props.employees} businessResponsibleLabel="代挂负责人" accountExtras={<CustomFieldSection section="ACCOUNT_PRODUCT" testIdSuffix="account" />}>
        <CustomFieldSection section="BUSINESS" testIdSuffix="business" />
        <CustomFieldSection section="DELIVER" testIdSuffix="deliver" />
      </RecoveryAccountSection>

      <BusinessRegistrationSection className="dg-customer-section" title={participantTitle}>
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
              const customer = (props.customers ?? []).find((item) => item.id === Number(value));
              if (!customer) return;
              form.setFieldsValue({
                customer_id: customer.id,
                customer_lookup: undefined,
                dg_customer_source: customer.source ?? undefined,
                dg_customer_source_other: undefined,
                dg_customer_contact: customer.contact_name ?? undefined,
                dg_customer_phone: customer.phone ?? undefined,
                dg_customer_wechat: customer.wechat ?? undefined,
                dg_customer_qq: customer.qq ?? undefined,
                dg_note: customer.note ?? undefined,
              });
            }}
          />
        </CfgItem>
        <Form.Item name="customer_lookup" hidden><Input /></Form.Item>
        <CustomerSourceFields name="dg_customer_source" otherName="dg_customer_source_other" />
        <BusinessRegistrationGroup className="customer-contacts" title="联系方式">
          <CfgNestedItem name="dg_customer_contact" label="姓名"><Input placeholder="可选填" /></CfgNestedItem>
          <CfgNestedItem name="dg_customer_phone" label="手机号"><Input placeholder="可选填" /></CfgNestedItem>
          <CfgNestedItem name="dg_customer_wechat" label="微信号"><Input placeholder="可选填" /></CfgNestedItem>
          <CfgNestedItem name="dg_customer_qq" label="QQ"><Input placeholder="可选填" /></CfgNestedItem>
        </BusinessRegistrationGroup>
        <CfgItem className="consignment-note" name="dg_note" label="代挂备注">
          <Input placeholder="可选填" />
        </CfgItem>
        <CustomFieldSection section="PARTICIPANT" testIdSuffix="participant" />
      </BusinessRegistrationSection>
    </>
  );
}
