import { CfgItem, useFieldConfig, fieldLabel, sectionLabel } from "../ConfigurableField";
import type { ReactNode } from "react";
import type { Pool } from "../../shared/api/types/finance";
import { BusinessRegistrationSection, MoneyInput, Select } from "../../shared/ui";
import { FinancePrimaryCard } from "../finance/FinancePrimaryCard";
import { FinanceTotal } from "../finance/FinanceTotal";

export function RecoveryFeeSection(props: {
  /** 上游按「分」汇总后的 2 位小数字符串，此处只负责展示。 */
  totalRecoveryCost: string;
  pools: Pool[];
  financeExtras?: ReactNode;
}) {
  const cfg = useFieldConfig();
  const financeTitle = sectionLabel("FINANCE", "资金明细");
  return (
    <BusinessRegistrationSection title={financeTitle} description="填写回收金额与实际发生的支出明细">
      <FinancePrimaryCard>
        <CfgItem name="recovery_price" label={fieldLabel(cfg, "recovery_price", "回收金额")} rules={[{ required: true, message: "回收金额必填" }]}>
          <MoneyInput placeholder="请输入金额" />
        </CfgItem>
        <CfgItem name="payment_pool_id" fixedLabel="资金账户" rules={[{ required: true, message: "请选择资金账户" }]}>
          <Select placeholder="请选择资金账户" options={props.pools.map((pool) => ({ value: pool.id, label: pool.name }))} />
        </CfgItem>
      </FinancePrimaryCard>
      {props.financeExtras}
      <FinanceTotal amount={props.totalRecoveryCost} />
    </BusinessRegistrationSection>
  );
}
