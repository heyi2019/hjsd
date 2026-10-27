import { Input } from "antd";
import { CfgItem, CfgNestedItem } from "../ConfigurableField";
import "./RecoveryCustomerSection.css";

export function RecoveryCustomerSection() {
  return (
    <section className="recovery-customer-section recovery-customer-fields" aria-labelledby="customer-info-title">
      <div id="customer-info-title" className="recovery-customer-fields__title">客户信息</div>
      <CfgItem className="recovery-order-modal__party-field" name="customer_nickname" label="客户昵称" rules={[{ required: true, message: "请输入客户昵称" }]}><Input placeholder="请输入客户昵称" /></CfgItem>
      <CfgItem className="recovery-order-modal__party-field" name="customer_source" label="客户来源">
        <Input placeholder="可选填，如：转介绍 / 抖音 / 老客户" />
      </CfgItem>
      <div className="recovery-customer-contacts">
        <div className="recovery-customer-contacts__title">联系方式</div>
        <CfgNestedItem className="recovery-fee-field" name="customer_contact_name" label="姓名"><Input className="recovery-fee-control" placeholder="可选填" /></CfgNestedItem>
        <CfgNestedItem className="recovery-fee-field" name="customer_phone" label="手机号"><Input className="recovery-fee-control" placeholder="可选填" /></CfgNestedItem>
        <CfgNestedItem className="recovery-fee-field" name="customer_wechat" label="微信号"><Input className="recovery-fee-control" placeholder="可选填" /></CfgNestedItem>
        <CfgNestedItem className="recovery-fee-field" name="customer_qq" label="QQ"><Input className="recovery-fee-control" placeholder="可选填" /></CfgNestedItem>
      </div>
      <CfgItem className="recovery-order-modal__note-field" name="note" label="客户备注">
        <Input.TextArea rows={2} placeholder="可填写账号来源、特殊说明等" />
      </CfgItem>
    </section>
  );
}
