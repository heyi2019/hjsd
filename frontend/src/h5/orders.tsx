/** H5（≤640px）订单卡片列表。
 *
 * 归属移动端层：这里只做「怎么把一行数据摆成卡片」，取数与业务规则留在 orders 域。
 * 桌面由 useCompactLayout 控制不挂载，卡片不进 DOM，桌面表格与单测不受影响。
 */
import type { Order } from "../shared/api/catalog";
import { ACCOUNT_STATUS_LABEL, executionActionLabel, formatDateTimeMinute, formatElapsedTime } from "../shared/lib/format";
import { orderMobileFields } from "../shared/lib/listColumns";
import { PermissionButton, StatusTag } from "../shared/ui";
import { formatOrderAmount } from "../orders/orderpage/helpers";

export function MobileOrderList(props: {
  orders: Order[];
  emptyText: string;
  onSelect: (order: Order) => void;
  fieldOrder?: string[];
}) {
  if (!props.orders.length) return <div className="orders-mobile-empty muted">{props.emptyText}</div>;
  return (
    <div className="orders-mobile-list" aria-label="订单列表">
      {props.orders.map((order) => (
        <article className="orders-mobile-card" key={order.id}>
          <div className="orders-mobile-card__topline">
            <strong>{order.order_no}</strong>
            <StatusTag status={order.status} optionSet="ORDER_STATUS" />
          </div>
          <dl className="orders-mobile-card__meta">
            {orderMobileFields([
              { key: "party", label: "对方 / 来源", value: [order.party_name, order.party_source].filter(Boolean).join(" · ") || "-" },
              { key: "account_game_type", label: "游戏/产品类型", value: order.account_game_type || "-" },
              { key: "account_game_account", label: "游戏账号/产品", value: order.account_game_account || "-" },
              { key: "account_platform", label: "平台", value: order.account_platform || "-" },
              { key: "inventory_operator", label: "入库负责人", value: order.inventory_operator || "-" },
              { key: "inventory_entry_at", label: "入库时间", value: formatDateTimeMinute(order.inventory_entry_at) },
              { key: "sale_operator", label: "售卖负责人", value: order.sale_operator || "-" },
              { key: "sale_at", label: "售卖时间", value: formatDateTimeMinute(order.sale_at) },
              { key: "in_hand_time", label: "在手时间", value: formatElapsedTime(order.inventory_entry_at, order.sale_at) },
              { key: "event_total", label: "金额", value: formatOrderAmount(order) },
              { key: "account_status", label: "账号周期", value: order.account_status ? ACCOUNT_STATUS_LABEL[order.account_status] ?? order.account_status : "-" },
              { key: "last_event_type", label: "最新动作", value: order.last_event_type ? executionActionLabel(order.last_event_type, order.order_type) : "-" },
              { key: "trade_date", label: "日期", value: order.trade_date || "-" },
            ], props.fieldOrder).map((field) => <div key={field.key}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}
          </dl>
          <PermissionButton permission="order.update" type="link" onClick={() => props.onSelect(order)}>编辑订单</PermissionButton>
        </article>
      ))}
    </div>
  );
}
