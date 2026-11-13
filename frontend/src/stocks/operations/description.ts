import type { InventoryOperationContext, InventoryOperationItem } from "./types";

export const DESCRIPTION_OPERATION: InventoryOperationItem = {
  key: "description",
  label: "描述",
};

export function descriptionOperation(context: InventoryOperationContext): InventoryOperationItem | null {
  return context.row.status === "SOLD" ? null : DESCRIPTION_OPERATION;
}
