import { Dropdown } from "antd";
import type { Dayjs } from "dayjs";
import type { Account, AccountExecutionDetail } from "../../shared/api/catalog";
import { formatDateTimeMinute } from "../../shared/lib/format";
import { orderMobileFields } from "../../shared/lib/listColumns";
import { MoneyText, PermissionButton, StatusTag } from "../../shared/ui";
import { BUSINESS_MODE_LABEL, INVENTORY_TYPE_LABEL, inventoryAge, isEditableAccountType } from "../inventory-logic";

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
  const hasActiveConsignment = Boolean(detail?.orders.some((order) => order.order_type === "DG" && order.status !== "CANCELLED"));
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

export function MobileInventoryList({
  rows,
  onDetail,
  onSale,
  onConsign,
  onVoid,
  onRebate,
  onEdit,
  onMoreAction,
  executionDetails = {},
  onLoadExecution = () => undefined,
  editingAccount,
  fieldOrder,
}: {
  rows: Account[];
  onDetail: (row: Account) => void;
  onSale: (row: Account) => void;
  onConsign: (row: Account) => void;
  onVoid: (row: Account) => void;
  onRebate: (row: Account) => void;
  onEdit: (row: Account) => void;
  onMoreAction: (key: string, row: Account) => void;
  executionDetails?: Record<number, AccountExecutionDetail>;
  onLoadExecution?: (row: Account) => void | Promise<void>;
  editingAccount: number | null;
  fieldOrder?: string[];
}) {
  if (rows.length === 0) return <div className="data-mobile-empty">暂无账号</div>;
  return (
    <div className="data-mobile-list">
      {rows.map((row) => {
        const age = inventoryAge(row);
        const fields = orderMobileFields([
          { key: "game_type", label: "游戏/产品类型", value: row.game_type || "-" },
          { key: "game_account", label: "游戏账号/产品", value: row.game_account || "-" },
          { key: "camp_account", label: "营地账号", value: row.camp_account || "-" },
          { key: "source_order_no", label: "订单号", value: row.source_order_no || "-" },
          { key: "business_mode", label: "业务", value: row.business_mode ? BUSINESS_MODE_LABEL[row.business_mode] ?? row.business_mode : "-" },
          { key: "inventory_type", label: "业务类型", value: row.inventory_type ? INVENTORY_TYPE_LABEL[row.inventory_type] ?? row.inventory_type : "-" },
          { key: "inventory_entry_at", label: "入库时间", value: formatDateTimeMinute(row.inventory_entry_at) },
          { key: "inventory_operator", label: "入库负责人", value: row.inventory_operator || row.created_by || "-" },
          { key: "inventory_age", label: "未售时长", value: age ? `${age.days}天` : "-" },
          { key: "cost_amount", label: "成本", value: <MoneyText value={row.cost_amount} /> },
        ], fieldOrder);
        return (
          <article key={row.id} className="data-mobile-card">
            <div className="data-mobile-card__topline">
              <span className="data-mobile-card__title">{row.stock_no || row.game_account || `账号 ${row.id}`}</span>
              <StatusTag status={row.inventory_status ?? (row.status === "WAITING" ? "IN_STOCK" : row.status)} label={row.status === "VOID" ? "下架" : undefined} />
            </div>
            <dl className="data-mobile-card__meta">
              {fields.map((field) => <div key={field.key}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}
            </dl>
            <div className="data-mobile-card__actions">
              <PermissionButton permission="order.create" type="link" size="small" onClick={() => onDetail(row)}>详情</PermissionButton>
              <PermissionButton permission="order.create" type="link" size="small" disabled={row.status !== "WAITING"} onClick={() => onSale(row)}>售出</PermissionButton>
              <PermissionButton permission="order.create" type="link" size="small" disabled={row.status === "SOLD"} onClick={() => onConsign(row)}>寄售</PermissionButton>
              <PermissionButton permission="order.event.post" type="link" size="small" onClick={() => onRebate(row)}>返点</PermissionButton>
              {isEditableAccountType(row.inventory_type) ? (
                <>
                  <PermissionButton permission="order.create" type="link" size="small" disabled={editingAccount !== null} onClick={() => onEdit(row)}>编辑</PermissionButton>
                  <Dropdown
                    trigger={["click"]}
                    placement="bottomRight"
                    onOpenChange={(open) => { if (open) void onLoadExecution(row); }}
                    menu={{
                      className: "inventory-more-menu",
                      items: moreMenuItems(row, executionDetails[row.id]),
                      onClick: ({ key }) => onMoreAction(key, row),
                    }}
                  >
                    <PermissionButton permission="order.create" type="link" size="small">更多</PermissionButton>
                  </Dropdown>
                </>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}
