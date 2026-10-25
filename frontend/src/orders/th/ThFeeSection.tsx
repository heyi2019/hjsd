import { Form } from "antd";
import type { Pool } from "../../shared/api/catalog";
import { MoneyInput } from "../../shared/ui";
import { CfgItem } from "../ConfigurableField";
import { AdditionalFeeFields } from "../AdditionalFeeFields";
import { PaymentInfoSection } from "../PaymentInfoSection";
import "../recovery/RecoveryFeeSection.css";
import "./ThFeeSection.css";

/** 提号沿用回收页费用明细，仅将付款对象切换为供货方。 */
export function ThFeeSection(props: { pools: Pool[] }) {
  const purchaseAmount = Form.useWatch("th_purchase_amount");
  const intermediaryFee = Form.useWatch("intermediary_fee");
  const otherFeeAmount = Form.useWatch("other_fee_amount");
  const totalCost = [purchaseAmount, intermediaryFee, otherFeeAmount]
    .reduce((total, value) => total + (Number(value) || 0), 0);

  return (
    <section className="recovery-fee-section recovery-fees th-fees" aria-labelledby="th-fees-title">
      <div className="recovery-fees__heading">
        <div>
          <div id="th-fees-title" className="recovery-fees__title">费用明细</div>
          <div className="recovery-fees__hint">只填写实际发生的费用，系统自动汇总付款金额</div>
        </div>
        <span className="recovery-fees__required">必填：账号号价</span>
      </div>
      <div className="recovery-fee-card recovery-fee-card--primary th-fee-primary">
        <div className="recovery-fee-card__label">账号号价</div>
        <CfgItem className="th-fee-primary__purchase" name="th_purchase_amount" hideLabel rules={[{ required: true, message: "账号号价必填" }]}>
          <MoneyInput placeholder="请输入金额" />
        </CfgItem>
        <div className="recovery-fee-card__label">预计收买家</div>
        <CfgItem className="th-fee-primary__expected" name="th_receive_amount" hideLabel rules={[{ required: true, message: "请输入预计收买家金额" }]}>
          <MoneyInput placeholder="请输入金额" />
        </CfgItem>
        <div className="recovery-fee-card__desc">实际支付给供货方的账号基础价格，不含附加费用</div>
      </div>
      <AdditionalFeeFields />
      <PaymentInfoSection pools={props.pools} recipientDefault="供货方" recipientPlaceholder="供货方" />
      <div className="recovery-fees__total">
        <span>总成本（含全部附加费用）</span>
        <strong>¥ {totalCost.toFixed(2)}</strong>
      </div>
    </section>
  );
}
