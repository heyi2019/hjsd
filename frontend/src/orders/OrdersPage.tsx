/** 业务中心：库存中心 + 业务台账 + 分期回款。 */
import { Card, Descriptions, Drawer, Dropdown, Form, Input, Modal, Segmented, Select as AntSelect, Space, Tabs, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import {
  installmentsApi,
  ordersApi,
  orderTypesApi,
  policyApi,
  type Installment,
  type Order,
  type OrderLink,
  type OrderType,
} from "../shared/api/catalog";
import { api, normalizeError } from "../shared/api/client";
import { BUSINESS_MODE_LABEL, BUSINESS_TYPE_LABEL, LINK_STATUS_LABEL, VALUE_ADDED_SERVICE_LABEL, orderTypeLabel } from "../shared/lib/labels";
import { executionActionLabel, money, today } from "../shared/lib/format";
import { configurableLabel, useOptionSet } from "../shared/lib/optionSets";
import { requiredMoneyRules, percentRules, moneyRules } from "../shared/lib/validators";
import { InventoryPanel } from "../accounts/InventoryPanel";
import { InstallmentsPanel } from "../installments/InstallmentsPanel";
import {
  DataTable,
  ErrorBanner,
  MoneyInput,
  MoneyText,
  PermissionButton,
  PermissionGate,
  StatusTag,
  ConfirmButton,
} from "../shared/ui";
import { CreateBusinessModal, type BusinessOrderType } from "./CreateBusinessModal";
import {
  DEFAULT_BUSINESS_CENTER_TAB,
  type BusinessCenterEntryTab,
  type BusinessCenterTab,
} from "./businessCenter";

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
            <div><dt>产品</dt><dd>{order.account_game_type || "-"}</dd></div>
            <div><dt>账号</dt><dd>{order.account_game_account || "-"}</dd></div>
            <div><dt>平台</dt><dd>{order.account_platform || "-"}</dd></div>
            <div><dt>金额</dt><dd>{formatOrderAmount(order)}</dd></div>
            <div><dt>库存状态</dt><dd>{order.account_status || "-"}</dd></div>
            <div><dt>最新动作</dt><dd>{order.last_event_type ? executionActionLabel(order.last_event_type, order.order_type) : "-"}</dd></div>
            <div><dt>日期</dt><dd>{order.trade_date || "-"}</dd></div>
          </dl>
          <PermissionButton permission="order.event.post" type="link" onClick={() => props.onSelect(order)}>查看详情</PermissionButton>
        </article>
      ))}
    </div>
  );
}

type BusinessFilterKey = "all" | "HS" | "TH" | "DG" | "DFQ";
type BusinessModeFilterKey = "all" | "SELF" | "DISTRIBUTION";

/** 建关联时关系下拉的回落值；措辞比词典 label 长，用于说明方向，词典加载后由词典接管。 */
const RELATION_TYPE_FALLBACK: Array<{ value: string; label: string }> = [
  { value: "SOURCE", label: "本单为其来源单（拆分出去的下游单）" },
  { value: "FOLLOW_UP", label: "本单为其后续单（承接来源单）" },
];

const BUSINESS_FILTERS: Array<{ key: BusinessFilterKey; label: string }> = [
  { key: "all", label: "全部" },
  { key: "HS", label: "回收" },
  { key: "TH", label: "提号" },
  { key: "DG", label: "代挂" },
  { key: "DFQ", label: "代分期" },
];

const BUSINESS_MODE_FILTERS: Array<{ key: BusinessModeFilterKey; label: string }> = [
  { key: "all", label: "全部业务" },
  { key: "SELF", label: "自营" },
  { key: "DISTRIBUTION", label: "分销" },
];

const BUSINESS_CREATE_ITEMS = [
  { key: "HS", label: "新建回收订单" },
  { key: "TH", label: "新建提号订单" },
  { key: "DG", label: "新建代挂订单" },
  { key: "DFQ", label: "新建代分期订单" },
];

const ALLOCATION_LABEL: Record<"BUY" | "SELL" | "OPERATION" | "COMPANY", string> = {
  BUY: "买号",
  SELL: "售出",
  OPERATION: "运营",
  COMPANY: "公司归属",
};

// 与 backend/app/domain/enums.py AllocationRole 一致（policy/service.py 校验四值）
const ALLOCATION_ROLE_LABEL: Record<string, string> = {
  OWNER: "主责",
  BUYER: "采买",
  SALES: "销售",
  SERVICE: "服务",
};

// 与 backend/app/domain/enums.py ScheduleStatus 一致（StatusTag 未内置 PARTIAL/WAIVED）
const SCHEDULE_STATUS_LABEL: Record<string, string> = {
  PENDING: "待收",
  PARTIAL: "部分收取",
  PAID: "已付清",
  OVERDUE: "逾期",
  WAIVED: "已减免",
};

// 与 backend/app/domain/enums.py Portion / DeliveryMode 一致
const EVENT_PORTION_LABEL: Record<string, string> = {
  PRINCIPAL: "本金",
  PROFIT: "利润",
  GROSS: "总额",
};

const DELIVERY_MODE_LABEL: Record<string, string> = {
  PLATFORM_OPERATOR: "平台/本方操作换绑",
  CUSTOMER_SELF: "客户自行换绑",
};

const REFUND_RESPONSIBILITY_LABEL: Record<string, string> = {
  COMPANY: "公司",
  CUSTOMER: "客户",
  CONSIGNOR: "寄售方",
  PLATFORM: "平台",
  OTHER: "其他",
};

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

