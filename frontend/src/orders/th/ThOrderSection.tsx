import type { Pool } from "../../shared/api/catalog";
import { RecoveryAccountSection } from "../recovery/RecoveryAccountSection";
import { ThFeeSection } from "./ThFeeSection";
import { ThSupplierSection } from "./ThSupplierSection";

/** 提号复用回收页主结构：账号信息、费用明细、付款信息保持一致，仅客户区替换为供货方区。 */
export function ThOrderSection(props: { pools: Pool[] }) {
  return (
    <>
      <RecoveryAccountSection fieldNames={{
        gameType: "th_game_type",
        gameAccount: "th_game_account",
        gamePassword: "th_game_password",
        channelRegion: "th_channel_region",
        boundPhone: "th_bound_phone",
        hasSecondary: "th_has_secondary",
        accountNote: "th_account_note",
      }}>
        <ThFeeSection pools={props.pools} />
      </RecoveryAccountSection>
      <ThSupplierSection />
    </>
  );
}
