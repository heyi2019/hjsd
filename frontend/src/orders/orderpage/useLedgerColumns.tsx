import { Dropdown, Space } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { AccountExecutionDetail } from "../../shared/api/types/account-execution";
import type { Order } from "../../shared/api/types/orders";
import { ACCOUNT_STATUS_LABEL, formatDateTimeMinute, formatElapsedTime, money } from "../../shared/lib/format";
import { columnKey, useListViewColumns } from "../../shared/lib/listColumns";
import { PermissionButton, PermissionGate, StatusTag } from "../../shared/ui";
import { inventoryOperationMenuItems } from "../../stocks/operations";
import { inventoryTypeOfOrder } from "../../stocks/InventoryPanel/types";
import { formatOrderAmount } from "./helpers";

/**
 * 订单台账列定义域：15 列的渲染配置 + 配置中心列排序 + 移动端隐藏编排。
 * 从 useOrdersPageController 拆出为「依赖注入式」hook —— 所有打开弹窗的动作由调用方传入，
 * 本模块只描述列的展示与点击转发，不持有任何状态、不发任何请求。
 */
export function useLedgerColumns(params: {
  canDeleteOrder: boolean;
  ledgerDetails: Record<number, AccountExecutionDetail>;
  loadLedgerDetail: (accountId: number, force?: boolean) => Promise<void>;
  openLedgerEditor: (order: Order) => void;
  openAllocations: (order: Order) => void;
  openRefund: (order: Order) => void;
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
    ledgerDetails,
    loadLedgerDetail,
    openLedgerEditor,
    openAllocations,
    openRefund,
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
    { title: "库存编号", dataIndex: "stock_no", width: "var(--col-w-86)", ellipsis: true, render: (v: string | null) => v || "-" },
    { title: "订单号", dataIndex: "order_no", width: "var(--col-w-80)", ellipsis: true },
    { title: "入库时间", dataIndex: "inventory_entry_at", width: 132, ellipsis: true, render: (v: string | null) => formatDateTimeMinute(v) },
    { title: "入库负责人", dataIndex: "inventory_operator", width: "var(--col-w-100)", ellipsis: true, render: (v: string | null) => v || "-" },
    { title: "成本", dataIndex: "cost_amount", width: "var(--col-w-90)", ellipsis: true, render: (_v: string | null, order) => order.account_status === "SOLD" && order.cost_amount != null ? `¥${money(order.cost_amount)}` : "-" },
    { title: "游戏/产品类型", dataIndex: "account_game_type", width: "var(--col-w-80)", ellipsis: true, render: (v: string | null) => v || "-" },
    { title: "游戏账号/产品", dataIndex: "account_game_account", width: "var(--col-w-120)", ellipsis: true, render: (v: string | null) => v || "-" },
    { title: "售卖时间", dataIndex: "sale_at", width: 132, ellipsis: true, render: (v: string | null) => formatDateTimeMinute(v) },
    { title: "售卖人", dataIndex: "sale_operator", width: "var(--col-w-100)", ellipsis: true, render: (v: string | null) => v || "-" },
    { title: "售出金额", dataIndex: "sale_amount", width: "var(--col-w-90)", ellipsis: true, render: (_v: string | null, order) => formatOrderAmount(order) },
    { title: "在手时间", key: "in_hand_time", width: "var(--col-w-80)", ellipsis: true, render: (_v, order) => order.in_hand_time ?? formatElapsedTime(order.inventory_entry_at, order.sale_at) },
    { title: "订单状态", dataIndex: "status", width: "var(--col-w-80)", ellipsis: true, render: (v: string) => <StatusTag status={v} optionSet="ORDER_STATUS" /> },
    { title: "库存状态", dataIndex: "account_status", width: "var(--col-w-80)", ellipsis: true, render: (v: string | null) => v ? <StatusTag status={v} label={ACCOUNT_STATUS_LABEL[v] ?? v} /> : "-" },
    { title: "利润", dataIndex: "profit_base", width: "var(--col-w-90)", ellipsis: true, render: (_v: string | null, order) => order.account_status === "SOLD" && order.profit_base != null ? `¥${money(order.profit_base)}` : "-" },
    { title: "日期", dataIndex: "trade_date", width: "var(--col-w-132)", ellipsis: true },
    {
      title: "操作",
      key: "actions",
      width: "var(--col-w-420)",
      ellipsis: true,
      render: (_, order) => {
        const canSystemOffsale = order.order_type === "DG" && order.status === "ACTIVE" && order.account_status === "WAITING";
        const hasSold = order.status === "COMPLETED"
          || order.last_event_type === "SELL"
          || Boolean(order.sale_at)
          || (order.events ?? []).some((event) => event.event_type === "SELL");
        const canOperateAccount = Boolean(order.account_id) && order.status !== "CANCELLED";
        const operationItems = inventoryOperationMenuItems(
          {
            row: canOperateAccount
              ? {
                  status: order.account_status ?? "VOID",
                  inventory_type: inventoryTypeOfOrder(order),
                }
              : { status: "VOID", inventory_type: null },
            detail: order.account_id ? ledgerDetails[order.account_id] : undefined,
          },
          { allowProfileAfterSold: canOperateAccount },
        );
        return (
          <Space size={4} className="orders-ledger-actions">
          <PermissionGate permission="order.event.post">
            <PermissionButton
              permission="order.create"
              type="link"
              size="small"
              disabled={order.account_status !== "WAITING" || !order.account_id}
              onClick={(event) => { event.stopPropagation(); void openOrderSale(order); }}
            >售出</PermissionButton>
          </PermissionGate>
          {order.account_id || ["ACTIVE", "INSTALLMENT"].includes(order.status) ? (
            <PermissionButton
              permission="order.update"
              type="link"
              size="small"
              title={order.account_id ? undefined : "未关联库存时会先生成库存编号"}
              onClick={(event) => { event.stopPropagation(); void openLedgerEditor(order); }}
            >编辑</PermissionButton>
          ) : null}
          <PermissionGate permission="order.event.post">
            <PermissionButton
              permission="order.event.post"
              type="link"
              size="small"
              disabled={!hasSold || !['ACTIVE', 'INSTALLMENT', 'COMPLETED'].includes(order.status)}
              title={hasSold ? undefined : "订单售出后才能配置分润"}
              onClick={(event) => { event.stopPropagation(); void openAllocations(order); }}
            >分润配置</PermissionButton>
            <PermissionButton
              permission="order.event.post"
              type="link"
              size="small"
              disabled={!['ACTIVE', 'INSTALLMENT', 'COMPLETED'].includes(order.status)}
              onClick={(event) => { event.stopPropagation(); void openRefund(order); }}
            >资金收支</PermissionButton>
            <Dropdown
              trigger={["click"]}
              placement="bottomLeft"
              onOpenChange={(open) => {
                if (open && order.account_id) void loadLedgerDetail(order.account_id);
              }}
              menu={{
                className: "orders-ledger-operation-menu",
                items: operationItems,
                onClick: ({ key, domEvent }) => {
                  domEvent.stopPropagation();
                  if (key === "consignment") void openOrderConsignment(order);
                  if (key === "offsale") void openOrderOffsale(order);
                  if (key === "description") void openOrderProfile(order, "description");
                  if (key === "images") void openOrderProfile(order, "images");
                },
              }}
            >
              <PermissionButton
                permission="order.create"
                type="link"
                size="small"
                aria-label="运营"
                onClick={(event) => event.stopPropagation()}
              >运营</PermissionButton>
            </Dropdown>
            <PermissionButton
              permission="order.event.post"
              type="link"
              size="small"
              disabled={!order.account_id}
              onClick={(event) => { event.stopPropagation(); void openOrderRebate(order); }}
            >返点</PermissionButton>
            {!canSystemOffsale ? <PermissionButton
              permission="order.event.post"
              type="link"
              size="small"
              danger
              disabled={!['ACTIVE', 'INSTALLMENT', 'COMPLETED'].includes(order.status)}
              onClick={(event) => { event.stopPropagation(); void openCancelTransaction(order); }}
            >取消</PermissionButton> : null}
          </PermissionGate>
          {canDeleteOrder ? (
            <PermissionButton
              permission="order.update"
              type="link"
              size="small"
              danger
              onClick={(event) => { event.stopPropagation(); void openOrderDelete(order); }}
            >删除</PermissionButton>
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
