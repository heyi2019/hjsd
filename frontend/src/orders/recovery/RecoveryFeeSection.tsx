import { CfgItem } from "../ConfigurableField";
import type { Pool } from "../../shared/api/catalog";
import { MoneyInput } from "../../shared/ui";
import { AdditionalFeeFields } from "../AdditionalFeeFields";
import { RecoveryPaymentSection } from "./RecoveryPaymentSection";
import "./RecoveryFeeSection.css";

export function RecoveryFeeSection(props: {
  totalRecoveryCost: number;
  pools: Pool[];
}) {
  return (
    <section className="recovery-fee-section recovery-fees" aria-labelledby="recovery-fees-title">
      <div className="recovery-fees__heading">
        <div>
          <div id="recovery-fees-title" className="recovery-fees__title">费用明细</div>
          <div className="recovery-fees__hint">只填写实际发生的费用，系统自动汇总成本</div>
        </div>
        <span className="recovery-fees__required">必填：回收价</span>
      </div>
      <div className="primary-amount-section recovery-fee-card recovery-fee-card--primary">
        <div className="recovery-fee-card__label">账号号价</div>
        <div className="recovery-fee-card__desc">实际支付给卖家的账号基础价格，不含附加费用</div>
        <CfgItem name="recovery_price" hideLabel rules={[{ required: true, message: "回收价必填" }]}>
          <MoneyInput placeholder="请输入金额" />
        </CfgItem>
      </div>
      <AdditionalFeeFields />
      <RecoveryPaymentSection pools={props.pools} />
      <div className="recovery-fees__total"><span>付款金额（含全部附加费用）</span><strong>¥ {props.totalRecoveryCost.toFixed(2)}</strong></div>
    </section>
  );
}
