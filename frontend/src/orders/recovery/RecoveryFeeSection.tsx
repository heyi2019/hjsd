import { CfgItem, useFieldConfig, fieldLabel, sectionLabel } from "../ConfigurableField";
import type { ReactNode } from "react";
import type { Pool } from "../../shared/api/catalog";
import { BusinessRegistrationGroup, BusinessRegistrationSection, MoneyInput, Select } from "../../shared/ui";
import { AdditionalFeeFields } from "../AdditionalFeeFields";
import "./RecoveryFeeSection.css";

export function RecoveryFeeSection(props: {
  totalRecoveryCost: number;
  pools: Pool[];
  financeExtras?: ReactNode;
}) {
  const cfg = useFieldConfig();
  const financeTitle = sectionLabel("FINANCE", "资金明细");
  return (
    <BusinessRegistrationSection className="finance-section" title={financeTitle} description="填写账号价格与实际发生的附加费用">
      <BusinessRegistrationGroup className="primary-amount-fields">
        <CfgItem name="recovery_price" label={fieldLabel(cfg, "recovery_price", "账号号价")} rules={[{ required: true, message: "回收价必填" }]}>
          <MoneyInput placeholder="请输入金额" />
        </CfgItem>
        <CfgItem name="payment_pool_id" fixedLabel="资金账户" rules={[{ required: true, message: "请选择资金账户" }]}>
          <Select placeholder="请选择资金账户" options={props.pools.map((pool) => ({ value: pool.id, label: pool.name }))} />
        </CfgItem>
      </BusinessRegistrationGroup>
      <AdditionalFeeFields pools={props.pools} />
      {props.financeExtras}
      <div className="finance-total"><span>付款金额（含全部附加费用）</span><strong>¥ {props.totalRecoveryCost.toFixed(2)}</strong></div>
    </BusinessRegistrationSection>
  );
}
