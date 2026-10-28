import type { GameTypeOption, Pool } from "../../shared/api/catalog";
import { RecoveryAccountSection } from "../recovery/RecoveryAccountSection";
import { ThFeeSection } from "./ThFeeSection";
import { ThSupplierSection } from "./ThSupplierSection";
import { CustomFieldSection } from "../ConfigurableField";

/** 提号复用回收页主结构：账号信息、费用明细、付款信息保持一致，仅客户区替换为供货方区。 */
export function ThOrderSection(props: { pools: Pool[]; gameTypes?: GameTypeOption[] }) {
  return (
    <>
      <RecoveryAccountSection gameTypes={props.gameTypes} accountExtras={<CustomFieldSection section="ACCOUNT_PRODUCT" testIdSuffix="account" />}>
        <ThFeeSection pools={props.pools} financeExtras={<CustomFieldSection section="FINANCE" testIdSuffix="finance" />} />
      </RecoveryAccountSection>
      <ThSupplierSection participantExtras={<CustomFieldSection section="PARTICIPANT" testIdSuffix="participant" />} />
    </>
  );
}
