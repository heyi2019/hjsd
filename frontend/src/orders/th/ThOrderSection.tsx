import type { Counterparty, EmployeeOption, GameTypeOption, Pool } from "../../shared/api/catalog";
import { RecoveryAccountSection } from "../recovery/RecoveryAccountSection";
import { ThFeeSection } from "./ThFeeSection";
import { ThSupplierSection } from "./ThSupplierSection";
import { CustomFieldSection } from "../ConfigurableField";

/** 提号复用回收页主结构：账号信息、费用明细、付款信息保持一致，仅登记合作伙伴。 */
export function ThOrderSection(props: {
  pools: Pool[];
  counterparties: Counterparty[];
  gameTypes?: GameTypeOption[];
  employees?: EmployeeOption[];
  onCreateSupplier?: () => void;
}) {
  return (
    <>
      <RecoveryAccountSection gameTypes={props.gameTypes} employees={props.employees} businessResponsibleLabel="提号负责人" showIntermediaryDelivery accountExtras={<CustomFieldSection section="ACCOUNT_PRODUCT" testIdSuffix="account" />}>
        <ThFeeSection pools={props.pools} financeExtras={<CustomFieldSection section="FINANCE" testIdSuffix="finance" />} />
      </RecoveryAccountSection>
      <ThSupplierSection
        counterparties={props.counterparties}
        onCreateSupplier={props.onCreateSupplier}
        participantExtras={<CustomFieldSection section="PARTICIPANT" testIdSuffix="participant" />}
      />
    </>
  );
}
