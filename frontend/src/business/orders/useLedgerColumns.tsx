import { Dropdown, Space } from "antd";
import type { ColumnsType } from "antd/es/table";
import { markMobileHiddenColumns, markMobileIdentityColumn, useListViewColumns } from "../../shared/lib/listColumns";
import type { AccountExecutionDetail } from "../../shared/api/types/account-execution";
import type { Order } from "../../shared/api/types/orders";
import { ACCOUNT_STATUS_LABEL, formatDateTimeMinute, formatElapsedTime, money } from "../../shared/lib/format";
import { PermissionButton, StatusTag } from "../../shared/ui";
import { authorizedOrderOperationItems, orderOperationMenuItems } from "../shared/operations";
import { inventoryTypeOfOrder } from "../inventory/InventoryPanel/types";
import { BUSINESS_MODE_LABEL, INVENTORY_TYPE_LABEL } from "../shared/inventory/inventory-logic";
import { formatOrderAmount } from "./helpers";
import { useSession } from "../../shared/state/session";
import { useGameReferences } from "../../shared/hooks/useGameReferences";

/**
 * 订单台账列定义域：库存共享字段与订单字段的渲染配置 + 配置中心列排序 + 移动端隐藏编排。
 * 弹窗动作由调用方传入，本模块负责列展示与点击转发。
 */
