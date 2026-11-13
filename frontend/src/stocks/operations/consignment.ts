import type { InventoryOperationContext, InventoryOperationItem } from "./types";

export const CONSIGNMENT_OPERATION: InventoryOperationItem = {
  key: "consignment",
  label: "寄售（上架）",
};

export function consignmentOperation(context: InventoryOperationContext): InventoryOperationItem | null {
  return context.row.status === "SOLD" ? null : CONSIGNMENT_OPERATION;
}

export { InventoryConsignmentModal } from "./consignment-modal";
