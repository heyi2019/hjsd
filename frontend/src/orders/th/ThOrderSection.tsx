import type { GameTypeOption, Pool } from "../../shared/api/catalog";
import { RecoveryAccountSection } from "../recovery/RecoveryAccountSection";
import { ThFeeSection } from "./ThFeeSection";
import { ThSupplierSection } from "./ThSupplierSection";

/** 提号复用回收页主结构：账号信息、费用明细、付款信息保持一致，仅客户区替换为供货方区。 */
export function ThOrderSection(props: { pools: Pool[]; gameTypes?: GameTypeOption[] }) {
  return (
    <>
      <RecoveryAccountSection gameTypes={props.gameTypes}>
        <ThFeeSection pools={props.pools} />
      </RecoveryAccountSection>
      <ThSupplierSection />
    </>
  );
}
