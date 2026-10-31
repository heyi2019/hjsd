import { appMessage } from "../shared/ui/appFeedback";
/** 业务中心：库存中心 + 业务台账 + 分期回款。 */
import { Alert, Card, DatePicker, Dropdown, Form, Input, Segmented, Space, Tabs, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { useCallback, useState } from "react";
import { installmentsApi,
  ordersApi,
  orderTypesApi,
  policyApi,
  employeesApi,
  poolsApi,
  type Installment,
  type Order,
  type OrderType,
  type Pool, } from "../shared/api/catalog";
import { currentDevUser, currentUser, normalizeError } from "../shared/api/client";
import { downloadBlob } from "../shared/api/download";
import { LINK_STATUS_LABEL } from "../shared/lib/labels";
import { executionActionLabel, money, today } from "../shared/lib/format";
import { configurableLabel, useOptionSet } from "../shared/lib/optionSets";
import { requiredMoneyRules, percentRules, moneyRules } from "../shared/lib/validators";
import { useListViewColumns } from "../shared/lib/listColumns";
import { InventoryPanel } from "../stocks/InventoryPanel";
import { InstallmentsPanel } from "../installments/InstallmentsPanel";
import { useReloadOnActive } from "../shared/state/reloadOnActive";
import { DataTable,
  ErrorBanner,
  MoneyInput,
  MoneyText,
  PermissionButton,
  PermissionGate,
  Select,
  StatusTag,
  AdaptiveFormGrid,
  BusinessActionModal,
  BusinessForm, } from "../shared/ui";
import { OrderDetailPane } from "./OrderDetailPane";
import { CreateBusinessModal, type BusinessOrderType } from "./CreateBusinessModal";
import { CfgItem, CustomFieldSection, FieldConfigScope } from "./ConfigurableField";
import { ResponsibleEmployeeSelect } from "./ResponsibleEmployeeSelect";
import { DEFAULT_BUSINESS_CENTER_TAB,
  type BusinessCenterEntryTab,
  type BusinessCenterTab, } from "./businessCenter";

// 订单字段板块常量（ORDER_FIELD_SECTION_LABEL / ORDER_FIELD_SECTION_ORDER）已迁移至 OrderDetailPane。

function MobileOrderList(props: {
  orders: Order[];
  emptyText: string;
  onSelect: (order: Order) => void;
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
            <div><dt>对方 / 来源</dt><dd>{[order.party_name, order.party_source].filter(Boolean).join(" · ") || "-"}</dd></div>
            <div><dt>游戏/产品类型</dt><dd>{order.account_game_type || "-"}</dd></div>
            <div><dt>游戏账号/产品</dt><dd>{order.account_game_account || "-"}</dd></div>
            <div><dt>平台</dt><dd>{order.account_platform || "-"}</dd></div>
            <div><dt>金额</dt><dd>{formatOrderAmount(order)}</dd></div>
            <div><dt>库存状态</dt><dd>{order.account_status || "-"}</dd></div>
            <div><dt>最新动作</dt><dd>{order.last_event_type ? executionActionLabel(order.last_event_type, order.order_type) : "-"}</dd></div>
            <div><dt>日期</dt><dd>{order.trade_date || "-"}</dd></div>
          </dl>
          <PermissionButton permission="order.update" type="link" onClick={() => props.onSelect(order)}>编辑订单</PermissionButton>
        </article>
      ))}
    </div>
  );
}

type BusinessFilterKey = "all" | "HS" | "TH" | "DG" | "DFQ";
type BusinessModeFilterKey = "all" | "SELF" | "DISTRIBUTION";

const BUSINESS_CREATE_ITEMS = [
  { key: "HS", label: "新建回收订单" },
  { key: "TH", label: "新建提号订单" },
  { key: "DG", label: "新建代挂订单" },
  { key: "DFQ", label: "新建代分期订单" },
];

/** 分润弹窗的一行：姓名（员工 id 或 COMPANY）+ 角色 + 比例 + 金额（比例/金额都选填、互斥）。 */
type AllocationFormRow = {
  employee?: number | "COMPANY";
  role?: string;
  allocation_rate?: string;
  allocation_amount?: string;
};

/** 分润表单的纯校验函数（不依赖组件/副作用，供单测矩阵直接覆盖）。
 *  入参 rows 已是「已选员工」过滤结果（组件层已剔除 employee 为空者）。
 *  返回 ok 时带归一化后的 items；返回非 ok 时带与组件一致的报错文案。 */
export type AllocationItem = {
  user_id: number | null;
  role: string;
  allocation_rate: string;
  allocation_amount: string;
};
export type AllocationValidation =
  | { ok: true; items: AllocationItem[] }
  | { ok: false; error: string };

export function validateAllocations(
  rows: AllocationFormRow[],
  orderProfit: string,
): AllocationValidation {
  const items: AllocationItem[] = [];
  let rateTotal = 0;
  let amountTotal = 0;
  for (const row of rows) {
    const rate = String(row.allocation_rate ?? "").trim();
    const amount = String(row.allocation_amount ?? "").trim();
    // 「已填」按数值 > 0 判定：后端回显的 0.00 不算填了比例/金额，
    // 否则金额分润的行会被互斥校验误拦。
    const hasRate = Number(rate) > 0;
    const hasAmount = Number(amount) > 0;
    if (!hasRate && !hasAmount) return { ok: false, error: "每行至少填比例或金额之一" };
    if (hasRate && hasAmount) return { ok: false, error: "同一行不能同时填比例和金额" };
    if (hasRate) rateTotal += Number(rate);
    if (hasAmount) amountTotal += Number(amount);
      items.push({
        user_id: row.employee === "COMPANY" ? null : Number(row.employee),
        role: row.role || "OWNER",
        allocation_rate: hasRate ? rate : "0",
        allocation_amount: hasAmount ? amount : "0",
      });
  }
  // 纯比例分润沿用「合计 100%」；一旦有人填金额，改为金额口径（后端校验不超利润）。
  if (amountTotal === 0 && Math.abs(rateTotal - 100) > 0.001) {
    return { ok: false, error: "按比例分润时合计必须为 100%（也可改用金额）" };
  }
  // 金额口径的前置拦截，与后端 _set_person_allocations 保持一致：
  // 亏损/无利润单不接受金额分润，且金额合计不得超过订单总利润。
  if (amountTotal > 0) {
    const profit = Number(orderProfit);
    if (profit <= 0) return { ok: false, error: "该单当前为亏损或无利润，不能按金额分润，请改用比例" };
    if (amountTotal > profit) {
      return { ok: false, error: `分润金额合计不能超过订单总利润 ${money(orderProfit)}` };
    }
  }
  return { ok: true, items };
}

