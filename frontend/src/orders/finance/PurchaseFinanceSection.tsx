import { Form } from "antd";
import type { ReactNode } from "react";
import type { Pool } from "../../shared/api/types/finance";
import { sumMoney } from "../../shared/lib/money";
import { moneyRules } from "../../shared/lib/validators";
import { BusinessRegistrationSection, MoneyInput, Select } from "../../shared/ui";
import { CfgItem, fieldLabel, sectionLabel, useFieldConfig } from "../ConfigurableField";
import { FinancePrimaryCard } from "./FinancePrimaryCard";
import { FinanceTotal } from "./FinanceTotal";

/** 回收/提号共用的买入资金区：主金额、资金账户和可选支出只保留一套实现。 */
export function PurchaseFinanceSection(props: {
  amountName: string;
  amountLabel: string;
  requiredMessage: string;
  description: string;
  pools: Pool[];
  financeExtras?: ReactNode;
  alwaysActive?: boolean;
}) {
  const config = useFieldConfig();
  const amount = Form.useWatch(props.amountName);
  const expenseItems = Form.useWatch("expense_items") as Array<{ amount?: unknown }> | undefined;
  const totalCost = sumMoney([amount, ...(expenseItems ?? []).map((item) => item.amount)]);
  const resolvedAmountLabel = fieldLabel(config, props.amountName, props.amountLabel);

  return (
    <BusinessRegistrationSection title={sectionLabel("FINANCE", "资金明细")} description={props.description}>
      <FinancePrimaryCard>
        <CfgItem
          alwaysActive={props.alwaysActive}
          name={props.amountName}
          label={resolvedAmountLabel}
          rules={[{ required: true, message: props.requiredMessage }, ...moneyRules(resolvedAmountLabel)]}
        >
          <MoneyInput placeholder="请输入金额" />
        </CfgItem>
        <CfgItem alwaysActive fixedLabel="资金账户" name="payment_pool_id" rules={[{ required: true, message: "请选择资金账户" }]}>
          <Select placeholder="请选择资金账户" options={props.pools.map((pool) => ({ value: pool.id, label: pool.name }))} />
        </CfgItem>
      </FinancePrimaryCard>
      {props.financeExtras}
      <FinanceTotal amount={totalCost} />
    </BusinessRegistrationSection>
  );
}
