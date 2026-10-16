/** 业务中心：库存中心 + 业务台账 + 分期回款。 */
import { Card, Descriptions, Drawer, Dropdown, Input, Segmented, Space, Tabs, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import {
  ordersApi,
  orderTypesApi,
  type Order,
  type OrderType,
} from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { orderTypeLabel } from "../shared/lib/labels";
import { executionActionLabel, money } from "../shared/lib/format";
import { InventoryPanel } from "../accounts/InventoryPanel";
import { InstallmentsPanel } from "../installments/InstallmentsPanel";
import {
  DataTable,
  ErrorBanner,
  PermissionButton,
  StatusTag,
} from "../shared/ui";
import { CreateBusinessModal } from "./CreateBusinessModal";
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
          <Typography.Link onClick={() => props.onSelect(order)}>查看详情</Typography.Link>
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

const FALLBACK_TYPE_NAMES: Record<string, string> = {
  HS: "回收",
  TH: "提号",
  DG: "代挂",
  DFQ: "代分期",
};

const BUSINESS_MODE_LABEL: Record<string, string> = {
  SELF: "自营",
  DISTRIBUTION: "分销",
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
  ].filter(Boolean).join(" ").toLowerCase();
}

function orderMatchesBusinessMode(order: Order, mode: BusinessModeFilterKey): boolean {
  return mode === "all" || order.account_business_mode === mode;
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
  const [createType, setCreateType] = useState<string | undefined>();
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);

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

  useEffect(() => {
    void load();
  }, [load]);

  const typeNames = { ...FALLBACK_TYPE_NAMES, ...Object.fromEntries(types.map((type) => [type.code, type.name])) };
  const filteredOrders = filterBusinessOrders(orders, orderTypeFilter, businessModeFilter, keyword);
  const [activeTab, setActiveTab] = useState<BusinessCenterTab>(
    initialTab === "inventory" ? "inventory" : DEFAULT_BUSINESS_CENTER_TAB,
  );

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
    { title: "操作", key: "actions", render: (_, order) => <Typography.Link onClick={() => setSelectedOrder(order)}>查看详情</Typography.Link> },
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
              onClick: ({ key }) => setCreateType(key),
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
            children: <InventoryPanel />,
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
                    placeholder="搜索订单号 / 游戏账号 / 对方"
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
                  onSelect={setSelectedOrder}
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
            <Descriptions.Item label="业务">{BUSINESS_MODE_LABEL[selectedOrder.account_business_mode ?? ""] || "-"}</Descriptions.Item>
            <Descriptions.Item label="类型">{orderTypeLabel(selectedOrder.order_type, typeNames)}</Descriptions.Item>
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
        {selectedOrder ? (
          <Space className="ui-form-spaced" wrap>
            {selectedOrder.account_id ? (
              <Typography.Link onClick={() => { setActiveTab("inventory"); setSelectedOrder(null); }}>
                去库存中心
              </Typography.Link>
            ) : null}
            {selectedOrder.installment_principal ? (
              <Typography.Link onClick={() => { setActiveTab("collections"); setSelectedOrder(null); }}>
                去分期与回款
              </Typography.Link>
            ) : null}
          </Space>
        ) : null}
      </Drawer>

      <CreateBusinessModal
        open={Boolean(createType)}
        onClose={() => setCreateType(undefined)}
        onCreated={async () => {
          setCreateType(undefined);
          await load();
        }}
        initialOrderType={createType}
      />

    </section>
  );
}

