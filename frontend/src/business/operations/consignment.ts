import type { OrderOperationContext, OrderOperationItem } from "./types";

export const CONSIGNMENT_OPERATION: OrderOperationItem = {
  key: "consignment",
  label: "寄售（上架）",
};

export function consignmentOperation(context: OrderOperationContext): OrderOperationItem | null {
  return context.row.status === "SOLD" ? null : CONSIGNMENT_OPERATION;
}

export { OrderConsignmentModal } from "./consignment-modal";
