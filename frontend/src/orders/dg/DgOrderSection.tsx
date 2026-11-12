import { Input } from "antd";
import { CustomFieldSection } from "../ConfigurableField";
import type { EmployeeOption, GameTypeOption } from "../../shared/api/types/org";
import { RecoveryAccountSection } from "../recovery/RecoveryAccountSection";
import { CfgItem, CfgNestedItem, sectionLabel } from "../ConfigurableField";
import { CustomerSourceFields } from "../CustomerSourceInput";
import { BusinessRegistrationGroup, BusinessRegistrationSection } from "../../shared/ui";

/** 代挂前端表单：沿用统一出售事实登记，订单创建阶段只登记寄售账号与委托客户。 */
export function DgOrderSection(props: { gameTypes?: GameTypeOption[]; employees?: EmployeeOption[] }) {
  const participantTitle = sectionLabel("PARTICIPANT", "委托客户");
  return (
    <>
      <RecoveryAccountSection gameTypes={props.gameTypes} employees={props.employees} businessResponsibleLabel="代挂负责人" accountExtras={<CustomFieldSection section="ACCOUNT_PRODUCT" testIdSuffix="account" />}>
        <CustomFieldSection section="BUSINESS" testIdSuffix="business" />
        <CustomFieldSection section="DELIVER" testIdSuffix="deliver" />
      </RecoveryAccountSection>

      <BusinessRegistrationSection className="dg-customer-section" title={participantTitle}>
        <CfgItem name="dg_customer_nickname" label="客户昵称" rules={[{ required: true, message: "客户昵称必填" }]}><Input placeholder="请输入客户昵称" /></CfgItem>
        <CustomerSourceFields name="dg_customer_source" otherName="dg_customer_source_other" />
        <BusinessRegistrationGroup className="customer-contacts" title="联系方式">
          <CfgNestedItem name="dg_customer_contact" label="姓名"><Input placeholder="可选填" /></CfgNestedItem>
          <CfgNestedItem name="dg_customer_phone" label="手机号"><Input placeholder="可选填" /></CfgNestedItem>
          <CfgNestedItem name="dg_customer_wechat" label="微信号"><Input placeholder="可选填" /></CfgNestedItem>
          <CfgNestedItem name="dg_customer_qq" label="QQ"><Input placeholder="可选填" /></CfgNestedItem>
        </BusinessRegistrationGroup>
        <CfgItem className="customer-note" name="dg_note" label="代挂备注">
          <Input.TextArea rows={2} placeholder="可选填" />
        </CfgItem>
        <CustomFieldSection section="PARTICIPANT" testIdSuffix="participant" />
      </BusinessRegistrationSection>
    </>
  );
}
