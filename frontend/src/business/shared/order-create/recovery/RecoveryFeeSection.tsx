import { CfgItem, useFieldConfig, fieldLabel, sectionLabel } from "../../../ConfigurableField";
import type { Pool } from "../../../../shared/api/types/finance";
import type { ReactNode } from "react";
import { PurchaseFinanceSection } from "../finance/PurchaseFinanceSection";

export function RecoveryFeeSection(props: {
  pools: Pool[];
  financeExtras?: ReactNode;
}) {
  return (
    <PurchaseFinanceSection
      amountName="recovery_price"
      amountLabel="回收金额"
      requiredMessage="回收金额必填"
      description="填写回收金额与实际发生的支出明细"
      pools={props.pools}
      financeExtras={props.financeExtras}
    />
  );
}
