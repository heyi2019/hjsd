import { Input } from "antd";
import { CustomFieldSection } from "../ConfigurableField";
import type { GameTypeOption } from "../../shared/api/catalog";
import { RecoveryAccountSection } from "../recovery/RecoveryAccountSection";
import { CfgItem, CfgNestedItem } from "../ConfigurableField";

/** 代挂前端表单：沿用统一出售事实登记，订单创建阶段只登记寄售账号与委托客户。 */
export function DgOrderSection(props: { gameTypes?: GameTypeOption[] }) {
  return (
    <>
      <RecoveryAccountSection gameTypes={props.gameTypes} accountExtras={<CustomFieldSection section="ACCOUNT_PRODUCT" testIdSuffix="account" />} />

      <CustomFieldSection section="BUSINESS" testIdSuffix="business" />

      <section className="dg-customer-section recovery-customer-fields" aria-labelledby="dg-customer-info-title">
        <div id="dg-customer-info-title" className="recovery-customer-fields__title">委托客户</div>
        <CfgItem className="recovery-order-modal__party-field" name="dg_customer_nickname" label="客户昵称" rules={[{ required: true, message: "客户昵称必填" }]}><Input placeholder="请输入客户昵称" /></CfgItem>
        <CfgItem className="recovery-order-modal__party-field" name="dg_customer_source" label="客户来源"><Input placeholder="可选填，如：转介绍 / 抖音 / 老客户" /></CfgItem>
        <div className="recovery-customer-contacts">
          <div className="recovery-customer-contacts__title">联系方式</div>
          <CfgNestedItem className="recovery-fee-field" name="dg_customer_contact" label="姓名"><Input className="recovery-fee-control" placeholder="可选填" /></CfgNestedItem>
          <CfgNestedItem className="recovery-fee-field" name="dg_customer_phone" label="手机号"><Input className="recovery-fee-control" placeholder="可选填" /></CfgNestedItem>
          <CfgNestedItem className="recovery-fee-field" name="dg_customer_wechat" label="微信号"><Input className="recovery-fee-control" placeholder="可选填" /></CfgNestedItem>
          <CfgNestedItem className="recovery-fee-field" name="dg_customer_qq" label="QQ"><Input className="recovery-fee-control" placeholder="可选填" /></CfgNestedItem>
        </div>
        <CfgItem className="recovery-order-modal__note-field" name="dg_note" label="代挂备注">
          <Input.TextArea rows={2} placeholder="可选填" />
        </CfgItem>
        <CustomFieldSection section="PARTICIPANT" testIdSuffix="participant" />
      </section>
    </>
  );
}
