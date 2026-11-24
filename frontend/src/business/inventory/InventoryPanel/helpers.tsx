import type { AccountExecutionDetail } from "../../../shared/api/types/account-execution";
import { orderOperationMenuItems } from "../../shared/operations";
import type { InventoryOrderRow } from "./types";

export type InventoryActionKey = "void" | "description" | "images";

export function inventoryCellValue(value: string | null | undefined) {
  return value ? value : <span className="inventory-empty-cell">-</span>;
}

/** 运营菜单统一承载寄售上架、下架、描述和作图四个动作。 */
export function operationMenuItems(row: InventoryOrderRow, detail?: AccountExecutionDetail) {
  return orderOperationMenuItems({ row: row.account, detail });
}

/** 从后往前找最近一条仍可冲销的买入事件，金额使用后端下发的余额。 */
export function findCancelableBuy(detail: AccountExecutionDetail) {
  for (let i = detail.orders.length - 1; i >= 0; i -= 1) {
    const order = detail.orders[i];
    for (let j = order.events.length - 1; j >= 0; j -= 1) {
      const event = order.events[j];
      if (event.event_type !== "BUY") continue;
      if (Number(event.cancellable_amount) <= 0) continue;
      return {
        orderId: order.order_id,
        eventId: event.id,
        amount: event.cancellable_amount,
        portion: event.portion,
        poolId: event.pool_id ?? undefined,
      };
    }
  }
  return null;
}

