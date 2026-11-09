/** 建单参与方规则：统一维护客户与合作伙伴的角色拼装口径。 */

export type BusinessOrderType = "HS" | "TH" | "DG";

/** 提号建单的合作伙伴角色统一为 SUPPLIER。 */
export const TH_COUNTERPARTY_ROLE = "SUPPLIER" as const;

export function participantLookupKey(displayName: string, type: string): string {
  return `${displayName}\u0000${type}`;
}

export function buildCustomerRoles(
  orderType: BusinessOrderType,
  customerId: number | undefined,
): Array<{ customer_id: number; role: string }> {
  if (customerId == null || orderType === "TH") return [];
  return [{
    customer_id: customerId,
    role: orderType === "HS" ? "SELLER" : "CONSIGNOR",
  }];
}

export function buildCounterpartyRoles(
  orderType: BusinessOrderType,
  counterpartyId: number | undefined,
  fallbackRole: string | undefined,
): Array<{ counterparty_id: number; role: string }> {
  if (counterpartyId == null) return [];
  return [{
    counterparty_id: counterpartyId,
    role: orderType === "TH" ? TH_COUNTERPARTY_ROLE : (fallbackRole ?? "PEER"),
  }];
}
