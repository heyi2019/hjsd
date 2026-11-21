import { Input } from "antd";
import { CfgItem, CfgNestedItem, sectionLabel } from "../ConfigurableField";
import { CustomerSourceFields } from "../CustomerSourceInput";
import type { ReactNode } from "react";
import { BusinessRegistrationGroup, BusinessRegistrationSection } from "../../shared/ui";

export function RecoveryCustomerSection(props: { customerExtras?: ReactNode; title?: string; customerOptional?: boolean } = {}) {
  const configuredTitle = sectionLabel("PARTICIPANT", "客户信息");
  const title = props.title ?? configuredTitle;
  return (
    <BusinessRegistrationSection className="customer-section" title={title}>
      <CfgItem name="customer_nickname" label="客户昵称" rules={props.customerOptional ? [] : [{ required: true, whitespace: true, message: "请输入客户昵称" }]}><Input placeholder="请输入客户昵称" /></CfgItem>
      <CustomerSourceFields name="customer_source" otherName="customer_source_other" />
      <BusinessRegistrationGroup className="customer-contacts" title="联系方式">
        <CfgNestedItem name="customer_contact_name" label="姓名"><Input placeholder="可选填" /></CfgNestedItem>
        <CfgNestedItem name="customer_phone" label="手机号"><Input placeholder="可选填" /></CfgNestedItem>
        <CfgNestedItem name="customer_wechat" label="微信号"><Input placeholder="可选填" /></CfgNestedItem>
        <CfgNestedItem name="customer_qq" label="QQ"><Input placeholder="可选填" /></CfgNestedItem>
      </BusinessRegistrationGroup>
      <CfgItem className="business-registration-section__field--full" name="note" label="客户备注">
        <Input placeholder="可选填" />
      </CfgItem>
      {props.customerExtras}
    </BusinessRegistrationSection>
  );
}
