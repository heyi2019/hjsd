import { Spin, Typography } from "antd";
import type { FormInstance } from "antd";
import { useMemo } from "react";
import type { AccountExecutionDetail, AccountExecutionEvent } from "../../../shared/api/types/account-execution";
import type { Account } from "../../../shared/api/types/accounts";
import type { EmployeeOption } from "../../../shared/api/types/org";
import type { Pool } from "../../../shared/api/types/finance";
import { formatDateTimeMinute } from "../../../shared/lib/format";
import { currentDevUser } from "../../../shared/api/client";
import { useOptionSetResource } from "../../../shared/lib/optionSets";
import { useGameReferences } from "../../../shared/hooks/useGameReferences";
import { ErrorBanner } from "../../../shared/ui";
import {
  INVENTORY_STATUS_LABEL,
  BUSINESS_MODE_LABEL,
  BUSINESS_TYPE_LABEL,
  VALUE_ADDED_SERVICE_LABEL,
} from "../../../shared/lib/labels";
import { OrderDetailView } from "./OrderDetailView";
import { OrderAttachments } from "./OrderAttachments";
import { ImageOriginalContext } from "./imageOriginalContext";
import { ordersApi } from "../../../shared/api/orders.api";
import {
  type OrderEventDraft,
  type OrderOperationDraft,
  type OrderDetailMeta,
  type OrderPartyLink,
  type OrderFinanceRow,
  PARTY_ROLE_LABEL,
  OPERATION_TYPE_BY_KEY,
} from "./OrderDetail.shared";
import type { FinanceDraft } from "./editing/editor-types";
import type { OrderDraft } from "./editing/editor-types";
import type { PartyAddition } from "./editing/editor-types";

function renderOrderParties(
  parties: OrderPartyLink[],
  onPartyClick?: (party: OrderPartyLink) => void,
): React.ReactNode {
  if (!parties.length) return "-";
  return <span>{parties.map((party, index) => (
    <span key={`${party.entityType}:${party.id}:${party.role}`}>
      {onPartyClick ? <Typography.Link
        href="#"
        onClick={(event) => {
          event.preventDefault();
          onPartyClick(party);
        }}
      >
        {party.entityType === "customer" ? "客户" : "合作方"}_{PARTY_ROLE_LABEL[party.role] ?? party.role}：{party.display_name}
      </Typography.Link> : <span>{party.entityType === "customer" ? "客户" : "合作方"}_{PARTY_ROLE_LABEL[party.role] ?? party.role}：{party.display_name}</span>}
      {index < parties.length - 1 ? "、" : null}
    </span>
  ))}</span>;
}

export function groupOperationEvents(events: AccountExecutionEvent[]): Record<string, AccountExecutionEvent[]> {
  const entries = Object.entries(OPERATION_TYPE_BY_KEY);
  const groups: Record<string, AccountExecutionEvent[]> = Object.fromEntries(entries.map(([key]) => [key, []]));
  const keyByType = new Map(entries.map(([key, type]) => [type, key]));
  for (const event of events) {
    if (event.event_type !== "OPERATE" || !event.operation_type) continue;
    const key = keyByType.get(event.operation_type);
    if (key) groups[key].push(event);
  }
  for (const rows of Object.values(groups)) {
    rows.sort((left, right) => String(right.occurred_at ?? "").localeCompare(String(left.occurred_at ?? "")));
  }
  return groups;
}