type CancelFormScope = "ORDERCANC" | "INVREFUND";

function formatOrderAmount(order: Order): string {
  if (order.installment_principal) {
    return `¥${order.installment_paid ?? "0.00"}/${order.installment_principal} · ${order.installment_periods ?? 0}期`;
  }
  return order.event_total ? `¥${money(order.event_total)}` : "-";
}

function orderSearchText(order: Order): string {
  return [
    order.order_no,
    order.account_game_type,
    order.account_game_account,
    order.account_channel_region,
    order.party_name,
    order.party_source,
    order.note,
  ].filter(Boolean).join(" ").toLowerCase();
}

function orderMatchesBusinessMode(order: Order, mode: BusinessModeFilterKey): boolean {
  return mode === "all" || order.business_mode === mode || order.account_business_mode === mode;
}

function filterBusinessOrders(
  orders: Order[],
  type: BusinessFilterKey,
  mode: BusinessModeFilterKey,
  keyword: string,
  link: string,
): Order[] {
  const normalizedKeyword = keyword.trim().toLowerCase();
  return orders.filter((order) => (
    (type === "all" || order.order_type === type)
    && orderMatchesBusinessMode(order, mode)
    && (link === "all" || (order.link_status ?? "LINKED") === link)
    && (!normalizedKeyword || orderSearchText(order).includes(normalizedKeyword))
  ));
}

function countBusinessOrders(orders: Order[], type: BusinessFilterKey, mode: BusinessModeFilterKey, link: string): number {
  return orders.filter((order) => (
    (type === "all" || order.order_type === type)
    && orderMatchesBusinessMode(order, mode)
    && (link === "all" || (order.link_status ?? "LINKED") === link)
  )).length;
}

