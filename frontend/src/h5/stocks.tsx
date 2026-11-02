/** H5（≤640px）库存账号卡片列表。
 *
 * 归属移动端层；业务类型等展示文案仍从 stocks 域的纯函数取，避免两套。
 * 库龄天数与档位由后端下发（AccountOut.inventory_age_days / _level），此处不做日期差。
 */
import { Dropdown } from "antd";
import type { Account, AccountExecutionDetail } from "../shared/api/catalog";
import { formatDateTimeMinute } from "../shared/lib/format";
import { orderMobileFields } from "../shared/lib/listColumns";
import { MoneyText, PermissionButton, StatusTag } from "../shared/ui";
import { BUSINESS_MODE_LABEL, INVENTORY_TYPE_LABEL, isEditableAccountType } from "../stocks/inventory-logic";
import { moreMenuItems } from "../stocks/InventoryPanel/helpers";

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
        const fields = orderMobileFields([
          { key: "game_type", label: "游戏/产品类型", value: row.game_type || "-" },
          { key: "game_account", label: "游戏账号/产品", value: row.game_account || "-" },
          { key: "camp_account", label: "营地账号", value: row.camp_account || "-" },
          { key: "source_order_no", label: "订单号", value: row.source_order_no || "-" },
          { key: "business_mode", label: "业务", value: row.business_mode ? BUSINESS_MODE_LABEL[row.business_mode] ?? row.business_mode : "-" },
          { key: "inventory_type", label: "业务类型", value: row.inventory_type ? INVENTORY_TYPE_LABEL[row.inventory_type] ?? row.inventory_type : "-" },
          { key: "inventory_entry_at", label: "入库时间", value: formatDateTimeMinute(row.inventory_entry_at) },
          { key: "inventory_operator", label: "入库负责人", value: row.inventory_operator || row.created_by || "-" },
          { key: "inventory_age", label: "未售时长", value: row.inventory_age_days == null ? "-" : `${row.inventory_age_days}天` },
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
