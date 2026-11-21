import type { OrderOperationContext, OrderOperationItem } from "./types";

export const DESCRIPTION_OPERATION: OrderOperationItem = {
  key: "description",
  label: "描述",
};

export function descriptionOperation(context: OrderOperationContext): OrderOperationItem | null {
  return context.row.status === "SOLD" ? null : DESCRIPTION_OPERATION;
}
