import type { AccountExecutionOrder } from "../shared/api/catalog";

/** 返回实际寄售平台；没有平台的初始 DG 建单不是上架记录。 */
export function consignmentPlatform(order: AccountExecutionOrder): string | null {
  const configured = order.extra_values?.consignment_platform;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  const parties = (order.counterparties ?? [])
    .filter((party) => party.role === "PLATFORM")
    .map((party) => party.display_name.trim())
    .filter(Boolean);
  return parties.length ? parties.join("、") : null;
}

/** DG 建单本身可以代表账号进入代挂库存，但只有有平台的 DG 才代表平台上架。 */
export function isConsignmentListing(order: AccountExecutionOrder): boolean {
  return order.order_type === "DG" && Boolean(consignmentPlatform(order));
}

/** 只有未取消且未登记平台下架的寄售动作才进入“当前上架”列表。 */
export function isActiveConsignmentListing(order: AccountExecutionOrder): boolean {
  if (!isConsignmentListing(order) || order.status === "CANCELLED") return false;
  const extra = order.extra_values ?? {};
  return !extra.platform_unlisted_at && !extra.platform_unlist_scope;
}
