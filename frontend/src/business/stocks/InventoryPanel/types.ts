import type { Account } from "../../../shared/api/types/accounts";
import type { Order } from "../../../shared/api/types/orders";

/** 库存中心的行模型：订单是主实体，账号只作为库存动作与详情编辑的关联对象。 */
export type InventoryOrderRow = Order & {
  account: Account;
  inventory_type: string | null;
};

export const INVENTORY_TYPE_BY_ORDER_TYPE: Record<string, string> = {
  HS: "RECOVERY",
  TH: "PICKUP",
  DG: "CONSIGNMENT",
};

export function inventoryTypeOfOrder(order: Pick<Order, "order_type">, account?: Pick<Account, "inventory_type"> | null) {
  return account?.inventory_type ?? INVENTORY_TYPE_BY_ORDER_TYPE[order.order_type] ?? null;
}

export function mergeInventoryAccount(row: InventoryOrderRow, account: Account): InventoryOrderRow {
  return {
    ...row,
    account,
    stock_no: account.stock_no,
    account_game_type: account.game_type,
    account_game_account: account.game_account,
    account_channel_region: account.channel_region,
    account_business_mode: account.business_mode,
    account_status: account.status,
    inventory_entry_at: account.inventory_entry_at,
    inventory_operator: account.inventory_operator,
    cost_amount: account.cost_amount,
    inventory_type: inventoryTypeOfOrder(row, account),
  };
}
