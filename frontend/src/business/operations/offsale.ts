import { isActiveConsignmentListing } from "./consignment-logic";
import type { OrderOperationContext, OrderOperationItem } from "./types";

export const OFFSALE_OPERATION: OrderOperationItem = {
  key: "offsale",
  label: "下架",
};

export function offsaleOperation(context: OrderOperationContext): OrderOperationItem | null {
  const canOffsale = context.row.status !== "SOLD" && context.row.status !== "VOID";
  const canSystemOffsale = context.row.inventory_type === "CONSIGNMENT" && canOffsale;
  const hasActiveConsignment = Boolean(context.detail?.orders.some(isActiveConsignmentListing));
  return canOffsale && (hasActiveConsignment || canSystemOffsale) ? OFFSALE_OPERATION : null;
}

export { OrderPlatformOffsaleModal, consignmentRecords } from "./offsale-modal";
export type { ActiveConsignment } from "./offsale-modal";