export function OrdersPage({ initialTab }: { initialTab?: BusinessCenterEntryTab } = {}) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [types, setTypes] = useState<OrderType[]>([]);
  const [loadError, setLoadError] = useState<{ message: string; code?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [orderTypeFilter, setOrderTypeFilter] = useState<BusinessFilterKey>("all");
  const [businessModeFilter, setBusinessModeFilter] = useState<BusinessModeFilterKey>("all");
  const [linkStatusFilter, setLinkStatusFilter] = useState<string>("all");
  // 关联状态 / 业务类型 / 业务模式：优先读选项词典（设置页可改 label），
  // 未加载完时回落原硬编码常量，避免主筛选条出现空白（零行为变化）。
  type Opt = { value: string; label: string };
  const linkStatusOptions: Opt[] =
    useOptionSet("ORDER_LINK_STATUS") ??
    Object.entries(LINK_STATUS_LABEL).map(([value, label]) => ({ value, label }));
  const orderBusinessOptions: Opt[] =
    useOptionSet("ORDER_BUSINESS") ??
    BUSINESS_FILTERS.filter((item) => item.key !== "all").map((item) => ({ value: item.key, label: item.label }));
  const orderBusinessModeOptions: Opt[] =
    useOptionSet("ORDER_BUSINESS_MODE") ??
    BUSINESS_MODE_FILTERS.filter((item) => item.key !== "all").map((item) => ({ value: item.key, label: item.label }));
  // 建关联时的关系下拉：值集受后端 CHECK 约束，label 由词典承载（措辞较长，见 0009 的 ORDER_RELATION_TYPE）。
  const relationTypeOptions: Opt[] =
    useOptionSet("ORDER_RELATION_TYPE") ?? RELATION_TYPE_FALLBACK;
  const [keyword, setKeyword] = useState("");
  const [createType, setCreateType] = useState<BusinessOrderType | undefined>();
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [cancelOrderTarget, setCancelOrderTarget] = useState<Order | null>(null);
  const [cancelInstallmentTarget, setCancelInstallmentTarget] = useState<Installment | null>(null);
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const [cancelForm] = Form.useForm();
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundSubmitting, setRefundSubmitting] = useState(false);
  const [refundForm] = Form.useForm();
  const [allocationOpen, setAllocationOpen] = useState(false);
  const [allocationSubmitting, setAllocationSubmitting] = useState(false);
  const [allocationForm] = Form.useForm();
  const [actionOrder, setActionOrder] = useState<Order | null>(null);
  const [links, setLinks] = useState<OrderLink[]>([]);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkSubmitting, setLinkSubmitting] = useState(false);
  const [linkForm] = Form.useForm();
  const [users, setUsers] = useState<Array<{ id: number; username: string; display_name: string; is_active: boolean }>>([]);
  const [editOpen, setEditOpen] = useState(false);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editForm] = Form.useForm();
  const [orderSnapshot, setOrderSnapshot] = useState<{ found: boolean; snapshot: { policy_version_id?: number | null; policy_snapshot?: Record<string, unknown> | null } | null } | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);

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
        api.get<Array<{ id: number; username: string; display_name: string; is_active: boolean }>>("/users"),
      ]);
      setActionOrder(order);
      setUsers(userResult.data.filter((item) => item.is_active));
      const byType = Object.fromEntries(result.items.map((item) => [item.allocation_type, item]));
      allocationForm.setFieldsValue({
        allocations: ["BUY", "SELL", "OPERATION", "COMPANY"].map((allocation_type) => ({
          allocation_type,
          user_id: byType[allocation_type]?.user_id ?? undefined,
          role: byType[allocation_type]?.role ?? "OWNER",
          allocation_rate: byType[allocation_type]?.allocation_rate ?? "0",
        })),
      });
      setAllocationOpen(true);
    } catch (error) {
      message.error(normalizeError(error).message);
    }
  };

  const openRefund = async (sourceOrder?: Order) => {
    try {
      const order = sourceOrder ? await ordersApi.get(sourceOrder.id) : selectedOrder;
      if (!order) return;
      setActionOrder(order);
      refundForm.resetFields();
      setRefundOpen(true);
    } catch (error) {
      message.error(normalizeError(error).message);
    }
  };

  const openOrder = async (order: Order) => {
    try {
      setSelectedOrder(await ordersApi.get(order.id));
      // 关联单失败不阻断详情展示。
      setLinks(await ordersApi.links(order.id).catch(() => []));
      // 规则快照（BAS-06-04）：无权查看时静默降级为 null，不阻断详情展示。
      setSnapshotLoading(true);
      try {
        setOrderSnapshot(await policyApi.orderSnapshot(order.id));
      } catch {
        setOrderSnapshot(null);
      } finally {
        setSnapshotLoading(false);
      }
    } catch (error) {
      message.error(normalizeError(error).message);
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

  const submitLink = async (values: Record<string, unknown>) => {
    if (!selectedOrder) return;
    setLinkSubmitting(true);
    try {
      await ordersApi.createLink(selectedOrder.id, {
        related_order_id: Number(values.related_order_id),
        relation_type: values.relation_type as "SOURCE" | "FOLLOW_UP",
        split_ratio: values.split_ratio ? String(values.split_ratio) : undefined,
        split_amount: values.split_amount ? String(values.split_amount) : undefined,
        note: values.note as string | undefined,
      });
      message.success("订单关联已建立");
      setLinkOpen(false);
      linkForm.resetFields();
      setLinks(await ordersApi.links(selectedOrder.id));
    } catch (error) {
      message.error(normalizeError(error).message);
    } finally {
      setLinkSubmitting(false);
    }
  };

  const removeLink = async (link: OrderLink) => {
    if (!selectedOrder) return;
    await ordersApi.deleteLink(selectedOrder.id, link.id);
    message.success("订单关联已删除");
    setLinks(await ordersApi.links(selectedOrder.id));
  };

  const openCancelTransaction = async (sourceOrder?: Order) => {
    try {
      const order = sourceOrder ? await ordersApi.get(sourceOrder.id) : selectedOrder;
      if (!order) return;
      if (order.installment_principal) {
        const contracts = await installmentsApi.list({ order_id: order.id });
        const target = contracts.find((item) => !["CANCELLED", "DELIVERED"].includes(item.status));
        if (!target) {
          message.error("未找到可取消的分期合约");
          return;
        }
        setCancelInstallmentTarget(target);
        setCancelOrderTarget(null);
      } else {
        setCancelOrderTarget(order);
        setCancelInstallmentTarget(null);
        // 默认冲销最后一笔可冲销动作（与历史行为一致），用户可在弹窗内改选其他动作或部分冲销。
        const reversible = reversibleEvents(order);
        const first = reversible[0];
        cancelForm.setFieldsValue({
          offset_event_id: first?.event.id,
          cancel_amount: first ? first.remaining.toFixed(2) : undefined,
        });
      }
      cancelForm.setFieldsValue({ cancelled_on: today() });
    } catch (error) {
      message.error(normalizeError(error).message);
    }
  };

  const closeCancelTransaction = () => {
    setCancelOrderTarget(null);
    setCancelInstallmentTarget(null);
    cancelForm.resetFields();
  };

  const submitCancelTransaction = async (values: { cancelled_on: string; reason: string; offset_event_id?: number; cancel_amount?: string }) => {
    const installment = cancelInstallmentTarget;
    const order = cancelOrderTarget;
    if (!installment && !order) return;
    setCancelSubmitting(true);
    try {
      if (installment) {
        const result = await installmentsApi.cancel(installment.id, values);
        const refundSummary = `退款已登记：¥${money(result.refund_amount)}`;
        message.success(
          installment.contract_type === "PICKUP_SALE"
            ? `${refundSummary}，提号交易已结束`
            : installment.contract_type === "ADVANCE_PURCHASE"
              ? `${refundSummary}，代分期交易已结束`
              : `${refundSummary}，账号已回到库存`,
        );
        if (result.order_status === "CANCELLED") await load();
      } else {
        if (!order) return;
        const reversible = reversibleEvents(order);
        const selected = reversible.find((item) => item.event.id === Number(values.offset_event_id)) ?? reversible[0];
        if (selected) {
          const amount = (values.cancel_amount ?? "").trim() || selected.remaining.toFixed(2);
          if (Number.isNaN(Number(amount)) || Number(amount) <= 0) {
            message.error("请输入有效的冲销金额");
            return;
          }
          if (Number(amount) > selected.remaining + 1e-9) {
            message.error(`冲销金额不能超过该动作剩余可冲金额 ¥${selected.remaining.toFixed(2)}`);
            return;
          }
          const result = await ordersApi.postEvent(order.id, {
            event_type: "CANCEL",
            amount,
            occurred_on: values.cancelled_on,
            offset_event_id: selected.event.id,
            reason: values.reason,
            note: "取消交易原路退款",
          });
          message.success(`取消交易已登记：退款 ¥${money(result.event.amount)}，已按原资金池退款`);
        } else {
          await ordersApi.cancel(order.id, { reason: values.reason });
          message.success("交易已取消，无已登记款项需要退款");
        }
        await load();
      }
      closeCancelTransaction();
      setSelectedOrder(null);
    } catch (error) {
      message.error(normalizeError(error).message);
    } finally {
      setCancelSubmitting(false);
    }
  };

  /** 编辑订单：后端限制——已有登记事件的订单只能改备注；账号快照仅 DFQ 可维护，
   *  且密码被后端隐去（无 order.create 权限）时不允许整体回写快照，避免覆盖隐藏密码。 */
  const openEditOrder = () => {
    if (!selectedOrder) return;
    const snapshot = selectedOrder.account_snapshot;
    editForm.setFieldsValue({
      trade_date: selectedOrder.trade_date,
      note: selectedOrder.note ?? undefined,
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
      message.success("订单已更新");
      setEditOpen(false);
      setSelectedOrder(await ordersApi.get(selectedOrder.id));
      await load();
    } catch (error) {
      message.error(normalizeError(error).message);
    } finally {
      setEditSubmitting(false);
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  const typeNames = Object.fromEntries(types.map((type) => [type.code, type.name]));
  const filteredOrders = filterBusinessOrders(orders, orderTypeFilter, businessModeFilter, keyword, linkStatusFilter);
  // 后端 update_order 规则：已有登记事件的订单只能改备注（orders/service.py）。
  const orderHasPostedEvents = (selectedOrder?.events ?? []).some((event) => event.is_posted);
  const [activeTab, setActiveTab] = useState<BusinessCenterTab>(
    initialTab === "inventory" ? "inventory" : DEFAULT_BUSINESS_CENTER_TAB,
  );
  const [inventoryRefreshKey, setInventoryRefreshKey] = useState(0);

  const ledgerColumns: ColumnsType<Order> = [
    { title: "订单号", dataIndex: "order_no" },
    { title: "对方 / 来源", key: "party", render: (_, order) => [order.party_name, order.party_source].filter(Boolean).join(" · ") || "-" },
    { title: "产品", dataIndex: "account_game_type", render: (v: string | null) => v || "-" },
    { title: "账号", dataIndex: "account_game_account", render: (v: string | null) => v || "-" },
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
          <PermissionButton permission="order.event.post" type="link" onClick={() => void openOrder(order)}>查看详情</PermissionButton>
          <PermissionGate permission="order.event.post">
            <Dropdown
              trigger={["click"]}
              menu={{
                items: [
                  { key: "allocation", label: "利润分配" },
                  { key: "refund", label: "登记退款", disabled: !["ACTIVE", "COMPLETED"].includes(order.status) },
                  {
                    key: "cancel",
                    label: "取消交易",
                    danger: true,
                    disabled: !["ACTIVE", "COMPLETED"].includes(order.status),
                  },
                ],
                onClick: ({ key }) => {
                  if (key === "allocation") void openAllocations(order);
                  if (key === "refund") void openRefund(order);
                  if (key === "cancel") void openCancelTransaction(order);
                },
              }}
            >
              <PermissionButton permission="order.event.post" type="link">更多⌄</PermissionButton>
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
            <PermissionButton permission="order.create" type="primary">新建订单⌄</PermissionButton>
          </Dropdown>
        )}
        items={[
          {
            key: "inventory",
            label: "库存中心",
            children: <InventoryPanel refreshKey={inventoryRefreshKey} />,
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
                    placeholder="搜索订单号 / 游戏账号 / 对方 / 备注"
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
                  <AntSelect
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
                  <Typography.Text type="secondary">
                    状态由对应业务流程更新，点击订单后继续处理付款、入库、售出或回款
                  </Typography.Text>
                </Space>
                <DataTable<Order>
                  columns={ledgerColumns}
                  rows={filteredOrders}
                  loading={loading}
                  page={page}
                  pageSize={pageSize}
                  total={filteredOrders.length}
                  emptyText="暂无业务订单"
                  className="orders-ledger"
                  scroll={{ x: "max-content" }}
                  onPageChange={(nextPage, nextSize) => {
                    setPage(nextPage);
                    setPageSize(nextSize);
                  }}
                />
                <MobileOrderList
                  orders={filteredOrders}
                  emptyText="暂无业务订单"
                  onSelect={(order) => void openOrder(order)}
                />
              </Card>
            ),
          },
          {
            key: "collections",
            label: "分期与回款",
            children: <InstallmentsPanel />,
          },
        ]}
      />

      <Drawer
        title={selectedOrder ? `订单详情 · ${selectedOrder.order_no}` : "订单详情"}
        open={Boolean(selectedOrder)}
        onClose={() => setSelectedOrder(null)}
        width={420}
      >
        {selectedOrder ? (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="业务">{BUSINESS_MODE_LABEL[selectedOrder.business_mode ?? ""] || "-"}</Descriptions.Item>
            <Descriptions.Item label="类型">{BUSINESS_TYPE_LABEL[selectedOrder.business_type ?? ""] || orderTypeLabel(selectedOrder.order_type, typeNames)}</Descriptions.Item>
            <Descriptions.Item label="增值服务">{configurableLabel("INSTALLMENT_CONTRACT_TYPE", selectedOrder.value_added_service, VALUE_ADDED_SERVICE_LABEL)}</Descriptions.Item>
            <Descriptions.Item label="产品">{[selectedOrder.account_game_type, selectedOrder.account_game_account, selectedOrder.account_channel_region].filter(Boolean).join(" / ") || "-"}</Descriptions.Item>
            <Descriptions.Item label="对方">{selectedOrder.party_name || "-"}</Descriptions.Item>
            <Descriptions.Item label="获客来源">{selectedOrder.party_source || "-"}</Descriptions.Item>
            <Descriptions.Item label="获客负责人">{selectedOrder.party_created_by || "-"}</Descriptions.Item>
            <Descriptions.Item label="获客时间">{selectedOrder.party_created_at ? new Date(selectedOrder.party_created_at).toLocaleString("zh-CN") : "-"}</Descriptions.Item>
            <Descriptions.Item label="金额/进度">{selectedOrder.installment_principal ? `¥${selectedOrder.installment_paid ?? "0.00"}/${selectedOrder.installment_principal} · ${selectedOrder.installment_periods ?? 0}期` : selectedOrder.event_total ? `¥${selectedOrder.event_total}` : "-"}</Descriptions.Item>
            <Descriptions.Item label="最新动作">{selectedOrder.last_event_type ? `${executionActionLabel(selectedOrder.last_event_type, selectedOrder.order_type)}${selectedOrder.last_event_amount ? ` · ¥${selectedOrder.last_event_amount}` : ""}` : "-"}</Descriptions.Item>
            <Descriptions.Item label="状态"><StatusTag status={selectedOrder.status} optionSet="ORDER_STATUS" /></Descriptions.Item>
            <Descriptions.Item label="关联状态"><StatusTag status={selectedOrder.link_status ?? "LINKED"} label={configurableLabel("ORDER_LINK_STATUS", selectedOrder.link_status ?? "LINKED", LINK_STATUS_LABEL)} /></Descriptions.Item>
            <Descriptions.Item label="成交日">{selectedOrder.trade_date || "-"}</Descriptions.Item>
            <Descriptions.Item label="备注">{selectedOrder.note || "-"}</Descriptions.Item>
          </Descriptions>
        ) : null}
        {selectedOrder?.events?.length ? (
          <div className="ui-form-spaced">
            <Typography.Text strong>动作记录</Typography.Text>
            {selectedOrder.events.map((event) => (
              <div key={event.id} className="orders-event-row">
                <span>
                  <b>{executionActionLabel(event.event_type, selectedOrder.order_type)}</b>
                  {` ${event.event_no}`}
                  {event.offset_event_id ? ` · 冲销 #${event.offset_event_id}` : ""}
                </span>
                <span>
                  <MoneyText value={event.amount} />
                  {" · "}{EVENT_PORTION_LABEL[event.portion ?? ""] ?? event.portion ?? "本金"}
                  {event.is_posted ? "" : " · 未过账"}
                </span>
                <span>{event.occurred_on} · {event.operator || "-"}</span>
                {event.reason || event.refund_responsibility || event.delivery_mode ? (
                  <span className="muted">
                    {[
                      event.delivery_mode ? `交付 ${DELIVERY_MODE_LABEL[event.delivery_mode] ?? event.delivery_mode}` : "",
                      event.refund_responsibility ? `责任方 ${REFUND_RESPONSIBILITY_LABEL[event.refund_responsibility] ?? event.refund_responsibility}` : "",
                      event.reason,
                    ].filter(Boolean).join(" · ")}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {selectedOrder ? (
          <div className="ui-form-spaced">
            <Typography.Text strong>关联订单</Typography.Text>
            <PermissionButton
              permission="order.update"
              size="small"
              onClick={() => {
                linkForm.resetFields();
                setLinkOpen(true);
              }}
            >
              新建关联
            </PermissionButton>
            {links.length ? (
              links.map((link) => (
                <div key={link.id} className="orders-event-row">
                  <span>{link.direction === "SOURCE" ? "来源单" : "后续单"}</span>
                  <span>
                    {link.direction === "SOURCE" ? link.source_order_no : link.target_order_no}
                  </span>
                  <span>
                    {link.split_ratio
                      ? `${link.split_ratio}%`
                      : link.split_amount
                        ? `¥${money(link.split_amount)}`
                        : "-"}
                  </span>
                  <ConfirmButton
                    permission="order.update"
                    size="small"
                    type="link"
                    danger
                    title="删除订单关联"
                    description="删除后该上下游关系即刻解除；如误删，可重新建立同一关联。"
                    onConfirm={() => removeLink(link)}
                  >
                    删除
                  </ConfirmButton>
                </div>
              ))
            ) : (
              <Typography.Text type="secondary">暂无关联订单</Typography.Text>
            )}
          </div>
        ) : null}
        {selectedOrder ? (
          <div className="ui-form-spaced">
            <Typography.Text strong>规则快照</Typography.Text>
            {snapshotLoading ? (
              <Typography.Text type="secondary">读取中…</Typography.Text>
            ) : orderSnapshot?.found && orderSnapshot.snapshot ? (
              <>
                <div className="orders-event-row">
                  <span>规则版本</span>
                  <span>#{orderSnapshot.snapshot.policy_version_id ?? "-"}</span>
                </div>
                {Object.entries(orderSnapshot.snapshot.policy_snapshot ?? {}).map(([code, snap]) => (
                  <div key={code} className="orders-event-row">
                    <span>{code === "REBATE" ? "返点规则" : code === "COMMISSION" ? "提成规则" : code}</span>
                    <span className="muted">
                      {typeof snap === "object" && snap !== null
                        ? Object.entries(snap as Record<string, unknown>)
                            .filter(([key]) => key !== "captured_at")
                            .map(([key, value]) => `${key}=${typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}`)
                            .join(" · ")
                        : String(snap)}
                    </span>
                  </div>
                ))}
                <Typography.Text type="secondary">快照按成交日固化，规则改版不会回写历史订单。</Typography.Text>
              </>
            ) : (
              <Typography.Text type="secondary">建单时无生效的返点/提成规则，未固化规则快照。</Typography.Text>
            )}
          </div>
        ) : null}
        {selectedOrder?.cashflows?.length ? (
          <div className="ui-form-spaced">
            <Typography.Text strong>资金流水</Typography.Text>
            {selectedOrder.cashflows.map((flow) => (
              <div key={flow.flow_no} className="orders-event-row">
                <span>{flow.occurred_on}</span>
                <span>{flow.direction === "IN" ? "收入" : "支出"} · {flow.category}</span>
                <span><MoneyText value={flow.amount} /></span>
                <span><StatusTag status={flow.status} optionSet="FUND_FLOW_STATUS" /></span>
              </div>
            ))}
          </div>
        ) : null}
        {selectedOrder?.rebates?.length ? (
          <div className="ui-form-spaced">
            <Typography.Text strong>返点</Typography.Text>
            {selectedOrder.rebates.map((rebate) => (
              <div key={rebate.id} className="orders-event-row">
                <span>{rebate.rebate_no}</span>
                <span>{rebate.rate}% · <MoneyText value={rebate.base_amount} /></span>
                <span>{rebate.expected_on ? `预计 ${rebate.expected_on}` : rebate.collected_on}</span>
                <span><StatusTag status={rebate.status} optionSet="REBATE_STATUS" /></span>
              </div>
            ))}
          </div>
        ) : null}
        {selectedOrder?.installment ? (
          <div className="ui-form-spaced">
            <Typography.Text strong>分期合约 · {selectedOrder.installment.inst_no}</Typography.Text>
            <Typography.Text type="secondary">
              本金 ¥{money(selectedOrder.installment.principal)} · 已收 ¥{money(selectedOrder.installment.paid_amount)}
              {Number(selectedOrder.installment.waived_amount) > 0 ? ` · 减免 ¥${money(selectedOrder.installment.waived_amount)}` : ""}
              {Number(selectedOrder.installment.bad_debt_amount) > 0 ? ` · 坏账 ¥${money(selectedOrder.installment.bad_debt_amount)}` : ""}
              {" · "}{selectedOrder.installment.periods} 期
            </Typography.Text>
            <div className="orders-event-row">
              <span><StatusTag status={selectedOrder.installment.status} optionSet="INSTALLMENT_STATUS" /></span>
              <span>{selectedOrder.installment.delivered_on ? `交付于 ${selectedOrder.installment.delivered_on}` : "未交付"}</span>
              <span>{selectedOrder.installment.first_due_on ? `首期 ${selectedOrder.installment.first_due_on}` : ""}</span>
            </div>
            {(selectedOrder.installment_schedule ?? []).map((row) => (
              <div key={row.id} className="orders-event-row">
                <span>第 {row.period_no} 期</span>
                <span>{row.due_on}</span>
                <span>应收 ¥{money(row.due_amount)}</span>
                <span>已收 ¥{money(row.received_amount)}</span>
                <span><StatusTag status={row.status} label={configurableLabel("SCHEDULE_STATUS", row.status, SCHEDULE_STATUS_LABEL)} /></span>
              </div>
            ))}
          </div>
        ) : null}
        {selectedOrder?.audit?.length ? (
          <div className="ui-form-spaced">
            <Typography.Text strong>审计记录</Typography.Text>
            {selectedOrder.audit.map((entry) => (
              <div key={entry.id} className="orders-event-row">
                <span>{entry.action}</span>
                <span>{entry.actor}</span>
                <span>{entry.occurred_at ? new Date(entry.occurred_at).toLocaleString("zh-CN") : "-"}</span>
              </div>
            ))}
          </div>
        ) : null}
        {selectedOrder?.attachments?.length ? (
          <div className="ui-form-spaced">
            <Typography.Text strong>附件</Typography.Text>
            {selectedOrder.attachments.map((file) => (
              <div key={file.id} className="orders-event-row">
                <span>{file.file_name}</span>
                <span>{(file.size_bytes / 1024).toFixed(1)} KB</span>
                <span>{file.created_at ? file.created_at.slice(0, 10) : "-"}</span>
              </div>
            ))}
          </div>
        ) : null}
        {selectedOrder ? (
          <Space className="ui-form-spaced" wrap>
            <PermissionButton permission="order.update" onClick={openEditOrder}>编辑订单</PermissionButton>
            <Dropdown
              trigger={["click"]}
              menu={{
                items: [
                  { key: "allocation", label: "利润分配" },
                  { key: "refund", label: "登记退款", disabled: !["ACTIVE", "COMPLETED"].includes(selectedOrder.status) },
                  { key: "cancel", label: "取消交易", danger: true, disabled: !["ACTIVE", "COMPLETED"].includes(selectedOrder.status) },
                ],
                onClick: ({ key }) => {
                  if (key === "allocation") void openAllocations();
                  if (key === "refund") void openRefund();
                  if (key === "cancel") void openCancelTransaction();
                },
              }}
            >
              <PermissionButton permission="order.event.post">更多⌄</PermissionButton>
            </Dropdown>
            {selectedOrder.account_id ? (
              <PermissionButton permission="order.event.post" type="link" onClick={() => { setActiveTab("inventory"); setSelectedOrder(null); }}>
                去库存中心
            </PermissionButton>
            ) : null}
            {selectedOrder.installment_principal ? (
              <PermissionButton permission="order.event.post" type="link" onClick={() => { setActiveTab("collections"); setSelectedOrder(null); }}>
                去分期与回款
            </PermissionButton>
            ) : null}
          </Space>
        ) : null}
      </Drawer>

      <Modal
        title={cancelInstallmentTarget ? `取消交易 · ${cancelInstallmentTarget.inst_no}` : cancelOrderTarget ? `取消交易 · ${cancelOrderTarget.order_no}` : "取消交易"}
        open={Boolean(cancelOrderTarget || cancelInstallmentTarget)}
        confirmLoading={cancelSubmitting}
        onCancel={closeCancelTransaction}
        okText="确认取消交易"
        okButtonProps={{ danger: true }}
        onOk={() => void cancelForm.submit()}
      >
        <Form form={cancelForm} layout="vertical" onFinish={submitCancelTransaction}>
          <Typography.Paragraph type="secondary">
            {cancelInstallmentTarget
              ? cancelInstallmentTarget.contract_type === "PICKUP_SALE"
                ? "按已收款原资金池退款，提号取消后交易直接结束。"
                : cancelInstallmentTarget.contract_type === "ADVANCE_PURCHASE"
                  ? "按已收款原资金池退款，取消后终止代分期交易。"
                  : "按已收款原资金池退款，取消后账号回到库存。"
              : "默认冲销最后一笔可冲销动作并按原资金池退款；也可指定其他动作，或填写小于剩余可冲金额做部分冲销。没有登记款项时仅取消交易。"}
          </Typography.Paragraph>
          {cancelOrderTarget && reversibleEvents(cancelOrderTarget).length > 0 ? (
            <>
              <Form.Item name="offset_event_id" label="被冲销动作" rules={[{ required: true, message: "请选择被冲销动作" }]}>
                <AntSelect
                  placeholder="请选择被冲销动作"
                  options={reversibleEvents(cancelOrderTarget).map(({ event, remaining }) => ({
                    value: event.id,
                    label: `${executionActionLabel(event.event_type, cancelOrderTarget.order_type)} · ${event.event_no} · ¥${money(event.amount)}（剩余可冲 ¥${money(remaining.toFixed(2))}）`,
                  }))}
                  onChange={(value: number) => {
                    const target = reversibleEvents(cancelOrderTarget).find((item) => item.event.id === value);
                    if (target) cancelForm.setFieldsValue({ cancel_amount: target.remaining.toFixed(2) });
                  }}
                />
              </Form.Item>
              <Form.Item name="cancel_amount" label="冲销金额" rules={requiredMoneyRules("冲销金额")} tooltip="留空或填剩余可冲金额为全额冲销；小于剩余金额即为部分冲销">
                <MoneyInput placeholder="请输入冲销金额" />
              </Form.Item>
            </>
          ) : null}
          <Form.Item name="cancelled_on" label="取消日期" rules={[{ required: true, message: "请输入取消日期" }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
          <Form.Item name="reason" label="取消原因" rules={[{ required: true, message: "请输入取消原因" }]}>
            <Input.TextArea rows={3} placeholder="请输入退款及取消原因" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={selectedOrder ? `编辑订单 · ${selectedOrder.order_no}` : "编辑订单"}
        open={editOpen}
        confirmLoading={editSubmitting}
        onCancel={() => { if (!editSubmitting) setEditOpen(false); }}
        okText="保存修改"
        onOk={() => void editForm.submit()}
      >
        <Form form={editForm} layout="vertical" onFinish={submitEditOrder}>
          <Typography.Paragraph type="secondary">
            订单编号、业务类型、账号关联与状态不可编辑；已有登记事件的订单只能修改备注，核算字段须通过冲销/更正处理。
          </Typography.Paragraph>
          <Form.Item
            name="trade_date"
            label="成交日期"
            rules={orderHasPostedEvents ? [] : [{ required: true, message: "请输入成交日期" }]}
            extra={orderHasPostedEvents ? "已有登记事件，成交日期不可修改" : undefined}
          >
            <Input placeholder="YYYY-MM-DD" disabled={orderHasPostedEvents} />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} placeholder="订单备注（选填）" />
          </Form.Item>
          {selectedOrder?.account_snapshot && selectedOrder.order_type === "DFQ" && !orderHasPostedEvents ? (
            selectedOrder.account_snapshot.game_password ? (
              <>
                <Typography.Paragraph type="secondary">账号快照（代分期建单时填写的文本信息）：</Typography.Paragraph>
                <Form.Item name="snap_game_account" label="账号标识" rules={[{ required: true, message: "请输入账号标识" }]}>
                  <Input />
                </Form.Item>
                <Form.Item name="snap_game_type" label="产品"><Input /></Form.Item>
                <Form.Item name="snap_game_password" label="账号密码"><Input placeholder="留空表示清除密码" /></Form.Item>
                <Form.Item name="snap_channel_region" label="区服"><Input /></Form.Item>
                <Form.Item name="snap_bound_phone" label="绑定手机"><Input /></Form.Item>
                <Form.Item name="snap_platform" label="平台"><Input /></Form.Item>
                <Form.Item name="snap_purchase_price" label="号价" rules={moneyRules("号价")}><MoneyInput placeholder="例如 1000.00" /></Form.Item>
                <Form.Item name="snap_note" label="快照备注"><Input.TextArea rows={2} /></Form.Item>
              </>
            ) : (
              <Typography.Paragraph type="secondary">账号快照密码字段无权查看，为避免覆盖隐藏信息，快照暂不可编辑；如需修改请联系有订单创建权限的人员。</Typography.Paragraph>
            )
          ) : null}
        </Form>
      </Modal>

      <Modal
        title={selectedOrder ? `新建订单关联 · ${selectedOrder.order_no}` : "新建订单关联"}
        open={linkOpen}
        confirmLoading={linkSubmitting}
        onCancel={() => setLinkOpen(false)}
        okText="建立关联"
        onOk={() => void linkForm.submit()}
      >
        <Form form={linkForm} layout="vertical" onFinish={submitLink}>
          <Typography.Paragraph type="secondary">
            关联单用于把同一真实交易拆分的上下游订单串起来；分成口径作为关系快照保存，不会改写订单自身金额。
          </Typography.Paragraph>
          <Form.Item
            name="related_order_id"
            label="关联订单"
            rules={[{ required: true, message: "请选择关联订单" }]}
          >
            <AntSelect
              showSearch
              placeholder="请选择订单"
              optionFilterProp="label"
              options={orders
                .filter((item) => item.id !== selectedOrder?.id)
                .map((item) => ({
                  value: item.id,
                  label: `${item.order_no}${item.party_name ? ` · ${item.party_name}` : ""}`,
                }))}
            />
          </Form.Item>
          <Form.Item name="relation_type" label="关系" rules={[{ required: true, message: "请选择关系" }]}>
            <AntSelect placeholder="请选择关系" options={relationTypeOptions} />
          </Form.Item>
          <Form.Item name="split_ratio" label="分成比例（%）" tooltip="与分成金额二选一，按交易拆分口径填写">
            <Input placeholder="例如 60" />
          </Form.Item>
          <Form.Item name="split_amount" label="分成金额（元）" tooltip="与分成比例二选一">
            <Input placeholder="例如 1000.00" />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} placeholder="关联说明（选填）" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={actionOrder ? `利润分配 · ${actionOrder.order_no}` : "利润分配"}
        open={allocationOpen}
        confirmLoading={allocationSubmitting}
        onCancel={() => { setAllocationOpen(false); setActionOrder(null); }}
        onOk={() => void allocationForm.submit()}
      >
        <Form
          form={allocationForm}
          layout="vertical"
          onFinish={async (values: { allocations: Array<{ allocation_type: "BUY" | "SELL" | "OPERATION" | "COMPANY"; user_id?: number; role: string; allocation_rate: string }> }) => {
            if (!actionOrder) return;
            const rows = values.allocations ?? [];
            const total = rows.reduce((sum, row) => sum + Number(row.allocation_rate || 0), 0);
            if (Math.abs(total - 100) > 0.001) {
              message.error("四类收益比例合计必须为 100%");
              return;
            }
            setAllocationSubmitting(true);
            try {
              await policyApi.setAllocations(actionOrder.id, rows.map((row) => ({
                allocation_type: row.allocation_type,
                user_id: row.allocation_type === "OPERATION" ? Number(row.user_id) : null,
                role: row.role,
                allocation_rate: String(row.allocation_rate),
              })));
              message.success("利润分配已保存");
              setAllocationOpen(false);
              setActionOrder(null);
            } catch (error) {
              message.error(normalizeError(error).message);
            } finally {
              setAllocationSubmitting(false);
            }
          }}
        >
          <Form.List name="allocations">
            {(fields) => fields.map((field) => (
              <Space key={field.key} align="baseline" className="orders-allocation-row">
                <Form.Item {...field} name={[field.name, "allocation_type"]} hidden><Input /></Form.Item>
                <Form.Item label="动作/归属"><Typography.Text>{ALLOCATION_LABEL[["BUY", "SELL", "OPERATION", "COMPANY"][field.name] as keyof typeof ALLOCATION_LABEL]}</Typography.Text></Form.Item>
                <Form.Item {...field} name={[field.name, "user_id"]} label="收益人">
                  {field.name === 2 ? (
                    <AntSelect
                      placeholder="请选择运营人员"
                      options={users.map((item) => ({
                        value: item.id,
                        label: item.display_name + "（" + item.username + "）",
                      }))}
                    />
                  ) : (
                    <Input
                      disabled
                      placeholder={field.name === 0 ? "自动绑定回收/提号/代挂操作人" : field.name === 1 ? "自动绑定售出操作人" : "公司归属"}
                    />
                  )}
                </Form.Item>
                <Form.Item {...field} name={[field.name, "role"]} label="角色">
                  <AntSelect
                    options={Object.entries(ALLOCATION_ROLE_LABEL).map(([value, label]) => ({ value, label }))}
                  />
                </Form.Item>
                <Form.Item {...field} name={[field.name, "allocation_rate"]} label="比例" rules={[{ required: true, message: "请输入比例" }, ...percentRules("比例")]}><Input suffix="%" inputMode="decimal" /></Form.Item>
              </Space>
            ))}
          </Form.List>
        </Form>
      </Modal>

      <Modal
        title={actionOrder ? `登记退款 · ${actionOrder.order_no}` : "登记退款"}
        open={refundOpen}
        confirmLoading={refundSubmitting}
        onCancel={() => { setRefundOpen(false); setActionOrder(null); }}
        onOk={() => void refundForm.submit()}
      >
        <Form
          form={refundForm}
          layout="vertical"
          onFinish={async (values: { amount: string; reason: string; refund_responsibility: string }) => {
            if (!actionOrder) return;
            setRefundSubmitting(true);
            try {
              await ordersApi.postEvent(actionOrder.id, {
                event_type: "REFUND",
                amount: values.amount,
                occurred_on: new Date().toISOString().slice(0, 10),
                reason: values.reason,
                refund_responsibility: values.refund_responsibility as "COMPANY" | "CUSTOMER" | "CONSIGNOR" | "PLATFORM" | "OTHER",
              });
              message.success("退款已登记");
              setRefundOpen(false);
              setActionOrder(null);
              await load();
            } catch (error) {
              message.error(normalizeError(error).message);
            } finally {
              setRefundSubmitting(false);
            }
          }}
        >
          <Form.Item name="amount" label="退款金额" rules={requiredMoneyRules("退款金额")}>
            <MoneyInput placeholder="请输入退款金额" />
          </Form.Item>
          <Form.Item name="refund_responsibility" label="责任方" initialValue="COMPANY" rules={[{ required: true, message: "请选择责任方" }]}>
            <AntSelect options={["COMPANY", "CUSTOMER", "CONSIGNOR", "PLATFORM", "OTHER"].map((value) => ({ value, label: { COMPANY: "公司", CUSTOMER: "客户", CONSIGNOR: "寄售方", PLATFORM: "平台", OTHER: "其他" }[value] }))} />
          </Form.Item>
          <Form.Item name="reason" label="退款原因" rules={[{ required: true, message: "请输入退款原因" }]}>
            <Input.TextArea rows={3} placeholder="请输入退款原因" />
          </Form.Item>
        </Form>
      </Modal>

      <CreateBusinessModal
        open={Boolean(createType)}
        onClose={() => setCreateType(undefined)}
        onCreated={async () => {
          setCreateType(undefined);
          setInventoryRefreshKey((key) => key + 1);
          await load();
        }}
        initialOrderType={createType ?? "HS"}
      />

    </section>
  );
}

