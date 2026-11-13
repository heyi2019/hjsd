import { Form } from "antd";
import type { Pool } from "../../shared/api/types/finance";
import type { ReactNode } from "react";
import { sumMoney } from "../../shared/lib/money";
import { BusinessRegistrationSection, MoneyInput, Select } from "../../shared/ui";
import { CfgItem, useFieldConfig, fieldLabel, sectionLabel } from "../ConfigurableField";
import { FinancePrimaryCard } from "../finance/FinancePrimaryCard";
import { FinanceTotal } from "../finance/FinanceTotal";

/** 提号资金明细。 */
export function ThFeeSection(props: { pools: Pool[]; financeExtras?: ReactNode }) {
  const cfg = useFieldConfig();
  const financeTitle = sectionLabel("FINANCE", "资金明细");
  const purchaseAmount = Form.useWatch("th_purchase_amount");
  const expenseItems = Form.useWatch("expense_items") as Array<{ amount?: number }> | undefined;
  // 与回收页同一套口径：输入期本地换算成分相加，只用于即时展示。
  const totalCost = sumMoney([purchaseAmount, ...(expenseItems ?? []).map((item) => item.amount)]);

  return (
    <BusinessRegistrationSection title={financeTitle} description="填写提号金额与实际发生的支出明细">
      <FinancePrimaryCard>
        <CfgItem alwaysActive name="th_purchase_amount" label={fieldLabel(cfg, "th_purchase_amount", "提号金额")} rules={[{ required: true, message: "提号金额必填" }]}>
          <MoneyInput placeholder="请输入金额" />
        </CfgItem>
        <CfgItem alwaysActive name="payment_pool_id" fixedLabel="资金账户" rules={[{ required: true, message: "请选择资金账户" }]}>
          <Select placeholder="请选择资金账户" options={props.pools.map((pool) => ({ value: pool.id, label: pool.name }))} />
        </CfgItem>
      </FinancePrimaryCard>
      {props.financeExtras}
      <FinanceTotal amount={totalCost} />
    </BusinessRegistrationSection>
  );
}
