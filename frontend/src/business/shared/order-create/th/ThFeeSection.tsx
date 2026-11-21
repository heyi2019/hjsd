import type { Pool } from "../../../../shared/api/types/finance";
import type { ReactNode } from "react";
import { PurchaseFinanceSection } from "../finance/PurchaseFinanceSection";

/** 提号资金明细。 */
export function ThFeeSection(props: { pools: Pool[]; financeExtras?: ReactNode }) {
  return (
    <PurchaseFinanceSection
      amountName="th_purchase_amount"
      amountLabel="提号金额"
      requiredMessage="提号金额必填"
      description="填写提号金额与实际发生的支出明细"
      pools={props.pools}
      financeExtras={props.financeExtras}
      alwaysActive
    />
  );
}
