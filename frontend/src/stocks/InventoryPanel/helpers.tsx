import type { Dayjs } from "dayjs";
import type { AccountExecutionDetail } from "../../shared/api/types/account-execution";
import { orderOperationItems } from "../../orders/operations";
import type { InventoryOrderRow } from "./types";

export type InventoryFilterOptions = {
  businessMode?: string;
  inventoryType?: string;
  gameType?: string;
  keyword?: string;
  dateRange?: [Dayjs, Dayjs] | null;
};

export type InventoryActionKey = "void" | "description" | "images";

/** 库存筛选的单一事实源：先排除非在库，再套用维度条件，避免渲染层重复遍历。 */
export function filterInventoryRows(rows: InventoryOrderRow[], options: InventoryFilterOptions = {}) {
  const keyword = options.keyword?.trim().toLowerCase() ?? "";
  return rows.filter((row) => {
    if (row.account_status !== "WAITING") return false;
    if (options.businessMode && (row.account_business_mode ?? row.business_mode) !== options.businessMode) return false;
    if (options.inventoryType && row.inventory_type !== options.inventoryType) return false;
    if (options.gameType && row.account_game_type !== options.gameType) return false;
    const rowDate = row.inventory_entry_at ?? row.account.inventory_entry_at ?? row.trade_date ?? row.account.created_at;
    if (options.dateRange) {
      const date = rowDate ? new Date(rowDate) : null;
      if (!date || Number.isNaN(date.getTime()) || date < options.dateRange[0].startOf("day").toDate() || date > options.dateRange[1].endOf("day").toDate()) return false;
    }
    if (!keyword) return true;
    return [row.account_game_account, row.account_game_type, row.account_channel_region, row.account_platform]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(keyword);
  });
}

export function inventoryCellValue(value: string | null | undefined) {
  return value ? value : <span className="inventory-empty-cell">-</span>;
}

/** 运营菜单统一承载寄售上架、下架、描述和作图四个动作。 */
export function operationMenuItems(row: InventoryOrderRow, detail?: AccountExecutionDetail) {
  return orderOperationItems({ row: row.account, detail });
}

/** 从后往前找最近一条后端标记为「仍可冲销」的 BUY/SELL；金额直接用后端下发的余额，不本地相减。 */
export function findCancelableEvent(detail: AccountExecutionDetail, eventType: "BUY" | "SELL") {
  for (let i = detail.orders.length - 1; i >= 0; i -= 1) {
    const order = detail.orders[i];
    for (let j = order.events.length - 1; j >= 0; j -= 1) {
      const event = order.events[j];
      if (event.event_type !== eventType) continue;
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

export const findCancelableSale = (detail: AccountExecutionDetail) => findCancelableEvent(detail, "SELL");
export const findCancelableBuy = (detail: AccountExecutionDetail) => findCancelableEvent(detail, "BUY");