export function OrdersPage({ initialTab, active = true, onNavigate }: { initialTab?: BusinessCenterEntryTab; active?: boolean; onNavigate?: (key: string, tab?: BusinessCenterEntryTab) => void } = {}) {
  // 当前登录人仅作为历史数据没有指定操作人时的回退显示；新记录以勾选员工为准。
  const currentOperator = currentDevUser();
  const [orders, setOrders] = useState<Order[]>([]);
  const [types, setTypes] = useState<OrderType[]>([]);
  const [loadError, setLoadError] = useState<{ message: string; code?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  // 台账排序：默认最新在前，可切换最旧在前（仅调展示顺序，不动接口）。
  const [ledgerSortDesc, setLedgerSortDesc] = useState(true);
  const [ledgerExporting, setLedgerExporting] = useState(false);
  const exportLedger = async () => {
    setLedgerExporting(true);
    try {
      downloadBlob(await ordersApi.exportCsv(), `业务台账-${today()}.csv`);
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    } finally {
      setLedgerExporting(false);
    }
  };
  const [orderTypeFilter, setOrderTypeFilter] = useState<BusinessFilterKey>("all");
  const [businessModeFilter, setBusinessModeFilter] = useState<BusinessModeFilterKey>("all");
  const [linkStatusFilter, setLinkStatusFilter] = useState<string>("all");
  // 关联状态、业务类型、业务模式和责任方均来自后端选项词典。
  type Opt = { value: string; label: string };
  const linkStatusOptions: Opt[] = useOptionSet("ORDER_LINK_STATUS") ?? [];
  const orderBusinessOptions: Opt[] = useOptionSet("ORDER_BUSINESS") ?? [];
  const orderBusinessModeOptions: Opt[] = useOptionSet("ORDER_BUSINESS_MODE") ?? [];
  const profitRoleOptions: Opt[] = useOptionSet("PROFIT_ROLE") ?? [];
  const [keyword, setKeyword] = useState("");
  const [createType, setCreateType] = useState<BusinessOrderType | undefined>();
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [expandedOrderIds, setExpandedOrderIds] = useState<string[]>([]);
  const handleLedgerExpand = (expanded: boolean, record: Order) => {
    // 手风琴：一次只展开一行，避免多行展开同时挂载多份详情导致 DOM 与页面长度翻倍。
    setExpandedOrderIds(expanded ? [String(record.id)] : []);
  };
  const [cancelOrderTarget, setCancelOrderTarget] = useState<Order | null>(null);
  const [cancelInstallmentTarget, setCancelInstallmentTarget] = useState<Installment | null>(null);
  const [cancelScope, setCancelScope] = useState<CancelFormScope>("ORDERCANC");
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const [cancelPools, setCancelPools] = useState<Pool[]>([]);
  const [cancelEmployees, setCancelEmployees] = useState<Array<{ id: number; username: string; display_name: string; is_active: boolean }>>([]);
  const [cancelForm] = Form.useForm();
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundSubmitting, setRefundSubmitting] = useState(false);
  const [refundForm] = Form.useForm();
  const [allocationOpen, setAllocationOpen] = useState(false);
  const [allocationSubmitting, setAllocationSubmitting] = useState(false);
  const [allocationForm] = Form.useForm();
  /** 订单总利润（后端 order_amounts 口径），负数即亏损单；分润弹窗顶部展示并作为金额分润上限。 */
  const [allocationProfit, setAllocationProfit] = useState<string>("0");
  const [actionOrder, setActionOrder] = useState<Order | null>(null);
  const [users, setUsers] = useState<Array<{ id: number; username: string; display_name: string; is_active: boolean }>>([]);
  // 员工花名册 = 在职用户；另加「公司归属」用来表达留给公司、不绑定人的那部分。
  const employeeOptions = [
    ...users.map((item) => ({
      value: item.id as number | "COMPANY",
      label: `${item.display_name}（${item.username}）`,
    })),
    { value: "COMPANY" as number | "COMPANY", label: "公司（不绑定人员）" },
  ];
  /** 亏损单（总利润 < 0）：顶部提示改口径，金额分润后端也会拒绝。 */
  const allocationIsLoss = Number(allocationProfit) < 0;
  const [editOpen, setEditOpen] = useState(false);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editForm] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, typeList] = await Promise.all([ordersApi.list(), orderTypesApi.list()]);
      setOrders(list);
      setTypes(typeList);
      setLoadError(null);
    } catch (error) {
      setLoadError(normalizeError(error));
    } finally {
      setLoading(false);
    }
  }, []);

  const openAllocations = async (sourceOrder?: Order) => {
    try {
      const order = sourceOrder ? await ordersApi.get(sourceOrder.id) : selectedOrder;
      if (!order) return;
      const [result, userResult] = await Promise.all([
        policyApi.allocations(order.id),
        employeesApi.list(),
      ]);
      setActionOrder(order);
      setUsers(userResult.filter((item) => item.is_active));
      setAllocationProfit(result.order_profit ?? "0");
      // 分润按「姓名」录入：存量行直接映射成姓名（COMPANY / 无收益人 → 公司归属），
      // 不再暴露 BUY/SELL/OPERATION/COMPANY 四个动作位——那种结构只允许一人拿运营份额。
      // 角色必须原样带回表单：不回填就会在保存时被默认值 OWNER 覆盖掉。
      const rows = result.items.map((item) => ({
        employee: (item.user_id ?? "COMPANY") as number | "COMPANY",
        role: item.role || "OWNER",
        allocation_rate: item.allocation_rate,
        allocation_amount: item.allocation_amount ?? "",
      }));
      allocationForm.setFieldsValue({
        allocations: rows.length > 0 ? rows : [{ employee: undefined, role: "OWNER", allocation_rate: "", allocation_amount: "" }],
      });
      setAllocationOpen(true);
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    }
  };

  const openRefund = async (sourceOrder?: Order) => {
    try {
      const order = sourceOrder ? await ordersApi.get(sourceOrder.id) : selectedOrder;
      if (!order) return;
      const employeeList = await employeesApi.list();
      setUsers(employeeList.filter((employee) => employee.is_active));
      setActionOrder(order);
      refundForm.resetFields();
      setRefundOpen(true);
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    }
  };

  /** 可冲销动作：已过账的 BUY/COST/SELL，按剩余可冲金额过滤（后端支持部分冲销）。 */
  const reversibleEvents = (order: Order | null) => {
    const posted = (order?.events ?? []).filter((event) => event.is_posted);
    const cancelled = new Map<number, number>();
    for (const event of posted) {
      if (event.event_type !== "CANCEL" || event.offset_event_id == null) continue;
      cancelled.set(event.offset_event_id, (cancelled.get(event.offset_event_id) ?? 0) + Number(event.amount || 0));
    }
    return posted
      .filter((event) => ["BUY", "COST", "SELL"].includes(event.event_type))
      .map((event) => {
        const remaining = Number(event.amount || 0) - (cancelled.get(event.id) ?? 0);
        return { event, remaining };
      })
      .filter((item) => item.remaining > 0)
      .reverse();
  };

  const cancelableEventsForScope = (order: Order | null, scope: CancelFormScope) => reversibleEvents(order)
    .filter(({ event }) => scope === "INVREFUND"
      ? ["BUY", "COST"].includes(event.event_type)
      : event.event_type === "SELL");

  const openCancelTransaction = async (sourceOrder?: Order) => {
    try {
      const order = sourceOrder ? await ordersApi.get(sourceOrder.id) : selectedOrder;
      if (!order) return;
      if (order.installment_principal) {
        const contracts = await installmentsApi.list({ order_id: order.id });
        const target = contracts.find((item) => !["CANCELLED", "DELIVERED"].includes(item.status));
        if (!target) {
          appMessage.error("未找到可取消的分期合约");
          return;
        }
        setCancelInstallmentTarget(target);
        setCancelOrderTarget(null);
      } else {
        setCancelOrderTarget(order);
        setCancelInstallmentTarget(null);
        // 先把基础日期和默认冲销动作写入表单，账户/操作人异步加载时弹窗仍可正常提交。
        const reversible = reversibleEvents(order);
        const first = reversible[0];
        const nextScope: CancelFormScope = first && ["BUY", "COST"].includes(first.event.event_type) ? "INVREFUND" : "ORDERCANC";
        setCancelScope(nextScope);
        cancelForm.setFieldsValue({
          cancelled_on: today(),
          offset_event_id: first?.event.id,
          [nextScope === "INVREFUND" ? "refund_amount" : "cancel_amount"]: first ? first.remaining.toFixed(2) : undefined,
          pool_id: first?.event.pool_id ?? undefined,
        });
        const [poolList, employeeList] = await Promise.all([poolsApi.list(), employeesApi.list()]);
        const activeEmployees = employeeList.filter((employee) => employee.is_active);
        setCancelPools(poolList.filter((pool) => pool.status === "ACTIVE"));
        setCancelEmployees(activeEmployees);
        // 先在打开弹窗的加载阶段写入默认操作人，避免依赖 ResponsibleEmployeeSelect
        // 内部的 /auth/me 异步回填；提交动作必须始终携带显式员工 ID。
        if (cancelForm.getFieldValue("operator_user_ids") == null) {
          const defaultEmployee = activeEmployees.find((employee) => employee.username === currentOperator)
            ?? (activeEmployees.length === 1 ? activeEmployees[0] : undefined);
          if (defaultEmployee) cancelForm.setFieldValue("operator_user_ids", [defaultEmployee.id]);
        }
        if (first && cancelForm.getFieldValue("pool_id") == null) {
          cancelForm.setFieldValue("pool_id", poolList[0]?.id);
        }
      }
      if (order.installment_principal) cancelForm.setFieldsValue({ cancelled_on: today() });
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    }
  };

  const closeCancelTransaction = () => {
    setCancelOrderTarget(null);
    setCancelInstallmentTarget(null);
    setCancelScope("ORDERCANC");
    cancelForm.resetFields();
  };

  const openSystemOffsale = () => {
    setActiveTab("inventory");
    setSelectedOrder(null);
  };

  const submitCancelTransaction = async (values: { cancelled_on: string; reason: string; offset_event_id?: number; cancel_amount?: string; refund_amount?: string; pool_id?: number; operator_user_ids?: number[]; form_extra?: Record<string, unknown> }) => {
    const installment = cancelInstallmentTarget;
    const order = cancelOrderTarget;
    if (!installment && !order) return;
    setCancelSubmitting(true);
    try {
      if (installment) {
        const result = await installmentsApi.cancel(installment.id, values);
        const refundSummary = `退款已登记：¥${money(result.refund_amount)}`;
        appMessage.success(
          installment.contract_type === "PICKUP_SALE"
            ? `${refundSummary}，提号交易已结束`
            : installment.contract_type === "ADVANCE_PURCHASE"
              ? `${refundSummary}，代分期交易已结束`
              : `${refundSummary}，账号已回到库存`,
        );
        if (result.order_status === "CANCELLED") await load();
      } else {
        if (!order) return;
        const reversible = cancelableEventsForScope(order, cancelScope);
        const selected = reversible.find((item) => item.event.id === Number(values.offset_event_id)) ?? reversible[0];
        if (selected) {
          const amountValue = cancelScope === "INVREFUND" ? values.refund_amount : values.cancel_amount;
          const amount = (amountValue ?? "").trim() || selected.remaining.toFixed(2);
          if (Number.isNaN(Number(amount)) || Number(amount) <= 0) {
            appMessage.error("请输入有效的冲销金额");
            return;
          }
          if (Number(amount) > selected.remaining + 1e-9) {
            appMessage.error(`冲销金额不能超过该动作剩余可冲金额 ¥${selected.remaining.toFixed(2)}`);
            return;
          }
          // 操作人是业务事实的一部分，不能依赖异步下拉组件恰好先完成默认值注入。
          // 用户直接确认弹窗时，最后一次从当前会话解析员工 ID，确保后端收到显式负责人。
          let operatorUserIds = values.operator_user_ids?.length ? values.operator_user_ids : undefined;
          if (!operatorUserIds?.length) {
            const byDevUser = cancelEmployees.find((employee) => employee.username === currentOperator);
            if (byDevUser) operatorUserIds = [byDevUser.id];
            else {
              try {
                const current = await currentUser();
                const bySessionUser = cancelEmployees.find((employee) => employee.id === current.id || employee.username === current.username);
                if (bySessionUser) operatorUserIds = [bySessionUser.id];
              } catch {
                // 下拉组件已尝试默认当前员工；解析失败时保留空值，让后端按必填规则返回明确错误。
              }
            }
          }
          const result = await ordersApi.postEvent(order.id, {
            event_type: "CANCEL",
            amount,
            occurred_on: values.cancelled_on,
            offset_event_id: selected.event.id,
            pool_id: Number(values.pool_id),
            operator_user_ids: operatorUserIds,
            reason: values.reason,
            note: cancelScope === "INVREFUND" ? "库存取消交易，冲销入库并入账" : "售出取消交易，原路退款",
            form_extra_scope: cancelScope,
            form_extra: values.form_extra,
          });
          appMessage.success(cancelScope === "INVREFUND"
            ? `库存取消交易已登记：入账 ¥${money(result.event.amount)}，已进入公司钱包`
            : `售出取消交易已登记：退款 ¥${money(result.event.amount)}，已按原资金池退还客户`);
        } else {
          await ordersApi.cancel(order.id, { reason: values.reason, form_extra: values.form_extra });
          appMessage.success("交易已取消，无已登记款项需要退款");
        }
        await load();
      }
      closeCancelTransaction();
      setSelectedOrder(null);
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    } finally {
      setCancelSubmitting(false);
    }
  };

  /** 编辑订单：后端限制——已有登记事件的订单只能改备注；账号快照仅 DFQ 可维护，
   *  且密码被后端隐去（无 order.create 权限）时不允许整体回写快照，避免覆盖隐藏密码。 */
  const openEditOrder = (order: Order) => {
    setSelectedOrder(order);
    const snapshot = order.account_snapshot;
    editForm.setFieldsValue({
      trade_date: order.trade_date,
      note: order.note ?? undefined,
      snap_game_account: snapshot?.game_account,
      snap_game_type: snapshot?.game_type ?? undefined,
      snap_game_password: snapshot?.game_password ?? undefined,
      snap_channel_region: snapshot?.channel_region ?? undefined,
      snap_bound_phone: snapshot?.bound_phone ?? undefined,
      snap_platform: snapshot?.platform ?? undefined,
      snap_purchase_price: snapshot?.purchase_price ?? undefined,
      snap_note: snapshot?.note ?? undefined,
    });
    setEditOpen(true);
  };

  const submitEditOrder = async (values: Record<string, unknown>) => {
    if (!selectedOrder) return;
    // 后端规则：已有登记事件的订单只能改备注（核算字段必须走冲销/更正）。
    const orderHasPosted = (selectedOrder.events ?? []).some((event) => event.is_posted);
    setEditSubmitting(true);
    try {
      const payload: Parameters<typeof ordersApi.patch>[1] = {};
      if (!orderHasPosted) payload.trade_date = values.trade_date as string;
      payload.note = (values.note as string | undefined)?.trim() ? (values.note as string).trim() : null;
      payload.form_extra = (values.form_extra as Record<string, unknown> | undefined) ?? undefined;
      const snapshot = selectedOrder.account_snapshot;
      // 仅当快照密码可见（持有 order.create）时才允许整体回写，防止把隐藏密码覆盖为空。
      if (!orderHasPosted && snapshot && snapshot.game_password) {
        payload.account_snapshot = {
          game_account: (values.snap_game_account as string) ?? snapshot.game_account,
          game_type: (values.snap_game_type as string) || null,
          game_password: (values.snap_game_password as string) || null,
          channel_region: (values.snap_channel_region as string) || null,
          bound_phone: (values.snap_bound_phone as string) || null,
          platform: (values.snap_platform as string) || null,
          purchase_price: (values.snap_purchase_price as string) || null,
          note: (values.snap_note as string) || null,
        };
      }
      await ordersApi.patch(selectedOrder.id, payload);
      appMessage.success("订单已更新");
      setEditOpen(false);
      setSelectedOrder(await ordersApi.get(selectedOrder.id));
      await load();
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    } finally {
      setEditSubmitting(false);
    }
  };

  // keep-alive：切走再切回不会重挂载。重新激活（active 翻回 true）时重拉列表，
  // 保证在其他入口新建的订单（工作台快捷建单、库存中心售出/寄售/返点）的订单号及时出现在台账。
  useReloadOnActive(active, load);

  const typeNames = Object.fromEntries(types.map((type) => [type.code, type.name]));
  // 台账展示按最新在前（后端 list_orders 按 id 升序返回，这里只调展示顺序，不动接口）。
  const filteredOrders = filterBusinessOrders(orders, orderTypeFilter, businessModeFilter, keyword, linkStatusFilter)
    .slice()
    .sort((a, b) => (ledgerSortDesc ? b.id - a.id : a.id - b.id));
  // 后端 update_order 规则：已有登记事件的订单只能改备注（orders/service.py）。
  const orderHasPostedEvents = (selectedOrder?.events ?? []).some((event) => event.is_posted);
  const [activeTab, setActiveTab] = useState<BusinessCenterTab>(
    initialTab === "inventory" ? "inventory" : DEFAULT_BUSINESS_CENTER_TAB,
  );
  const [inventoryRefreshKey, setInventoryRefreshKey] = useState(0);
  const [installmentRefreshKey, setInstallmentRefreshKey] = useState(0);

  const { arrange: arrangeLedgerColumns } = useListViewColumns("LEDGER");
  const ledgerColumns: ColumnsType<Order> = [
    { title: "订单号", dataIndex: "order_no" },
    { title: "对方 / 来源", key: "party", render: (_, order) => [order.party_name, order.party_source].filter(Boolean).join(" · ") || "-" },
    { title: "游戏/产品类型", dataIndex: "account_game_type", render: (v: string | null) => v || "-" },
    { title: "游戏账号/产品", dataIndex: "account_game_account", render: (v: string | null) => v || "-" },
    { title: "平台", dataIndex: "account_platform", render: (v: string | null) => v || "-" },
    { title: "金额", dataIndex: "event_total", render: (_v: string | null, order) => formatOrderAmount(order) },
    { title: "库存状态", dataIndex: "account_status", render: (v: string | null) => v ? <StatusTag status={v} optionSet="INVENTORY_STATUS" /> : "-" },
    { title: "最新动作", dataIndex: "last_event_type", render: (v: string | null, order) => v ? `${executionActionLabel(v, order.order_type)}${order.last_event_amount ? ` · ¥${order.last_event_amount}` : ""}` : "-" },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} optionSet="ORDER_STATUS" /> },
    {
      title: "关联",
      dataIndex: "link_status",
      render: (v: string | undefined) => (
        <StatusTag status={v ?? "LINKED"} label={configurableLabel("ORDER_LINK_STATUS", v ?? "LINKED", LINK_STATUS_LABEL)} />
      ),
    },
    { title: "日期", dataIndex: "trade_date" },
    {
      title: "操作",
      key: "actions",
      render: (_, order) => (
        <Space size={2}>
          <PermissionButton permission="order.update" type="link" onClick={() => openEditOrder(order)}>编辑订单</PermissionButton>
          <PermissionGate permission="order.event.post">
            <Dropdown
              trigger={["click"]}
              menu={{
                items: [
                  { key: "allocation", label: "分润", disabled: !["ACTIVE", "COMPLETED"].includes(order.status) },
                  { key: "refund", label: "资金收支", disabled: !["ACTIVE", "COMPLETED"].includes(order.status) },
                  {
                    key: "cancel",
                    label: order.order_type === "DG" ? "系统下架" : "取消交易",
                    danger: true,
                    disabled: !["ACTIVE", "COMPLETED"].includes(order.status),
                  },
                ],
                onClick: ({ key }) => {
                  if (key === "allocation") void openAllocations(order);
                  if (key === "refund") void openRefund(order);
                  if (key === "cancel") {
                    if (order.order_type === "DG") openSystemOffsale();
                    else void openCancelTransaction(order);
                  }
                },
              }}
            >
              <PermissionButton permission="order.event.post" type="link">更多</PermissionButton>
            </Dropdown>
          </PermissionGate>
        </Space>
      ),
    },
  ];

  return (
    <section className="ui-stack orders-page">
      <ErrorBanner error={loadError} onRetry={() => void load()} retrying={loading} />

      <Tabs
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as BusinessCenterTab)}
        tabBarExtraContent={(
          <Dropdown
            menu={{
              items: BUSINESS_CREATE_ITEMS,
              onClick: ({ key }) => setCreateType(key as BusinessOrderType),
            }}
            trigger={["click"]}
          >
            <PermissionButton permission="order.create" type="primary">新建订单</PermissionButton>
          </Dropdown>
        )}
        items={[
          {
            key: "inventory",
            label: "库存中心",
            children: <InventoryPanel refreshKey={inventoryRefreshKey} onOrdersChanged={() => { setInstallmentRefreshKey((key) => key + 1); void load(); }} onNavigate={onNavigate} />,
          },
          {
            key: "ledger",
            label: "业务台账",
            children: (
              <Card className="glass">
                <Space wrap className="ui-filter-bar ui-filter-bar--spaced">
                  <Input
                    allowClear
                    value={keyword}
                    placeholder="搜索订单号 / 游戏账号/产品 / 对方 / 备注"
                    aria-label="搜索订单"
                    className="orders-ledger-search"
                    onChange={(event) => {
                      setKeyword(event.target.value);
                      setPage(1);
                    }}
                  />
                  <Typography.Text strong>类型筛选</Typography.Text>
                  <Segmented
                    value={orderTypeFilter}
                    options={[
                      { value: "all", label: `全部 ${countBusinessOrders(orders, "all", businessModeFilter, linkStatusFilter)}` },
                      ...orderBusinessOptions.map((item) => ({
                        value: item.value,
                        label: `${item.label} ${countBusinessOrders(orders, item.value as BusinessFilterKey, businessModeFilter, linkStatusFilter)}`,
                      })),
                    ]}
                    onChange={(value) => {
                      setOrderTypeFilter(value as BusinessFilterKey);
                      setPage(1);
                    }}
                  />
                  <PermissionButton permission="finance.read" size="small" loading={ledgerExporting} onClick={() => void exportLedger()}>
                    导出 CSV
                  </PermissionButton>
                  <Typography.Text strong>业务筛选</Typography.Text>
                  <Segmented
                    value={businessModeFilter}
                    options={[
                      { value: "all", label: "全部业务" },
                      ...orderBusinessModeOptions.map((item) => ({ value: item.value, label: item.label })),
                    ]}
                    onChange={(value) => {
                      setBusinessModeFilter(value as BusinessModeFilterKey);
                      setPage(1);
                    }}
                  />
                  <Typography.Text strong>关联筛选</Typography.Text>
                  <Select
                    aria-label="关联状态筛选"
                    className="ui-filter-select"
                    value={linkStatusFilter}
                    options={[
                      { value: "all", label: "全部关联状态" },
                      ...linkStatusOptions.map(({ value, label }) => ({ value, label })),
                    ]}
                    onChange={(value) => {
                      setLinkStatusFilter(value);
                      setPage(1);
                    }}
                  />
                  <Typography.Text strong>排序</Typography.Text>
                  <Segmented
                    aria-label="台账排序"
                    value={ledgerSortDesc ? "desc" : "asc"}
                    options={[
                      { value: "desc", label: "最新在前" },
                      { value: "asc", label: "最旧在前" },
                    ]}
                    onChange={(value) => {
                      setLedgerSortDesc(value === "desc");
                      setPage(1);
                    }}
                  />
                  <Typography.Text type="secondary">
                    状态由对应业务流程更新，点击订单后继续处理付款、入库、售出或回款
                  </Typography.Text>
                </Space>
                <DataTable<Order>
                  columns={arrangeLedgerColumns(ledgerColumns)}
                  rows={filteredOrders}
                  loading={loading}
                  page={page}
                  pageSize={pageSize}
                  total={filteredOrders.length}
                  emptyText="暂无业务订单"
                  className="orders-ledger"
                  expandable={{
                    expandedRowKeys: expandedOrderIds,
                    onExpand: handleLedgerExpand,
                    expandedRowRender: (order) => <OrderDetailPane order={order} typeNames={typeNames} />,
                  }}
                  onPageChange={(nextPage, nextSize) => {
                    setPage(nextPage);
                    setPageSize(nextSize);
                  }}
               />
                <MobileOrderList
                  orders={filteredOrders}
                  emptyText="暂无业务订单"
                  onSelect={(order) => openEditOrder(order)}
                />
              </Card>
            ),
          },
          {
            key: "collections",
            label: "分期与回款",
            children: <InstallmentsPanel refreshKey={installmentRefreshKey} />,
          },
        ]}
      />

      <BusinessActionModal
        title={cancelInstallmentTarget ? `分期取消交易 · ${cancelInstallmentTarget.inst_no}` : cancelOrderTarget ? `${cancelScope === "INVREFUND" ? "库存取消交易" : "售出取消交易"} · ${cancelOrderTarget.order_no}` : "取消交易"}
        open={Boolean(cancelOrderTarget || cancelInstallmentTarget)}
        confirmLoading={cancelSubmitting}
        onCancel={closeCancelTransaction}
        okText="确认取消交易"
        okButtonProps={{ danger: true }}
        onOk={() => void cancelForm.submit()}
      >
        <BusinessForm scope={cancelInstallmentTarget ? "INVCANCEL" : cancelScope} form={cancelForm} onFinish={submitCancelTransaction}>
          <FieldConfigScope scope={cancelInstallmentTarget ? "INVCANCEL" : cancelScope} active={Boolean(cancelOrderTarget || cancelInstallmentTarget)}>
          <Typography.Paragraph type="secondary">
            {cancelInstallmentTarget
              ? cancelInstallmentTarget.contract_type === "PICKUP_SALE"
                ? "按已收款原资金池退款，提号取消后交易直接结束。"
                : cancelInstallmentTarget.contract_type === "ADVANCE_PURCHASE"
                  ? "按已收款原资金池退款，取消后终止代分期交易。"
                  : "按已收款原资金池退款，取消后账号回到库存。"
              : cancelScope === "INVREFUND"
                ? "冲销入库流水，金额进入公司钱包；可按原资金池入账，也可做部分冲销。"
                : "冲销售出流水，金额退还客户；可按原资金池退款，也可做部分冲销。"}
          </Typography.Paragraph>
          {cancelOrderTarget && cancelableEventsForScope(cancelOrderTarget, cancelScope).length > 0 ? (
            <div className="order-cancel-meta">
              <CfgItem
                name="offset_event_id"
                label={cancelScope === "INVREFUND" ? "入库流水" : "售出流水"}
                fixedLabel={cancelScope === "INVREFUND" ? "入库流水" : "售出流水"}
                rules={[{ required: true, message: cancelScope === "INVREFUND" ? "请选择入库流水" : "请选择售出流水" }]}
              >
                <Select
                  placeholder={cancelScope === "INVREFUND" ? "请选择入库流水" : "请选择被冲销动作"}
                  options={cancelableEventsForScope(cancelOrderTarget, cancelScope).map(({ event, remaining }) => ({
                    value: event.id,
                    label: `${executionActionLabel(event.event_type, cancelOrderTarget.order_type)} · ${event.event_no} · ¥${money(event.amount)}（剩余可冲 ¥${money(remaining.toFixed(2))}）`,
                  }))}
                  onChange={(value: number) => {
                    const target = cancelableEventsForScope(cancelOrderTarget, cancelScope).find((item) => item.event.id === value);
                    if (target) cancelForm.setFieldsValue({
                      [cancelScope === "INVREFUND" ? "refund_amount" : "cancel_amount"]: target.remaining.toFixed(2),
                      pool_id: target.event.pool_id ?? cancelPools[0]?.id,
                    });
                  }}
                />
              </CfgItem>
              <CfgItem name={cancelScope === "INVREFUND" ? "refund_amount" : "cancel_amount"} label={cancelScope === "INVREFUND" ? "入账金额" : "退款金额"} rules={requiredMoneyRules(cancelScope === "INVREFUND" ? "入账金额" : "退款金额")} tooltip="留空或填剩余可冲金额为全额冲销；小于剩余金额即为部分冲销">
                <MoneyInput aria-label={cancelScope === "INVREFUND" ? "入账金额" : "退款金额"} placeholder={cancelScope === "INVREFUND" ? "请输入入账金额" : "请输入退款金额"} />
              </CfgItem>
              <CfgItem alwaysActive name="pool_id" label={cancelScope === "INVREFUND" ? "入账账户" : "收款账户"} rules={[{ required: true, message: cancelScope === "INVREFUND" ? "请选择入账账户" : "请选择收款账户" }]}>
                <Select placeholder={cancelScope === "INVREFUND" ? "请选择入账账户" : "请选择收款账户"} options={cancelPools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))} notFoundContent="暂无可用资金账户" />
              </CfgItem>
              <ResponsibleEmployeeSelect name="operator_user_ids" label={cancelScope === "INVREFUND" ? "入账操作人" : "退款操作人"} employees={cancelEmployees} className="order-cancel-employee" />
            </div>
          ) : null}
          <CfgItem name="cancelled_on" label="取消日期" rules={[{ required: true, message: "请输入取消日期" }]}>
            <Input placeholder="YYYY-MM-DD" />
          </CfgItem>
          <CfgItem name="reason" label="取消原因" rules={[{ required: true, message: "请输入取消原因" }]}>
            <Input.TextArea rows={3} placeholder="请输入退款及取消原因" />
          </CfgItem>
          <CustomFieldSection testIdSuffix="order-cancel" />
          </FieldConfigScope>
        </BusinessForm>
      </BusinessActionModal>

      <BusinessActionModal
        title={selectedOrder ? `编辑订单 · ${selectedOrder.order_no}` : "编辑订单"}
        open={editOpen}
        confirmLoading={editSubmitting}
        onCancel={() => { if (!editSubmitting) setEditOpen(false); }}
        okText="保存修改"
        onOk={() => void editForm.submit()}
      >
        <BusinessForm scope="ORDEREDIT" form={editForm} onFinish={submitEditOrder}>
          <FieldConfigScope scope="ORDEREDIT" active={editOpen}>
          <Typography.Paragraph type="secondary">
            订单编号、业务类型、账号关联与状态不可编辑；已有登记事件的订单只能修改备注，核算字段须通过冲销/更正处理。
          </Typography.Paragraph>
          <CfgItem
            name="trade_date"
            label="成交日期"
            rules={orderHasPostedEvents ? [] : [{ required: true, message: "请输入成交日期" }]}
            extra={orderHasPostedEvents ? "已有登记事件，成交日期不可修改" : undefined}
          >
            <Input placeholder="YYYY-MM-DD" disabled={orderHasPostedEvents} />
          </CfgItem>
          <CfgItem name="note" label="备注">
            <Input.TextArea rows={2} placeholder="订单备注（选填）" />
          </CfgItem>
          {selectedOrder?.account_snapshot && selectedOrder.order_type === "DFQ" && !orderHasPostedEvents ? (
            selectedOrder.account_snapshot.game_password ? (
              <>
                <Typography.Paragraph type="secondary">账号快照（代分期建单时填写的文本信息）：</Typography.Paragraph>
                <CfgItem name="snap_game_account" label="库存编号" rules={[{ required: true, message: "请输入库存编号" }]}>
                  <Input />
                </CfgItem>
                <CfgItem name="snap_game_type" label="游戏/产品类型"><Input /></CfgItem>
                <CfgItem name="snap_game_password" label="账号密码"><Input placeholder="留空表示清除密码" /></CfgItem>
                <CfgItem name="snap_channel_region" label="区服"><Input /></CfgItem>
                <CfgItem name="snap_bound_phone" label="绑定手机"><Input /></CfgItem>
                <CfgItem name="snap_platform" label="平台"><Input /></CfgItem>
                <CfgItem name="snap_purchase_price" label="号价" rules={moneyRules("号价")}><MoneyInput placeholder="例如 1000.00" /></CfgItem>
                <CfgItem name="snap_note" label="快照备注"><Input.TextArea rows={2} /></CfgItem>
              </>
            ) : (
              <Typography.Paragraph type="secondary">账号快照密码字段无权查看，为避免覆盖隐藏信息，快照暂不可编辑；如需修改请联系有订单创建权限的人员。</Typography.Paragraph>
            )
          ) : null}
          <CustomFieldSection testIdSuffix="order-edit" />
          </FieldConfigScope>
        </BusinessForm>
      </BusinessActionModal>

      <BusinessActionModal
        title={actionOrder ? `分润 · ${actionOrder.order_no}` : "分润"}
        open={allocationOpen}
        width={720}
        confirmLoading={allocationSubmitting}
        onCancel={() => { setAllocationOpen(false); setActionOrder(null); }}
        onOk={() => void allocationForm.submit()}
      >
        <BusinessForm
          scope="ALLOCATION"
          form={allocationForm}
          layout="vertical"
          onFinish={async (values: { allocations: AllocationFormRow[]; form_extra?: Record<string, unknown> }) => {
            if (!actionOrder) return;
            const rows = (values.allocations ?? []).filter(
              (row) => row.employee !== undefined && row.employee !== null,
            );
            if (rows.length === 0) {
              appMessage.error("请先在员工花名册里选择分润对象");
              return;
            }
            const result = validateAllocations(rows, allocationProfit);
            if (!result.ok) {
              appMessage.error(result.error);
              return;
            }
            const items = result.items;
            setAllocationSubmitting(true);
            try {
              await policyApi.setAllocations(actionOrder.id, items, values.form_extra);
              appMessage.success("分润已保存");
              setAllocationOpen(false);
              setActionOrder(null);
            } catch (error) {
              appMessage.error(normalizeError(error).message);
            } finally {
              setAllocationSubmitting(false);
            }
          }}
        >
          <Alert
            className="ui-form-spaced"
            type={allocationIsLoss ? "warning" : "info"}
            showIcon
            message={
              <span>
                订单总利润：
                <MoneyText value={allocationProfit} tone="auto" strong />
                {allocationIsLoss ? "（亏损）金额分润不可用，请按比例或暂不分润" : null}
              </span>
            }
          />
          <Typography.Paragraph type="secondary">
            每行一位员工：填<strong>比例</strong>按订单利润占比分，填<strong>金额</strong>按固定额分，
            两者都选填、同一行只填一个。纯比例分润时合计须为 100%，用金额时剩余部分默认留在公司。
          </Typography.Paragraph>
          <Form.List name="allocations">
            {(fields, { add, remove }) => (
              <>
                {fields.map((field) => (
                  <AdaptiveFormGrid key={field.key} className="orders-allocation-row">
                    <Form.Item
                      name={[field.name, "employee"]}
                      label="姓名"
                      rules={[{ required: true, message: "请选择姓名" }]}
                    >
                      <Select
                        placeholder="选择员工"
                        options={employeeOptions}
                        className="ui-control-width-200"
                      />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, "role"]}
                      label="角色"
                      initialValue="OWNER"
                    >
                      <Select
                        placeholder="选择角色"
                        options={profitRoleOptions}
                        className="ui-control-width-120"
                      />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, "allocation_rate"]}
                      label="比例"
                      rules={percentRules("比例")}
                    >
                      <Input suffix="%" inputMode="decimal" className="ui-control-width-120" />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, "allocation_amount"]}
                      label="金额"
                      rules={moneyRules("金额")}
                    >
                      <Input prefix="¥" inputMode="decimal" className="ui-control-width-140" />
                    </Form.Item>
                    <PermissionButton
                      permission="policy.manage"
                      type="link"
                      danger
                      disabled={fields.length <= 1}
                      onClick={() => remove(field.name)}
                    >
                      删除
                    </PermissionButton>
                  </AdaptiveFormGrid>
                ))}
                <PermissionButton
                  permission="policy.manage"
                  type="dashed"
                  block
                  onClick={() => add({ role: "OWNER", allocation_rate: "", allocation_amount: "" })}
                >
                  + 增加一行
                </PermissionButton>
              </>
            )}
          </Form.List>
          <FieldConfigScope scope="ALLOCATION" active={allocationOpen}>
            <CustomFieldSection testIdSuffix="order-allocation" />
          </FieldConfigScope>
        </BusinessForm>
      </BusinessActionModal>

      <BusinessActionModal
        title={actionOrder ? `资金收支 · ${actionOrder.order_no}` : "资金收支"}
        open={refundOpen}
        confirmLoading={refundSubmitting}
        onCancel={() => { setRefundOpen(false); setActionOrder(null); }}
        onOk={() => void refundForm.submit()}
      >
        <BusinessForm scope="REFUND"
          form={refundForm}
          layout="vertical"
          onFinish={async (values: { amount: string; occurred_on?: Dayjs; direction?: string; operator_user_ids?: number[]; reason: string; form_extra?: Record<string, unknown> }) => {
            if (!actionOrder) return;
            setRefundSubmitting(true);
            try {
              await ordersApi.postEvent(actionOrder.id, {
                event_type: "REFUND",
                amount: values.amount,
                occurred_on: values.occurred_on?.format("YYYY-MM-DD") ?? today(),
                reason: values.reason,
                operator_user_ids: values.operator_user_ids,
                form_extra: values.form_extra,
              });
              appMessage.success("退款已登记");
              setRefundOpen(false);
              setActionOrder(null);
              await load();
            } catch (error) {
              appMessage.error(normalizeError(error).message);
            } finally {
              setRefundSubmitting(false);
            }
          }}
        >
          <FieldConfigScope scope="REFUND" active={refundOpen}>
          <CfgItem name="occurred_on" label="发生日期" initialValue={dayjs(today())} rules={[{ required: true, message: "请选择发生日期" }]}>
            <DatePicker format="YYYY-MM-DD" className="ui-control-full" />
          </CfgItem>
          <CfgItem name="direction" label="资金流向" initialValue="OUT" rules={[{ required: true, message: "请选择资金流向" }]}>
            <Select disabled options={[{ value: "OUT", label: "支出" }]} />
          </CfgItem>
          <ResponsibleEmployeeSelect name="operator_user_ids" label="操作人" employees={users} />
          <CfgItem name="amount" label="金额" rules={requiredMoneyRules("金额")}>
            <MoneyInput placeholder="请输入退款金额" />
          </CfgItem>
          <CfgItem name="reason" label="收支备注" rules={[{ required: true, message: "请输入收支备注" }]}>
            <Input.TextArea rows={3} placeholder="请输入收支备注" />
          </CfgItem>
            <CustomFieldSection testIdSuffix="order-refund" />
          </FieldConfigScope>
        </BusinessForm>
        <div className="ui-form-spaced">
          <Typography.Text strong>资金明细</Typography.Text>
          {actionOrder?.cashflows?.length ? actionOrder.cashflows.map((flow) => (
            <div key={flow.flow_no} className="orders-event-row">
              <span>{flow.occurred_on}</span>
              <span>{flow.direction === "IN" ? "收入" : "支出"} · {flow.category}</span>
              <span><MoneyText value={flow.amount} /></span>
              <span>操作人：{flow.operator || currentOperator}</span>
            </div>
          )) : <Typography.Text type="secondary">暂无资金明细</Typography.Text>}
        </div>
      </BusinessActionModal>

      <CreateBusinessModal
        open={Boolean(createType)}
        onClose={() => setCreateType(undefined)}
        onCreated={async () => {
          setCreateType(undefined);
          setInventoryRefreshKey((key) => key + 1);
          // 代分期建单会同时生成新分期合约，同步重拉「分期回款」列表。
          setInstallmentRefreshKey((key) => key + 1);
          await load();
        }}
        initialOrderType={createType ?? "HS"}
      />

    </section>
  );
}
