import type { OrderOperationContext, OrderOperationItem } from "./types";

export const IMAGES_OPERATION: OrderOperationItem = {
  key: "images",
  label: "作图",
};

export function imagesOperation(context: OrderOperationContext): OrderOperationItem | null {
  return context.row.status === "SOLD" ? null : IMAGES_OPERATION;
}