export function useLedgerColumns(params: {
  ledgerDetails: Record<number, AccountExecutionDetail>;
  loadLedgerDetail: (order: Pick<Order, "id" | "account_id">, force?: boolean) => Promise<void>;
  openLedgerEditor: (order: Order) => void;
  openAllocations: (order: Order) => void;
  openRefund: (order: Order) => void;
  openOrderProfile: (order: Order, mode: "description" | "images") => void;
  openOrderRebate: (order: Order) => void;
  openOrderSale: (order: Order) => void;
  openOrderConsignment: (order: Order) => void;
  openCancelTransaction: (order: Order) => void;
  openOrderOffsale: (order: Order) => void;
}) {
  const {
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
  } = params;
  const { can } = useSession();
  const { gameLabel } = useGameReferences();
  const canSell = can("order.create") && (can("order.event.post") || can("finance.order.event.post"));
  const { arrange: arrangeLedgerColumns } = useListViewColumns("LEDGER");
  const ledgerColumns: ColumnsType<Order> = [
    { title: "库存编号", dataIndex: "stock_no", width: "var(--col-w-86)", ellipsis: true, render: (v: string | null) => v || "-" },
    { title: "订单号", dataIndex: "order_no", width: "var(--col-w-80)", ellipsis: true },
    { title: "入库时间", dataIndex: "inventory_entry_at", width: 132, ellipsis: true, render: (v: string | null) => formatDateTimeMinute(v) },
    { title: "入库操作人", dataIndex: "inventory_operator", width: "var(--col-w-100)", ellipsis: true, render: (v: string | null) => v || "-" },
    { title: "成本", dataIndex: "cost_amount", width: "var(--col-w-90)", ellipsis: true, render: (_v: string | null, order) => order.cost_amount != null ? `¥${money(order.cost_amount)}` : "-" },
    { title: "游戏/产品类型", dataIndex: "account_game_type", width: "var(--col-w-80)", ellipsis: true, render: (v: string | null, row) => row.account_game_type_label || (v ? gameLabel(v) : "-") },
    { title: "游戏账号/产品", dataIndex: "account_game_account", width: "var(--col-w-120)", ellipsis: true, render: (v: string | null) => v || "-" },
    { title: "业务", key: "business_mode", width: "var(--col-w-60)", ellipsis: true, render: (_v, order) => order.account_business_mode ? BUSINESS_MODE_LABEL[order.account_business_mode] ?? order.account_business_mode : "-" },
    { title: "业务类型", key: "inventory_type", width: "var(--col-w-70)", ellipsis: true, render: (_v, order) => {
      const inventoryType = inventoryTypeOfOrder(order);
      return inventoryType ? INVENTORY_TYPE_LABEL[inventoryType] ?? inventoryType : "-";
    } },
    { title: "售卖时间", dataIndex: "sale_at", width: 132, ellipsis: true, render: (v: string | null) => formatDateTimeMinute(v) },
    { title: "售卖操作人", dataIndex: "sale_operator", width: "var(--col-w-100)", ellipsis: true, render: (v: string | null) => v || "-" },
    { title: "售出金额", dataIndex: "sale_amount", width: "var(--col-w-90)", ellipsis: true, render: (_v: string | null, order) => formatOrderAmount(order) },
    { title: "在手时间", key: "in_hand_time", width: "var(--col-w-80)", ellipsis: true, render: (_v, order) => order.in_hand_time ?? formatElapsedTime(order.inventory_entry_at, order.sale_at) },
    { title: "订单状态", dataIndex: "status", width: "var(--col-w-80)", ellipsis: true, render: (v: string) => <StatusTag status={v} optionSet="ORDER_STATUS" /> },
    { title: "库存状态", dataIndex: "account_status", width: "var(--col-w-80)", ellipsis: true, render: (v: string | null) => v ? <StatusTag status={v} label={ACCOUNT_STATUS_LABEL[v] ?? v} /> : "-" },
    { title: "利润", dataIndex: "profit_base", width: "var(--col-w-90)", ellipsis: true, render: (_v: string | null, order) => order.account_status === "SOLD" && order.profit_base != null ? `¥${money(order.profit_base)}` : "-" },
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
        const operationItems = authorizedOrderOperationItems(orderOperationMenuItems(
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
        ), can);
        return (
          <Space size={4} className="orders-ledger-actions">
            {canSell ? <PermissionButton
              permission="order.create"
              type="link"
              size="small"
              disabled={order.account_status !== "WAITING" || !order.account_id}
              onClick={(event) => { event.stopPropagation(); void openOrderSale(order); }}
            >售出</PermissionButton> : null}
            {operationItems.length > 0 ? <Dropdown
              trigger={["click"]}
              placement="bottomLeft"
              onOpenChange={(open) => {
                // 与库存中心对齐：每次展开运营菜单都强制刷新详情，避免账台缓存的旧寄售记录
                // 让「下架」入口在别处登记寄售后仍不显示。
                if (open && order.account_id) void loadLedgerDetail(order, true);
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
                permission="order.event.post"
                type="link"
                size="small"
                aria-label="运营"
                onClick={(event) => event.stopPropagation()}
              >运营</PermissionButton>
            </Dropdown> : null}
            <PermissionButton
              permission="order.event.post"
              type="link"
              size="small"
              disabled={!order.account_id}
              onClick={(event) => { event.stopPropagation(); void openOrderRebate(order); }}
            >返点</PermissionButton>
            <PermissionButton
              permission="order.event.post"
              type="link"
              size="small"
              disabled={!['ACTIVE', 'INSTALLMENT', 'COMPLETED'].includes(order.status)}
              onClick={(event) => { event.stopPropagation(); void openRefund(order); }}
            >资金收支</PermissionButton>
            <PermissionButton
              permission="order.event.post"
              type="link"
              size="small"
              disabled={!hasSold || !['ACTIVE', 'INSTALLMENT', 'COMPLETED'].includes(order.status)}
              title={hasSold ? undefined : "订单售出后才能配置分润"}
              onClick={(event) => { event.stopPropagation(); void openAllocations(order); }}
            >分润配置</PermissionButton>
            {order.account_id || ["ACTIVE", "INSTALLMENT"].includes(order.status) ? (
              <PermissionButton
                permission="order.update"
                type="link"
                size="small"
                title={order.account_id ? undefined : "未关联库存时会先生成库存编号"}
                onClick={(event) => { event.stopPropagation(); void openLedgerEditor(order); }}
              >编辑</PermissionButton>
            ) : null}
            {!canSystemOffsale ? <PermissionButton
              permission="order.event.post"
              type="link"
              size="small"
              danger
              disabled={!['ACTIVE', 'INSTALLMENT', 'COMPLETED'].includes(order.status)}
              onClick={(event) => { event.stopPropagation(); void openCancelTransaction(order); }}
            >取消</PermissionButton> : null}
          </Space>
        );
      },
    },
  ];
  // 列编排（配置过滤/排序 + 移动端标记）收敛到此处，只 arrange 一次；
  // 调用方直接用 visibleLedgerColumns，不再重复编排（原先 hook 内 arrange 一次、
  // Panel 内又 arrange + 两次 mark，共四次全列变换）。保持此处编排可随 config
  // 响应式重算，设置页改列配置后仍即时生效。
  const arranged = arrangeLedgerColumns(ledgerColumns);
  const visibleLedgerColumns = markMobileIdentityColumn(
    markMobileHiddenColumns(arranged, LEDGER_MOBILE_HIDDEN_KEYS),
    "order_no",
  );
  return { visibleLedgerColumns };
}

/** ≤640px 隐藏列：原规则写 nth-child(4)，但表格有展开列占位，实测命中的是
 *  「游戏账号/产品」而非入库操作人。保持默认隐藏目标不变，只把序号换成稳定 key，
 *  避免「设置 → 列表字段」过滤/调序后隐藏错列。 */
const LEDGER_MOBILE_HIDDEN_KEYS = ["account_game_account"] as const;
