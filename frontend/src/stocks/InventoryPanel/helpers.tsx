import type { Dayjs } from "dayjs";
import type { AccountExecutionDetail } from "../../shared/api/types/account-execution";
import type { Account } from "../../shared/api/types/accounts";
import { isActiveConsignmentListing } from "../consignment-logic";

export type InventoryFilterOptions = {
  businessMode?: string;
  inventoryType?: string;
  gameType?: string;
  keyword?: string;
  dateRange?: [Dayjs, Dayjs] | null;
};

/** 库存筛选的单一事实源：先排除非在库，再套用维度条件，避免渲染层重复遍历。 */
export function filterInventoryRows(rows: Account[], options: InventoryFilterOptions = {}) {
  const keyword = options.keyword?.trim().toLowerCase() ?? "";
  return rows.filter((row) => {
    if (row.status !== "WAITING") return false;
    if (options.businessMode && row.business_mode !== options.businessMode) return false;
    if (options.inventoryType && row.inventory_type !== options.inventoryType) return false;
    if (options.gameType && row.game_type !== options.gameType) return false;
    const rowDate = row.inventory_entry_at ?? row.buy_date ?? row.created_at;
    if (options.dateRange) {
      const date = rowDate ? new Date(rowDate) : null;
      if (!date || Number.isNaN(date.getTime()) || date < options.dateRange[0].startOf("day").toDate() || date > options.dateRange[1].endOf("day").toDate()) return false;
    }
    if (!keyword) return true;
    return [row.game_account, row.game_type, row.channel_region, row.platform]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(keyword);
  });
}

export function inventoryCellValue(value: string | null | undefined) {
  return value ? value : <span className="inventory-empty-cell">-</span>;
}

/** 更多菜单只暴露当前能完成的动作，避免用户看到无效入口。 */
export function moreMenuItems(row: Account, detail?: AccountExecutionDetail) {
  const canPlatformOffsale = row.status !== "SOLD" && row.status !== "VOID";
  const canSystemOffsale = row.inventory_type === "CONSIGNMENT" && canPlatformOffsale;
  const hasActiveConsignment = Boolean(detail?.orders.some(isActiveConsignmentListing));
  const items = [] as Array<{ key: string; label: string; danger?: boolean }>;
  if (canPlatformOffsale && (hasActiveConsignment || canSystemOffsale)) items.push({ key: "offsale", label: "下架" });
  if (canPlatformOffsale) items.push({ key: "void", label: "取消", danger: true });
  if (row.status !== "SOLD") items.push({ key: "description", label: "描述" }, { key: "images", label: "作图" });
  return items;
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

