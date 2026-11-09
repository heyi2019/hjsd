import { Input } from "antd";
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
        <CfgItem name="customer_id" label="客户" fixedLabel="客户" alwaysActive rules={[{ required: true, message: "请选择客户" }]}>
          <PartyMasterSelect
            options={customerOptions}
            placeholder="请选择客户主数据"
            createLabel="新建客户"
            emptyText="暂无客户，可直接新建"
            onCreate={props.onCreateCustomer ?? (() => undefined)}
          />
        </CfgItem>
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
