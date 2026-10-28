import { Form, Input } from "antd";
import { CustomFieldSection } from "../ConfigurableField";
import type { GameTypeOption } from "../../shared/api/catalog";
import { Select } from "../../shared/ui";
import { useOptionSet } from "../../shared/lib/optionSets";
import { RecoveryAccountSection } from "../recovery/RecoveryAccountSection";
import { CfgItem, CfgNestedItem } from "../ConfigurableField";
import "./DgOrderSection.css";

/** 佣金口径兜底文案：词典 COMMISSION_MODE / COMMISSION_PAYER 未加载时回落。
 *  取值与后端 CommissionMode / CommissionPayer 枚举一致。 */
const COMMISSION_MODE_LABEL: Record<string, string> = {
  DEDUCT_FROM_SETTLEMENT: "结算扣减",
  SEPARATE_PAYMENT: "单独支付",
};
const COMMISSION_PAYER_LABEL: Record<string, string> = {
  BUYER: "买方",
  CONSIGNOR: "寄售方",
  PLATFORM: "平台",
};

function toOptions(dict: Record<string, string>) {
  return Object.entries(dict).map(([value, label]) => ({ value, label }));
}

/** 代挂前端表单：沿用统一出售事实登记，订单创建阶段只登记寄售账号与委托客户。 */
export function DgOrderSection(props: { gameTypes?: GameTypeOption[] }) {
  const commissionModeOptions = useOptionSet("COMMISSION_MODE") ?? toOptions(COMMISSION_MODE_LABEL);
  const commissionPayerOptions = useOptionSet("COMMISSION_PAYER") ?? toOptions(COMMISSION_PAYER_LABEL);
  return (
    <>
      <RecoveryAccountSection gameTypes={props.gameTypes} accountExtras={<CustomFieldSection section="ACCOUNT_PRODUCT" testIdSuffix="account" />} />

      {/* 佣金口径写入 orders.commission_mode / commission_payer（结构化列，非 form_extra）：
          后端要求两者成对出现，这里只做前端提示，最终校验仍由服务端负责。 */}
      <section className="dg-commission-section" aria-labelledby="dg-commission-title">
        <div id="dg-commission-title" className="recovery-customer-fields__title">佣金口径</div>
        <Form.Item
          name="commission_mode"
          label="佣金支付方式"
          dependencies={["commission_payer"]}
          rules={[
            ({ getFieldValue }) => ({
              validator(_rule, value) {
                const payer = getFieldValue("commission_payer");
                if (Boolean(value) !== Boolean(payer)) {
                  return Promise.reject(new Error("佣金支付方式与佣金承担方必须同时选择或同时留空"));
                }
                return Promise.resolve();
              },
            }),
          ]}
        >
          <Select allowClear placeholder="可选，需与承担方成对选择" options={commissionModeOptions} />
        </Form.Item>
        <Form.Item name="commission_payer" label="佣金承担方" dependencies={["commission_mode"]}>
          <Select allowClear placeholder="可选，需与支付方式成对选择" options={commissionPayerOptions} />
        </Form.Item>
        <CustomFieldSection section="BUSINESS" testIdSuffix="business" />
      </section>

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
