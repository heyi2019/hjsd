import { Input } from "antd";
import type { ReactNode } from "react";
import { BusinessRegistrationGroup, BusinessRegistrationSection } from "../../../../shared/ui";
import { CfgItem, CfgNestedItem, sectionLabel } from "../../../ConfigurableField";

/** 提号复用回收页客户信息的结构，只将业务主体替换为供货方。 */
export function ThSupplierSection(props: { participantExtras?: ReactNode } = {}) {
  const participantTitle = sectionLabel("PARTICIPANT", "供货方信息");
  return (
    <BusinessRegistrationSection className="th-supplier-section" title={participantTitle}>
      <CfgItem name="supplier_nickname" label="供货方昵称">
        <Input placeholder="可选填" />
      </CfgItem>
      <BusinessRegistrationGroup className="supplier-contacts" title="联系方式">
        <CfgNestedItem name="supplier_contact_name" label="公司名"><Input placeholder="可选填" /></CfgNestedItem>
        <CfgNestedItem name="supplier_phone" label="手机号"><Input placeholder="可选填" /></CfgNestedItem>
        <CfgNestedItem name="supplier_wechat" label="微信号"><Input placeholder="可选填" /></CfgNestedItem>
        <CfgNestedItem name="supplier_qq" label="QQ"><Input placeholder="可选填" /></CfgNestedItem>
      </BusinessRegistrationGroup>
      <CfgItem className="business-registration-section__field--full" name="supplier_note" label="供货方备注">
        <Input placeholder="可选填" />
      </CfgItem>
      {props.participantExtras}
    </BusinessRegistrationSection>
  );
}