export function OrderDetail({
  row,
  detail,
  contextOrderId,
  loading,
  editing,
  eventDrafts,
  operationDrafts,
  onEventEdit,
  onOperationEdit,
  onAddOperationRow,
  onRemoveOperationRow,
  financeDrafts,
  onFinanceEdit,
  onProfileChange,
  orderDrafts,
  onOrderEdit,
  onOrderExtraChange,
  onPartyEdit,
  onPartyClick,
  employees = [],
  pools = [],
  operatorUsername = currentDevUser(),
  extraForm,
  onSave,
  onCancel,
  saving,
}: {
  row: Account;
  detail?: AccountExecutionDetail;
  /** 详情展开的订单主键；传入后所有操作、资金、分润只取这一单。 */
  contextOrderId?: number | null;
  loading: boolean;
  editing?: Account | null;
  eventDrafts?: Record<number, OrderEventDraft>;
  operationDrafts?: Partial<Record<string, OrderOperationDraft>>;
  onEventEdit?: (event: AccountExecutionEvent, changes: { amount?: string; note?: string | null; occurred_at?: string; form_extra?: Record<string, unknown>; operator_user_ids?: number[] }) => void;
  onOperationEdit?: (key: string, changes: Partial<OrderOperationDraft>) => void;
  onAddOperationRow?: (operationType: NonNullable<OrderOperationDraft["operation_type"]>) => void;
  onRemoveOperationRow?: (key: string) => void;
  financeDrafts?: Record<string, FinanceDraft>;
  onFinanceEdit?: (flowNo: string, changes: Partial<Omit<FinanceDraft, "flow_no">>) => void;
  onProfileChange?: (changes: Partial<Account>) => void;
  orderDrafts?: Record<number, OrderDraft>;
  onOrderEdit?: (orderId: number, changes: Partial<Omit<OrderDraft, "order_id">>) => void;
  onOrderExtraChange?: (orderId: number, key: string, value: unknown) => void;
  onPartyEdit?: (orderId: number, addition: PartyAddition) => void;
  employees?: EmployeeOption[];
  pools?: Pool[];
  operatorUsername?: string;
  onPartyClick?: (party: OrderPartyLink) => void;
  extraForm?: FormInstance;
  onSave?: () => void;
  onCancel?: () => void;
  saving?: boolean;
}) {
  const optionSets = useOptionSetResource("INTERMEDIARY_PLATFORM", Boolean(editing));
  const { gameLabel, channelLabel } = useGameReferences();
  // 展开详情是订单级：即便调用方误传了账号聚合快照，这里也再次按订单主键收口，
  // 防止同一账号的寄售/回收/提号订单串入当前订单的资金、分润和操作明细。
  const scopedDetail = useMemo(
    () => detail && contextOrderId != null
      ? { ...detail, orders: detail.orders.filter((order) => order.order_id === contextOrderId) }
      : detail,
    [detail, contextOrderId],
  );
  const contextOrder = useMemo(
    () => scopedDetail?.orders.find((order) => order.order_id === contextOrderId),
    [scopedDetail, contextOrderId],
  );
  const sourceOrderNo = contextOrder?.order_no ?? row.source_order_no;
  const accountSnapshot = editing ?? scopedDetail?.account ?? row;

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
  const validTotal = (value: unknown) => typeof value === "string" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()) ? value : null;
  const totalExpense = validTotal(summary?.total_expense);
  const totalIncome = validTotal(summary?.total_income);

  const financeRows = useMemo<OrderFinanceRow[]>(() => (detailView?.finance_rows ?? []).map((row) => ({
    key: row.key,
    flowNo: row.flow_no,
    type: row.type,
    direction: row.direction === "支出" ? "支出" : "收入",
    amount: row.amount,
    occurredAt: formatDateTimeMinute(row.occurred_at),
    poolId: row.pool_id,
    poolName: row.pool_name,
    note: row.note,
    operator: row.operator,
    operatorUserIds: row.operator_user_ids,
    event: row.event_id == null ? undefined : eventById.get(row.event_id),
  })), [detailView, eventById]);

  const executionRows = useMemo(() => (detailView?.execution_rows ?? []).map((row) => ({
    key: row.key,
    orderId: row.order_id,
    category: row.category,
    action: row.action,
    occurredAt: formatDateTimeMinute(row.occurred_at),
    amount: row.amount ?? "-",
    operator: row.operator,
    note: row.note,
    platform: row.platform,
    operatorUserIds: row.operator_user_ids,
    event: row.event_id == null ? undefined : eventById.get(row.event_id),
  })), [detailView, eventById]);
  const operationRows = useMemo(() => (detailView?.operation_rows ?? []).map((operation) => ({
    ...operation,
    event: operation.event_id == null ? undefined : eventById.get(operation.event_id),
  })), [detailView, eventById]);
  const operationEvents = useMemo(
    () => groupOperationEvents((scopedDetail?.orders ?? []).flatMap((order) => order.events)),
    [scopedDetail],
  );
  const operationRow = (key: string) => operationRows.find((item) => item.key === key);

  const meta = useMemo<OrderDetailMeta>(() => ({
    orderId: contextOrder?.order_id,
    inventoryNo: row.stock_no ?? "-",
    status: row.status,
    statusLabel: INVENTORY_STATUS_LABEL[row.status] ?? row.status,
    gameType: contextOrder?.game_type_label || (accountSnapshot.game_type ? gameLabel(accountSnapshot.game_type) : null),
    gameAccount: accountSnapshot.game_account ?? null,
    campAccount: accountSnapshot.camp_account ?? null,
    cost: accountSnapshot.cost_amount ?? null,
    businessMode: accountSnapshot.business_mode ? (BUSINESS_MODE_LABEL[accountSnapshot.business_mode] ?? accountSnapshot.business_mode) : null,
    inventoryType: accountSnapshot.inventory_type ? (BUSINESS_TYPE_LABEL[accountSnapshot.inventory_type] ?? accountSnapshot.inventory_type) : null,
    valueAddedService: accountSnapshot.value_added_service ? (VALUE_ADDED_SERVICE_LABEL[accountSnapshot.value_added_service] ?? accountSnapshot.value_added_service) : null,
    orderNo: contextOrder?.order_no ?? row.source_order_no ?? "-",
    sourceOrderNo: sourceOrderNo ?? null,
    createdBy: accountSnapshot.created_by || "-",
    registeredAt: formatDateTimeMinute(contextOrder?.created_at ?? contextOrder?.trade_date ?? accountSnapshot.created_at),
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
    password: accountSnapshot.game_password || "-",
    channelRegion: contextOrder?.channel_region_label || (accountSnapshot.channel_region ? channelLabel(accountSnapshot.channel_region) : "-"),
    boundPhone: accountSnapshot.bound_phone || "-",
    secondary: accountSnapshot.has_secondary == null ? "-" : accountSnapshot.has_secondary ? "有" : "无",
    walletRealname: accountSnapshot.wallet_realname === "Y" ? "已注销" : accountSnapshot.wallet_realname === "N" ? "未注销" : accountSnapshot.wallet_realname || "-",
    walletRealnameImages: accountSnapshot.wallet_realname_images ?? [],
    accountDescription: accountSnapshot.account_description || "-",
    accountImages: accountSnapshot.account_images ?? [],
    secondaryImages: accountSnapshot.secondary_images ?? [],
    note: accountSnapshot.note || "-",
    orderNotes: detailView?.order_notes ?? "-",
    orderParties: renderOrderParties((detailView?.parties ?? []).map((party) => ({ ...party, entityType: party.entity_type === "customer" ? "customer" as const : "counterparty" as const })), onPartyClick),
    orderExtras: detailView?.extras ?? [],
  }), [accountSnapshot, row.stock_no, row.status, row.source_order_no, scopedDetail, detailView, contextOrder, sourceOrderNo, onPartyClick, operationRows, gameLabel, channelLabel]);

  if (loading && !detail) return <Spin size="small" />;

  const previewOrderId = contextOrderId ?? scopedDetail?.orders[0]?.order_id;
  return (
    <ImageOriginalContext.Provider value={scopedDetail?.image_previews && previewOrderId != null && !editing
      ? (field, index) => ordersApi.executionImage(previewOrderId, field, index, scopedDetail.image_versions?.[field]?.[index]) : null}>
    <ErrorBanner error={optionSets.error} onRetry={optionSets.retry} retrying={optionSets.loading} />
    <OrderDetailView
      meta={meta}
      detail={scopedDetail}
      account={accountSnapshot}
      editing={editing}
      eventDrafts={eventDrafts}
      operationDrafts={operationDrafts}
      onEventEdit={onEventEdit}
      onOperationEdit={onOperationEdit}
      onAddOperationRow={onAddOperationRow}
      onRemoveOperationRow={onRemoveOperationRow}
      financeDrafts={financeDrafts}
      onFinanceEdit={onFinanceEdit}
      onProfileChange={onProfileChange}
      orderDrafts={orderDrafts}
      onOrderEdit={onOrderEdit}
      onOrderExtraChange={onOrderExtraChange}
      onPartyEdit={onPartyEdit}
      employees={employees}
      pools={pools}
      operatorUsername={operatorUsername}
      executionRows={executionRows}
      operationEvents={operationEvents}
      financeRows={financeRows}
      expenseCount={expenseFlows.length}
      incomeCount={incomeFlows.length}
      totalExpense={totalExpense}
      totalIncome={totalIncome}
      extraForm={extraForm}
      onSave={onSave}
      onCancel={onCancel}
      saving={saving}
    />
    {contextOrder?.order_no && !editing ? <OrderAttachments orderNo={contextOrder.order_no} /> : null}
    </ImageOriginalContext.Provider>
  );
}
