import { Form } from "antd";
import type { Pool } from "../../shared/api/catalog";
import type { ReactNode } from "react";
import { sumMoney } from "../../shared/lib/money";
import { BusinessRegistrationSection, MoneyInput, Select } from "../../shared/ui";
import { CfgItem, useFieldConfig, fieldLabel, sectionLabel } from "../ConfigurableField";
import { ExpenseDetails } from "../ExpenseDetails";
import "../recovery/RecoveryFeeSection.css";
import "./ThFeeSection.css";

/** 提号沿用回收页费用明细。 */
export function ThFeeSection(props: { pools: Pool[]; financeExtras?: ReactNode }) {
  const cfg = useFieldConfig();
  const financeTitle = sectionLabel("FINANCE", "资金明细");
  const purchaseAmount = Form.useWatch("th_purchase_amount");
  const expenseItems = Form.useWatch("expense_items") as Array<{ amount?: number }> | undefined;
  // 与回收页同一套口径：输入期本地换算成分相加，只用于即时展示。
  const totalCost = sumMoney([purchaseAmount, ...(expenseItems ?? []).map((item) => item.amount)]);

  return (
    <BusinessRegistrationSection className="finance-section th-fees" title={financeTitle} description="填写提号金额、预计收款与支出明细">
      <ExpenseDetails>
          <CfgItem alwaysActive name="th_purchase_amount" label={fieldLabel(cfg, "th_purchase_amount", "提号金额")} rules={[{ required: true, message: "提号金额必填" }]}>
            <MoneyInput placeholder="请输入金额" />
          </CfgItem>
          <CfgItem alwaysActive name="payment_pool_id" fixedLabel="资金账户" rules={[{ required: true, message: "请选择资金账户" }]}>
            <Select placeholder="请选择资金账户" options={props.pools.map((pool) => ({ value: pool.id, label: pool.name }))} />
          </CfgItem>
          <CfgItem alwaysActive name="th_receive_amount" label={fieldLabel(cfg, "th_receive_amount", "预计收买家")} rules={[{ required: true, message: "请输入预计收买家金额" }]}>
            <MoneyInput placeholder="请输入金额" />
          </CfgItem>
      </ExpenseDetails>
      {props.financeExtras}
      <div className="finance-total">
        <span>总成本（含支出明细）</span>
        <strong>¥ {totalCost}</strong>
      </div>
    </BusinessRegistrationSection>
  );
}
