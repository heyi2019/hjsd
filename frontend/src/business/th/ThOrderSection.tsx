import type { Pool } from "../../shared/api/types/finance";
import type { EmployeeOption, GameTypeOption } from "../../shared/api/types/org";
import { RecoveryAccountSection } from "../recovery/RecoveryAccountSection";
import { ThFeeSection } from "./ThFeeSection";
import { ThSupplierSection } from "./ThSupplierSection";
import { CustomFieldSection } from "../ConfigurableField";

/** 提号复用回收页主结构：账号信息、费用明细、付款信息保持一致，仅客户区替换为供货方区。 */
export function ThOrderSection(props: { pools: Pool[]; gameTypes?: GameTypeOption[]; employees?: EmployeeOption[] }) {
  return (
    <>
      <RecoveryAccountSection gameTypes={props.gameTypes} employees={props.employees} businessResponsibleLabel="提号操作人" showIntermediaryDelivery accountExtras={<CustomFieldSection section="ACCOUNT_PRODUCT" testIdSuffix="account" />}>
        <ThFeeSection pools={props.pools} financeExtras={<CustomFieldSection section="FINANCE" testIdSuffix="finance" />} />
      </RecoveryAccountSection>
      <ThSupplierSection participantExtras={<CustomFieldSection section="PARTICIPANT" testIdSuffix="participant" />} />
    </>
  );
}
