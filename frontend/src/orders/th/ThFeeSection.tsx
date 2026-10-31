import { Form } from "antd";
import type { Pool } from "../../shared/api/catalog";
import type { ReactNode } from "react";
import { MoneyInput, Select } from "../../shared/ui";
import { CfgItem, useFieldConfig, fieldLabel, sectionLabel } from "../ConfigurableField";
import { AdditionalFeeFields } from "../AdditionalFeeFields";
import "../recovery/RecoveryFeeSection.css";
import "./ThFeeSection.css";

/** 提号沿用回收页费用明细。 */
export function ThFeeSection(props: { pools: Pool[]; financeExtras?: ReactNode }) {
  const cfg = useFieldConfig();
  const financeTitle = sectionLabel("FINANCE", "资金明细");
  const purchaseAmount = Form.useWatch("th_purchase_amount");
  const intermediaryFee = Form.useWatch("intermediary_fee");
  const expenseItems = Form.useWatch("expense_items") as Array<{ amount?: number }> | undefined;
  const totalCost = [purchaseAmount, intermediaryFee, ...(expenseItems ?? []).map((item) => item.amount)]
    .reduce((total, value) => total + (Number(value) || 0), 0);

  return (
    <section className="recovery-fee-section recovery-fees th-fees" aria-labelledby="th-fees-title">
      <div className="recovery-fees__heading">
        <div>
          <div id="th-fees-title" className="recovery-fees__title">{financeTitle}</div>
          <div className="recovery-fees__hint">填写账号价格、预计收款与实际发生的附加费用</div>
        </div>
      </div>
      <div className="recovery-fee-card recovery-fee-card--primary th-fee-primary">
        <div className="th-fee-primary__field">
          <div className="recovery-fee-card__label"><span className="form-field__required-mark" aria-hidden="true">*</span>{fieldLabel(cfg, "th_purchase_amount", "账号号价")}</div>
          <CfgItem alwaysActive name="th_purchase_amount" hideLabel rules={[{ required: true, message: "账号号价必填" }]}>
            <MoneyInput placeholder="请输入金额" />
          </CfgItem>
        </div>
        <div className="th-fee-primary__field">
          <label className="recovery-fee-card__label" htmlFor="payment_pool_id"><span className="form-field__required-mark" aria-hidden="true">*</span>支出账户</label>
          <CfgItem alwaysActive name="payment_pool_id" hideLabel rules={[{ required: true, message: "请选择支出账户" }]}>
            <Select placeholder="请选择支出账户" options={props.pools.map((pool) => ({ value: pool.id, label: pool.name }))} />
          </CfgItem>
        </div>
        <div className="th-fee-primary__field">
          <div className="recovery-fee-card__label"><span className="form-field__required-mark" aria-hidden="true">*</span>{fieldLabel(cfg, "th_receive_amount", "预计收买家")}</div>
          <CfgItem alwaysActive name="th_receive_amount" hideLabel rules={[{ required: true, message: "请输入预计收买家金额" }]}>
            <MoneyInput placeholder="请输入金额" />
          </CfgItem>
        </div>
      </div>
      <AdditionalFeeFields pools={props.pools} />
      {props.financeExtras}
      <div className="recovery-fees__total">
        <span>总成本（含全部附加费用）</span>
        <strong>¥ {totalCost.toFixed(2)}</strong>
      </div>
    </section>
  );
}
