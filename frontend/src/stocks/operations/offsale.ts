import { isActiveConsignmentListing } from "../consignment-logic";
import type { InventoryOperationContext, InventoryOperationItem } from "./types";

export const OFFSALE_OPERATION: InventoryOperationItem = {
  key: "offsale",
  label: "下架",
};

export function offsaleOperation(context: InventoryOperationContext): InventoryOperationItem | null {
  const canOffsale = context.row.status !== "SOLD" && context.row.status !== "VOID";
  const canSystemOffsale = context.row.inventory_type === "CONSIGNMENT" && canOffsale;
  const hasActiveConsignment = Boolean(context.detail?.orders.some(isActiveConsignmentListing));
  return canOffsale && (hasActiveConsignment || canSystemOffsale) ? OFFSALE_OPERATION : null;
}
