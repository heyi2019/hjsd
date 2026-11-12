import type { Pool } from "../../shared/api/types/finance";
import { PaymentInfoSection } from "../PaymentInfoSection";

export function RecoveryPaymentSection(props: { pools: Pool[] }) {
  return <PaymentInfoSection pools={props.pools} />;
}
