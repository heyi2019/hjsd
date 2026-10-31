
/** 业务中心：库存中心 + 业务台账 + 分期回款。 */
import { Card, Dropdown, Input, Segmented, Space, Tabs, Typography } from "antd";
import type { Order } from "../shared/api/catalog";
import { InventoryPanel } from "../stocks/InventoryPanel";
import { InstallmentsPanel } from "../installments/InstallmentsPanel";
import { DataTable, ErrorBanner, PermissionButton, Select } from "../shared/ui";
import { OrderDetailPane } from "./OrderDetailPane";
import type { BusinessOrderType } from "./CreateBusinessModal";
import { BUSINESS_CREATE_ITEMS, MobileOrderList, countBusinessOrders } from "./OrdersPage.fragments";
import type { BusinessFilterKey, BusinessModeFilterKey } from "./OrdersPage.fragments";
export { validateAllocations } from "./OrdersPage.fragments";
export type { AllocationItem, AllocationValidation } from "./OrdersPage.fragments";
import type { BusinessCenterEntryTab, BusinessCenterTab } from "./businessCenter";

// 订单字段板块常量（ORDER_FIELD_SECTION_LABEL / ORDER_FIELD_SECTION_ORDER）已迁移至 OrderDetailPane。

import { useOrdersPageController } from "./useOrdersPageController";
import { OrderModals } from "./OrdersPage.modals";
export function OrdersPage({ initialTab, active = true, onNavigate }: { initialTab?: BusinessCenterEntryTab; active?: boolean; onNavigate?: (key: string, tab?: BusinessCenterEntryTab) => void } = {}) {
  const controller = useOrdersPageController({ initialTab, active, onNavigate });
  const {
    activeTab,
    arrangeLedgerColumns,
    businessModeFilter,
    expandedOrderIds,
    exportLedger,
    filteredOrders,
    handleLedgerExpand,
    installmentRefreshKey,
    inventoryRefreshKey,
    keyword,
    ledgerColumns,
    ledgerExporting,
    ledgerSortDesc,
    linkStatusFilter,
    linkStatusOptions,
    load,
    loadError,
    loading,
    openEditOrder,
    orderBusinessModeOptions,
    orderBusinessOptions,
    orderTypeFilter,
    orders,
    page,
    pageSize,
    setActiveTab,
    setBusinessModeFilter,
    setCreateType,
    setInstallmentRefreshKey,
    setKeyword,
    setLedgerSortDesc,
    setLinkStatusFilter,
    setOrderTypeFilter,
    setPage,
    setPageSize,
    typeNames,
  } = controller;
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

      <OrderModals controller={controller} />





    </section>
  );
}
