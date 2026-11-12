import { Space } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { Order } from "../../shared/api/types/orders";
import { ACCOUNT_STATUS_LABEL, formatDateTimeMinute, formatElapsedTime, money } from "../../shared/lib/format";
import { columnKey, useListViewColumns } from "../../shared/lib/listColumns";
import { PermissionButton, PermissionGate, StatusTag } from "../../shared/ui";
import { formatOrderAmount } from "./helpers";

/**
 * 订单台账列定义域：15 列的渲染配置 + 配置中心列排序 + 移动端隐藏编排。
 * 从 useOrdersPageController 拆出为「依赖注入式」hook —— 所有打开弹窗的动作由调用方传入，
 * 本模块只描述列的展示与点击转发，不持有任何状态、不发任何请求。
 */
export function useLedgerColumns(params: {
  canDeleteOrder: boolean;
  openLedgerEditor: (order: Order) => void;
  openAllocations: (order: Order) => void;
  openRefund: (order: Order) => void;
  openOrderDelivery: (order: Order) => void;
  openOrderProfile: (order: Order, mode: "description" | "images") => void;
  openOrderRebate: (order: Order) => void;
  openOrderSale: (order: Order) => void;
  openOrderConsignment: (order: Order) => void;
  openCancelTransaction: (order: Order) => void;
  openOrderOffsale: (order: Order) => void;
  openOrderDelete: (order: Order) => void;
}) {
  const {
    canDeleteOrder,
    openLedgerEditor,
    openAllocations,
    openRefund,
    openOrderDelivery,
    openOrderProfile,
    openOrderRebate,
    openOrderSale,
    openOrderConsignment,
    openCancelTransaction,
    openOrderOffsale,
    openOrderDelete,
  } = params;
  const { arrange: arrangeLedgerColumns } = useListViewColumns("LEDGER");
  const ledgerColumns: ColumnsType<Order> = [
    { title: "订单号", dataIndex: "order_no", width: 110, ellipsis: true },
    { title: "游戏/产品类型", dataIndex: "account_game_type", width: 140, ellipsis: true, render: (v: string | null) => v || "-" },
    { title: "游戏账号/产品", dataIndex: "account_game_account", width: 140, ellipsis: true, render: (v: string | null) => v || "-" },
    { title: "入库负责人", dataIndex: "inventory_operator", width: 110, ellipsis: true, render: (v: string | null) => v || "-" },
    { title: "入库时间", dataIndex: "inventory_entry_at", width: 132, ellipsis: true, render: (v: string | null) => formatDateTimeMinute(v) },
    { title: "售卖负责人", dataIndex: "sale_operator", width: 110, ellipsis: true, render: (v: string | null) => v || "-" },
    { title: "售卖时间", dataIndex: "sale_at", width: 132, ellipsis: true, render: (v: string | null) => formatDateTimeMinute(v) },
    { title: "在手时间", key: "in_hand_time", width: 120, ellipsis: true, render: (_v, order) => order.in_hand_time ?? formatElapsedTime(order.inventory_entry_at, order.sale_at) },
    { title: "金额", dataIndex: "event_total", width: 126, ellipsis: true, render: (_v: string | null, order) => formatOrderAmount(order) },
    { title: "订单状态", dataIndex: "status", width: 96, ellipsis: true, render: (v: string) => <StatusTag status={v} optionSet="ORDER_STATUS" /> },
    { title: "库存状态", dataIndex: "account_status", width: 102, ellipsis: true, render: (v: string | null) => v ? <StatusTag status={v} label={ACCOUNT_STATUS_LABEL[v] ?? v} /> : "-" },
    { title: "成本", dataIndex: "cost_amount", width: 110, ellipsis: true, render: (_v: string | null, order) => order.account_status === "SOLD" && order.cost_amount != null ? `¥${money(order.cost_amount)}` : "-" },
    { title: "利润", dataIndex: "profit_base", width: 110, ellipsis: true, render: (_v: string | null, order) => order.account_status === "SOLD" && order.profit_base != null ? `¥${money(order.profit_base)}` : "-" },
    { title: "日期", dataIndex: "trade_date", width: 144, ellipsis: true },
    {
      title: "操作",
      key: "actions",
      width: 470,
      ellipsis: true,
      render: (_, order) => {
        const canOffsaleConsignment = order.order_type === "DG" && order.status === "ACTIVE" && order.account_status === "WAITING";
        const hasSold = order.status === "COMPLETED"
          || order.last_event_type === "SELL"
          || Boolean(order.sale_at)
          || (order.events ?? []).some((event) => event.event_type === "SELL");
        return (
          <Space size={2}>
          {order.account_id || ["ACTIVE", "INSTALLMENT"].includes(order.status) ? (
            <PermissionButton
              permission="order.update"
              type="link"
              size="small"
              title={order.account_id ? undefined : "未关联库存时会先生成库存编号"}
              onClick={() => void openLedgerEditor(order)}
            >编辑</PermissionButton>
          ) : null}
          <PermissionGate permission="order.event.post">
            <PermissionButton
              permission="order.event.post"
              type="link"
              size="small"
              disabled={!hasSold || !['ACTIVE', 'INSTALLMENT', 'COMPLETED'].includes(order.status)}
              title={hasSold ? undefined : "订单售出后才能配置分润"}
              onClick={() => void openAllocations(order)}
            >分润配置</PermissionButton>
            <PermissionButton
              permission="order.event.post"
              type="link"
              size="small"
              disabled={!['ACTIVE', 'INSTALLMENT', 'COMPLETED'].includes(order.status)}
              onClick={() => void openRefund(order)}
            >资金收支</PermissionButton>
            <PermissionButton
              permission="order.event.post"
              type="link"
              size="small"
              disabled={order.status === "CANCELLED"}
              onClick={() => void openOrderDelivery(order)}
            >交付</PermissionButton>
            <PermissionButton
              permission="order.create"
              type="link"
              size="small"
              disabled={!order.account_id || order.status === "CANCELLED"}
              onClick={() => void openOrderProfile(order, "description")}
            >描述</PermissionButton>
            <PermissionButton
              permission="order.create"
              type="link"
              size="small"
              disabled={!order.account_id || order.status === "CANCELLED"}
              onClick={() => void openOrderProfile(order, "images")}
            >作图</PermissionButton>
            <PermissionButton
              permission="order.event.post"
              type="link"
              size="small"
              disabled={!order.account_id}
              onClick={() => void openOrderRebate(order)}
            >返点</PermissionButton>
            <PermissionButton
              permission="order.create"
              type="link"
              size="small"
              disabled={order.account_status !== "WAITING" || !order.account_id}
              onClick={() => void openOrderSale(order)}
            >售出</PermissionButton>
            <PermissionButton
              permission="order.create"
              type="link"
              size="small"
              disabled={order.account_status !== "WAITING" || !order.account_id}
              onClick={() => void openOrderConsignment(order)}
            >寄售</PermissionButton>
            <PermissionButton
              permission="order.event.post"
              type="link"
              size="small"
              danger
              disabled={!['ACTIVE', 'INSTALLMENT', 'COMPLETED'].includes(order.status)}
              onClick={() => {
                if (canOffsaleConsignment) void openOrderOffsale(order);
                else void openCancelTransaction(order);
              }}
            >{canOffsaleConsignment ? "下架" : "取消"}</PermissionButton>
          </PermissionGate>
          {canDeleteOrder ? (
            <PermissionButton
              permission="order.update"
              type="link"
              size="small"
              danger
              onClick={() => void openOrderDelete(order)}
            >删除订单</PermissionButton>
          ) : null}
        </Space>
        );
      },
    },
  ];
  const configuredLedgerColumns = arrangeLedgerColumns(ledgerColumns);
  const ledgerDateColumn = ledgerColumns.find((column) => columnKey(column) === "trade_date");
  // 日期是订单台账的核心识别字段，避免配置中心误隐藏后整列消失。
  const visibleLedgerColumns = ledgerDateColumn && !configuredLedgerColumns.some((column) => columnKey(column) === "trade_date")
    ? [
        ...configuredLedgerColumns.filter((column) => columnKey(column) !== "actions"),
        ledgerDateColumn,
        ...configuredLedgerColumns.filter((column) => columnKey(column) === "actions"),
      ]
    : configuredLedgerColumns;

  return { arrangeLedgerColumns, visibleLedgerColumns };
}
