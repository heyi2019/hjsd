import { Spin, Typography } from "antd";
import type { FormInstance } from "antd";
import { useMemo } from "react";
import type { AccountExecutionDetail, AccountExecutionEvent } from "../shared/api/types/account-execution";
import type { Account } from "../shared/api/types/accounts";
import type { EmployeeOption } from "../shared/api/types/org";
import { formatDateTimeMinute } from "../shared/lib/format";
import {
  STATUS_LABEL,
  BUSINESS_MODE_LABEL,
  INVENTORY_TYPE_LABEL,
  VALUE_ADDED_SERVICE_LABEL,
} from "./inventory-logic";
import { OrderDetailView } from "./OrderDetailView/OrderDetailView";
import {
  type InventoryEventDraft,
  type OrderDetailMeta,
  type InventoryPartyLink,
  type InventoryFinanceRow,
  PARTY_ROLE_LABEL,
} from "./OrderDetailView/OrderDetail.shared";

function renderOrderParties(
  parties: InventoryPartyLink[],
  onPartyClick?: (party: InventoryPartyLink) => void,
): React.ReactNode {
  if (!parties.length) return "-";
  return <span>{parties.map((party, index) => (
    <span key={`${party.entityType}:${party.id}:${party.role}`}>
      <Typography.Link
        href="#"
        onClick={(event) => {
          event.preventDefault();
          onPartyClick?.(party);
        }}
      >
        {party.entityType === "customer" ? "客户" : "合作方"}_{PARTY_ROLE_LABEL[party.role] ?? party.role}：{party.display_name}
      </Typography.Link>
      {index < parties.length - 1 ? "、" : null}
    </span>
  ))}</span>;
}

