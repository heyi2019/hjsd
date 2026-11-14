import type { InventoryOperationContext, InventoryOperationItem } from "./types";

export const IMAGES_OPERATION: InventoryOperationItem = {
  key: "images",
  label: "作图",
};

export function imagesOperation(context: InventoryOperationContext): InventoryOperationItem | null {
  return context.row.status === "SOLD" ? null : IMAGES_OPERATION;
}

export { InventoryProfileModal } from "./profile-modal";
export type { InventoryProfileTarget } from "./profile-modal";
