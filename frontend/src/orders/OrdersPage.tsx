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
import { BUSINESS_MODE_LABEL, BUSINESS_TYPE_LABEL, VALUE_ADDED_SERVICE_LABEL, orderTypeLabel } from "../shared/lib/labels";
import { executionActionLabel, money, today } from "../shared/lib/format";
import { requiredMoneyRules, percentRules } from "../shared/lib/validators";
import { InventoryPanel } from "../accounts/InventoryPanel";
import { InstallmentsPanel } from "../installments/InstallmentsPanel";
import {
  DataTable,
  ErrorBanner,
  MoneyInput,
  PermissionButton,
  PermissionGate,
  StatusTag,
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
            <StatusTag status={order.status} />
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
): Order[] {
  const normalizedKeyword = keyword.trim().toLowerCase();
  return orders.filter((order) => (
    (type === "all" || order.order_type === type)
    && orderMatchesBusinessMode(order, mode)
    && (!normalizedKeyword || orderSearchText(order).includes(normalizedKeyword))
  ));
}

function countBusinessOrders(orders: Order[], type: BusinessFilterKey, mode: BusinessModeFilterKey): number {
  return orders.filter((order) => (
    (type === "all" || order.order_type === type) && orderMatchesBusinessMode(order, mode)
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
          role: byType[allocation_type]?.role ?? (allocation_type === "COMPANY" ? "OWNER" : "OWNER"),
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
    } catch (error) {
      message.error(normalizeError(error).message);
    }
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

  const submitCancelTransaction = async (values: { cancelled_on: string; reason: string }) => {
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
        const postedEvents = (order.events ?? []).filter((event) => event.is_posted);
        const reversible = [...postedEvents]
          .reverse()
          .find((event) => ["BUY", "COST", "SELL"].includes(event.event_type));
        if (reversible) {
          const result = await ordersApi.postEvent(order.id, {
            event_type: "CANCEL",
            amount: reversible.amount,
            occurred_on: values.cancelled_on,
            offset_event_id: reversible.id,
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

  useEffect(() => {
    void load();
  }, [load]);

  const typeNames = Object.fromEntries(types.map((type) => [type.code, type.name]));
  const filteredOrders = filterBusinessOrders(orders, orderTypeFilter, businessModeFilter, keyword);
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
    { title: "库存状态", dataIndex: "account_status", render: (v: string | null) => v ? <StatusTag status={v} /> : "-" },
    { title: "最新动作", dataIndex: "last_event_type", render: (v: string | null, order) => v ? `${executionActionLabel(v, order.order_type)}${order.last_event_amount ? ` · ¥${order.last_event_amount}` : ""}` : "-" },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} /> },
    { title: "日期", dataIndex: "trade_date" },
    {
      title: "操作",
      key: "actions",
      render: (_, order) => (
        <Space size="small">
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
                    options={BUSINESS_FILTERS.map((item) => ({
                      value: item.key,
                      label: `${item.label} ${item.key === "all"
                        ? countBusinessOrders(orders, "all", businessModeFilter)
                        : countBusinessOrders(orders, item.key, businessModeFilter)}`,
                    }))}
                    onChange={(value) => {
                      setOrderTypeFilter(value as BusinessFilterKey);
                      setPage(1);
                    }}
                  />
                  <Typography.Text strong>业务筛选</Typography.Text>
                  <Segmented
                    value={businessModeFilter}
                    options={BUSINESS_MODE_FILTERS.map((item) => ({
                      value: item.key,
                      label: item.label,
                    }))}
                    onChange={(value) => {
                      setBusinessModeFilter(value as BusinessModeFilterKey);
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
            <Descriptions.Item label="增值服务">{VALUE_ADDED_SERVICE_LABEL[selectedOrder.value_added_service ?? ""] || "-"}</Descriptions.Item>
            <Descriptions.Item label="产品">{[selectedOrder.account_game_type, selectedOrder.account_game_account, selectedOrder.account_channel_region].filter(Boolean).join(" / ") || "-"}</Descriptions.Item>
            <Descriptions.Item label="对方">{selectedOrder.party_name || "-"}</Descriptions.Item>
            <Descriptions.Item label="获客来源">{selectedOrder.party_source || "-"}</Descriptions.Item>
            <Descriptions.Item label="获客负责人">{selectedOrder.party_created_by || "-"}</Descriptions.Item>
            <Descriptions.Item label="获客时间">{selectedOrder.party_created_at ? new Date(selectedOrder.party_created_at).toLocaleString("zh-CN") : "-"}</Descriptions.Item>
            <Descriptions.Item label="金额/进度">{selectedOrder.installment_principal ? `¥${selectedOrder.installment_paid ?? "0.00"}/${selectedOrder.installment_principal} · ${selectedOrder.installment_periods ?? 0}期` : selectedOrder.event_total ? `¥${selectedOrder.event_total}` : "-"}</Descriptions.Item>
            <Descriptions.Item label="最新动作">{selectedOrder.last_event_type ? `${executionActionLabel(selectedOrder.last_event_type, selectedOrder.order_type)}${selectedOrder.last_event_amount ? ` · ¥${selectedOrder.last_event_amount}` : ""}` : "-"}</Descriptions.Item>
            <Descriptions.Item label="状态"><StatusTag status={selectedOrder.status} /></Descriptions.Item>
            <Descriptions.Item label="成交日">{selectedOrder.trade_date || "-"}</Descriptions.Item>
            <Descriptions.Item label="备注">{selectedOrder.note || "-"}</Descriptions.Item>
          </Descriptions>
        ) : null}
        {selectedOrder?.events?.length ? (
          <div className="ui-form-spaced">
            <Typography.Text strong>动作记录</Typography.Text>
            {selectedOrder.events.map((event) => (
              <div key={event.id} className="orders-event-row">
                <span>{executionActionLabel(event.event_type, selectedOrder.order_type)}</span>
                <span>{event.operator || "-"}</span>
                <span>{event.occurred_on}</span>
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
                  <span>{link.direction === "incoming" ? "来源单" : "后续单"}</span>
                  <span>
                    {link.direction === "incoming" ? link.source_order_no : link.target_order_no}
                  </span>
                  <span>
                    {link.split_ratio
                      ? `${link.split_ratio}%`
                      : link.split_amount
                        ? `¥${money(link.split_amount)}`
                        : "-"}
                  </span>
                </div>
              ))
            ) : (
              <Typography.Text type="secondary">暂无关联订单</Typography.Text>
            )}
          </div>
        ) : null}
        {selectedOrder ? (
          <Space className="ui-form-spaced" wrap>
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
              : "有已登记动作时冲销最后一笔可冲销动作并按原资金池退款；没有登记款项时仅取消交易。"}
          </Typography.Paragraph>
          <Form.Item name="cancelled_on" label="取消日期" rules={[{ required: true, message: "请输入取消日期" }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
          <Form.Item name="reason" label="取消原因" rules={[{ required: true, message: "请输入取消原因" }]}>
            <Input.TextArea rows={3} placeholder="请输入退款及取消原因" />
          </Form.Item>
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
            <AntSelect
              placeholder="请选择关系"
              options={[
                { value: "SOURCE", label: "本单为其来源单（拆分出去的下游单）" },
                { value: "FOLLOW_UP", label: "本单为其后续单（承接来源单）" },
              ]}
            />
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
                <Form.Item {...field} name={[field.name, "role"]} hidden><Input /></Form.Item>
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