export function OrderDetail({
  row,
  detail,
  contextOrderId,
  loading,
  editing,
  eventDrafts,
  onEventEdit,
  onPartyClick,
  employees = [],
  extraForm,
  onSave,
  onCancel,
  saving,
  timeShiftMinutes,
  onTimeShift,
}: {
  row: Account;
  detail?: AccountExecutionDetail;
  /** 详情展开的订单主键；传入后所有操作、资金、分润只取这一单。 */
  contextOrderId?: number | null;
  loading: boolean;
  editing?: Account | null;
  eventDrafts?: Record<number, InventoryEventDraft>;
  onEventEdit?: (event: AccountExecutionEvent, changes: { amount?: string; note?: string | null; operator_user_ids?: number[] }) => void;
  employees?: EmployeeOption[];
  onPartyClick?: (party: InventoryPartyLink) => void;
  extraForm?: FormInstance;
  onSave?: () => void;
  onCancel?: () => void;
  saving?: boolean;
  /** 编辑态时间联动：平移天数与 setter。 */
  timeShiftMinutes?: number;
  onTimeShift?: (days: number) => void;
}) {
  // 展开详情是订单级：即便调用方误传了账号聚合快照，这里也再次按订单主键收口，
  // 防止同一账号的寄售/回收/提号订单串入当前订单的资金、分润和操作明细。
  const scopedDetail = useMemo(
    () => detail && contextOrderId != null
      ? { ...detail, orders: detail.orders.filter((order) => order.order_id === contextOrderId) }
      : detail,
    [detail, contextOrderId],
  );
  const contextOrder = useMemo(
    () => scopedDetail?.orders.find((order) => order.order_id === contextOrderId) ?? scopedDetail?.orders[0],
    [scopedDetail, contextOrderId],
  );
  const sourceOrderNo = contextOrder?.order_no ?? row.source_order_no;

  const detailView = scopedDetail?.detail_view;
  const eventById = useMemo(
    () => new Map((scopedDetail?.orders ?? []).flatMap((order) => order.events).map((event) => [event.id, event] as const)),
    [scopedDetail],
  );
  const expenseFlows = useMemo(
    () => detailView?.finance_rows.filter((row) => row.direction === "支出") ?? [],
    [detailView],
  );
  const incomeFlows = useMemo(
    () => detailView?.finance_rows.filter((row) => row.direction === "收入") ?? [],
    [detailView],
  );
  // 合计一律取后端 finance_summary（与上面明细同源），前端只数条数、不再累加金额。
  const summary = scopedDetail?.finance_summary;
  const totalExpense = summary?.total_expense ?? "0.00";
  const totalIncome = summary?.total_income ?? "0.00";

  const financeRows = useMemo<InventoryFinanceRow[]>(() => (detailView?.finance_rows ?? []).map((row) => ({
    key: row.key,
    type: row.type,
    direction: row.direction === "支出" ? "支出" : "收入",
    amount: row.amount,
    occurredAt: formatDateTimeMinute(row.occurred_at),
    poolName: row.pool_name,
    operator: row.operator,
    event: row.event_id == null ? undefined : eventById.get(row.event_id),
  })), [detailView, eventById]);

  const executionRows = useMemo(() => (detailView?.execution_rows ?? []).map((row) => ({
    key: row.key,
    category: row.category,
    action: row.action,
    occurredAt: formatDateTimeMinute(row.occurred_at),
    amount: row.amount ?? "-",
    operator: row.operator,
    note: row.note,
    platform: row.platform,
    event: row.event_id == null ? undefined : eventById.get(row.event_id),
  })), [detailView, eventById]);
  const operationRows = detailView?.operation_rows ?? [];
  const operationRow = (key: string) => operationRows.find((item) => item.key === key);

  const meta = useMemo<OrderDetailMeta>(() => ({
    inventoryNo: row.stock_no ?? "-",
    status: row.status,
    statusLabel: STATUS_LABEL[row.status] ?? row.status,
    gameType: row.game_type ?? null,
    gameAccount: row.game_account ?? null,
    campAccount: row.camp_account ?? null,
    platform: row.platform ?? null,
    cost: row.cost_amount ?? null,
    businessMode: row.business_mode ? (BUSINESS_MODE_LABEL[row.business_mode] ?? row.business_mode) : null,
    inventoryType: row.inventory_type ? (INVENTORY_TYPE_LABEL[row.inventory_type] ?? row.inventory_type) : null,
    valueAddedService: row.value_added_service ? (VALUE_ADDED_SERVICE_LABEL[row.value_added_service] ?? row.value_added_service) : null,
    orderNo: contextOrder?.order_no ?? scopedDetail?.orders[0]?.order_no ?? row.source_order_no ?? "-",
    sourceOrderNo: sourceOrderNo ?? null,
    createdBy: row.created_by || "-",
    registeredAt: formatDateTimeMinute(contextOrder?.created_at ?? contextOrder?.trade_date ?? scopedDetail?.orders[0]?.created_at ?? scopedDetail?.orders[0]?.trade_date ?? row.created_at),
    soldAt: formatDateTimeMinute(detailView?.lifecycle.sold_at),
    removedAt: formatDateTimeMinute(detailView?.lifecycle.removed_at),
    removedPlatform: detailView?.lifecycle.removed_platform ?? "-",
    recoveryPlatform: detailView?.lifecycle.recovery_platform ?? "-",
    salePlatform: detailView?.lifecycle.sale_platform ?? "-",
    listedPlatform: operationRow("consignment")?.content ?? "-",
    listedAt: formatDateTimeMinute(operationRow("consignment")?.occurred_at),
    listedOperator: operationRow("consignment")?.operator ?? "-",
    unlistedPlatform: operationRow("unlist")?.content ?? "-",
    unlistedAt: formatDateTimeMinute(operationRow("unlist")?.occurred_at),
    unlistedOperator: operationRow("unlist")?.operator ?? "-",
    descriptionAt: formatDateTimeMinute(operationRow("description")?.occurred_at),
    descriptionOperator: operationRow("description")?.operator ?? "-",
    imagesAt: formatDateTimeMinute(operationRow("images")?.occurred_at),
    imagesOperator: operationRow("images")?.operator ?? "-",
    password: row.game_password || "-",
    channelRegion: [row.platform, row.channel_region].filter(Boolean).join(" / ") || "-",
    boundPhone: row.bound_phone || "-",
    secondary: row.has_secondary == null ? "-" : row.has_secondary ? "有" : "无",
    walletRealname: row.wallet_realname || "-",
    walletRealnameImages: row.wallet_realname_images ?? [],
    accountDescription: row.account_description || "-",
    accountImages: row.account_images ?? [],
    secondaryImages: row.secondary_images ?? [],
    note: row.note || "-",
    orderNotes: detailView?.order_notes ?? "-",
    orderParties: renderOrderParties((detailView?.parties ?? []).map((party) => ({ ...party, entityType: party.entity_type === "customer" ? "customer" as const : "counterparty" as const })), onPartyClick),
    orderExtras: detailView?.extras ?? [],
  }), [row, scopedDetail, detailView, contextOrder, sourceOrderNo, onPartyClick, operationRows]);

  if (loading && !detail) return <Spin size="small" />;

  return (
    <OrderDetailView
      meta={meta}
      detail={scopedDetail}
      account={row}
      editing={editing}
      eventDrafts={eventDrafts}
      onEventEdit={onEventEdit}
      employees={employees}
      executionRows={executionRows}
      financeRows={financeRows}
      expenseCount={expenseFlows.length}
      incomeCount={incomeFlows.length}
      totalExpense={totalExpense}
      totalIncome={totalIncome}
      extraForm={extraForm}
      onSave={onSave}
      onCancel={onCancel}
      saving={saving}
      timeShiftMinutes={timeShiftMinutes}
      onTimeShift={onTimeShift}
    />
  );
}
