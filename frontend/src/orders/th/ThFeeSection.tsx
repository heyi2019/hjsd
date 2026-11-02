import { Form } from "antd";
import type { Pool } from "../../shared/api/catalog";
import type { ReactNode } from "react";
import { BusinessRegistrationGroup, BusinessRegistrationSection, MoneyInput, Select } from "../../shared/ui";
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
    <BusinessRegistrationSection className="finance-section th-fees" title={financeTitle} description="填写账号价格、预计收款与实际发生的附加费用">
      <BusinessRegistrationGroup className="primary-amount-fields th-fee-primary">
          <CfgItem alwaysActive name="th_purchase_amount" label={fieldLabel(cfg, "th_purchase_amount", "账号号价")} rules={[{ required: true, message: "账号号价必填" }]}>
            <MoneyInput placeholder="请输入金额" />
          </CfgItem>
          <CfgItem alwaysActive name="payment_pool_id" fixedLabel="资金账户" rules={[{ required: true, message: "请选择资金账户" }]}>
            <Select placeholder="请选择资金账户" options={props.pools.map((pool) => ({ value: pool.id, label: pool.name }))} />
          </CfgItem>
          <CfgItem alwaysActive name="th_receive_amount" label={fieldLabel(cfg, "th_receive_amount", "预计收买家")} rules={[{ required: true, message: "请输入预计收买家金额" }]}>
            <MoneyInput placeholder="请输入金额" />
          </CfgItem>
      </BusinessRegistrationGroup>
      <AdditionalFeeFields pools={props.pools} />
      {props.financeExtras}
      <div className="finance-total">
        <span>总成本（含全部附加费用）</span>
        <strong>¥ {totalCost.toFixed(2)}</strong>
      </div>
    </BusinessRegistrationSection>
  );
}
