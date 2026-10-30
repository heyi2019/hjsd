import { CfgItem, useFieldConfig, fieldLabel } from "../ConfigurableField";
import type { ReactNode } from "react";
import type { Pool } from "../../shared/api/catalog";
import { MoneyInput, Select } from "../../shared/ui";
import { AdditionalFeeFields } from "../AdditionalFeeFields";
import "./RecoveryFeeSection.css";

export function RecoveryFeeSection(props: {
  totalRecoveryCost: number;
  pools: Pool[];
  financeExtras?: ReactNode;
}) {
  const cfg = useFieldConfig();
  return (
    <section className="recovery-fee-section recovery-fees" aria-labelledby="recovery-fees-title">
      <div className="recovery-fees__heading">
        <div>
          <div id="recovery-fees-title" className="recovery-fees__title">资金明细</div>
          <div className="recovery-fees__hint">填写账号价格与实际发生的附加费用</div>
        </div>
      </div>
      <div className="primary-amount-section recovery-fee-card recovery-fee-card--primary">
        <div className="recovery-fee-card__label"><span className="form-field__required-mark" aria-hidden="true">*</span>{fieldLabel(cfg, "recovery_price", "账号号价")}</div>
        <CfgItem className="primary-amount-section__price" name="recovery_price" hideLabel rules={[{ required: true, message: "回收价必填" }]}>
          <MoneyInput placeholder="请输入金额" />
        </CfgItem>
        <CfgItem className="primary-amount-section__pool" name="payment_pool_id" fixedLabel="支出账户" rules={[{ required: true, message: "请选择支出账户" }]}>
          <Select placeholder="请选择支出账户" options={props.pools.map((pool) => ({ value: pool.id, label: pool.name }))} />
        </CfgItem>
      </div>
      <AdditionalFeeFields pools={props.pools} />
      {props.financeExtras}
      <div className="recovery-fees__total"><span>付款金额（含全部附加费用）</span><strong>¥ {props.totalRecoveryCost.toFixed(2)}</strong></div>
    </section>
  );
}
