import { Card, Dropdown, Input, Segmented, Space, Spin, Typography } from "antd";
import type { BusinessCenterEntryTab } from "../businessCenter";
import { DataTable, DateRangeField, PermissionButton, Select, StatRow } from "../../shared/ui";
import { OrderDetail, type InventoryPartyLink } from "../orderedit";
import { countBusinessOrders } from "./helpers";
import type { BusinessFilterKey, BusinessModeFilterKey } from "./helpers";
import type { OrdersPageController } from "./useOrdersPageController";
import { markMobileHiddenColumns } from "../../shared/lib/listColumns";
import { useMemo } from "react";

/** ≤640px 隐藏列：原规则写 nth-child(4)，但表格有展开列占位，实测命中的是
 *  「游戏账号/产品」而非入库负责人。本次保持默认隐藏目标不变，只把序号换成稳定 key，
 *  避免「设置 → 列表字段」过滤/调序后隐藏错列。 */
const LEDGER_MOBILE_HIDDEN_KEYS = ["account_game_account"] as const;

export function OrdersLedgerPanel({ controller, onNavigate }: {
  controller: OrdersPageController;
  onNavigate?: (key: string, tab?: BusinessCenterEntryTab) => void;
}) {
  const {
    arrangeLedgerColumns,
    businessModeFilter,
    dateRange,
    expandedOrderIds,
    filteredOrders,
    gameTypeFilter,
    gameTypeOptions,
    handleLedgerExpand,
    inventoryStatusFilter,
    inventoryStatusOptions,
    keyword,
    ledgerColumns,
    ledgerDetailLoading,
    ledgerDetails,
    ledgerExporting,
    ledgerSortDesc,
    loadError,
    loading,
    onExportLedger,
    onExportLedgerXlsx,
    orderBusinessModeOptions,
    orderBusinessOptions,
    orderTypeFilter,
    orders,
    page,
    pageSize,
    setBusinessModeFilter,
    setDateRange,
    setGameTypeFilter,
    setInventoryStatusFilter,
    setKeyword,
    setLedgerSortDesc,
    setOrderTypeFilter,
    setPage,
    setPageSize,
    editingAccount,
    setEditingAccount,
    inlineEditId,
    eventDrafts,
    updateEventDraft,
    timeDrafts,
    updateTimeDraft,
    orderDrafts,
    updateOrderDraft,
    partyDrafts,
    updatePartyDraft,
    employees,
    orderEditExtraForm,
    savingAccount,
    cancelInlineEdit,
    saveInline,
  } = controller;

  const statValue = (value: number) => (loading ? "—" : loadError ? "不可用" : String(value));
  const stats = useMemo(() => filteredOrders.reduce((summary, order) => {
    summary.total += 1;
    if (["ACTIVE", "INSTALLMENT"].includes(order.status)) summary.active += 1;
    else if (order.status === "COMPLETED") summary.completed += 1;
    else if (order.status === "CANCELLED") summary.cancelled += 1;
    return summary;
  }, { total: 0, active: 0, completed: 0, cancelled: 0 }), [filteredOrders]);

  return (
    <section className="ui-stack">
      <StatRow items={[
        { label: "订单总量", kind: "count", amount: statValue(stats.total) },
        { label: "进行中订单", kind: "count", amount: statValue(stats.active) },
        { label: "完成订单量", kind: "count", amount: statValue(stats.completed) },
        { label: "已取消订单", kind: "count", amount: statValue(stats.cancelled) },
      ]} />
      <Card className="glass">
        <Space wrap className="ui-filter-bar ui-filter-bar--spaced">
          <Input
            allowClear
            value={keyword}
            placeholder="搜索订单号 / 游戏账号/产品 / 对方 / 备注"
            aria-label="搜索订单"
            className="ui-ledger-search"
            onChange={(event) => { setKeyword(event.target.value); setPage(1); }}
          />
          <DateRangeField
            ariaLabel="订单日期区间"
            rangeId="orders-date-range"
            placeholder={["开始日期", "结束日期"]}
            format="YYYY-MM-DD"
            size="small"
            classNames={{ popup: { root: "compact-date-range-picker" } }}
            value={dateRange}
            onChange={(value) => { setDateRange(value?.[0] && value[1] ? [value[0], value[1]] : null); setPage(1); }}
          />
          <Typography.Text strong>游戏类型筛选</Typography.Text>
          <Select aria-label="游戏类型筛选" className="ui-filter-select" value={gameTypeFilter} options={gameTypeOptions} onChange={(value) => { setGameTypeFilter(value); setPage(1); }} />
          <Typography.Text strong>库存状态筛选</Typography.Text>
          <Select aria-label="库存状态筛选" className="ui-filter-select" value={inventoryStatusFilter} options={inventoryStatusOptions} onChange={(value) => { setInventoryStatusFilter(value); setPage(1); }} />
          <Typography.Text strong>类型筛选</Typography.Text>
          <Segmented
            aria-label="类型筛选"
            value={orderTypeFilter}
            options={[
              { value: "all", label: `全部 ${countBusinessOrders(orders, "all", businessModeFilter)}` },
              ...orderBusinessOptions.map((item) => ({ value: item.value, label: `${item.label} ${countBusinessOrders(orders, item.value as BusinessFilterKey, businessModeFilter)}` })),
            ]}
            onChange={(value) => { setOrderTypeFilter(value as BusinessFilterKey); setPage(1); }}
          />
          <Typography.Text strong>业务筛选</Typography.Text>
          <Segmented
            aria-label="业务筛选"
            value={businessModeFilter}
            options={[{ value: "all", label: "全部业务" }, ...orderBusinessModeOptions.map((item) => ({ value: item.value, label: item.label }))]}
            onChange={(value) => { setBusinessModeFilter(value as BusinessModeFilterKey); setPage(1); }}
          />
          <Typography.Text strong>排序</Typography.Text>
          <Segmented
            aria-label="台账排序"
            value={ledgerSortDesc ? "desc" : "asc"}
            options={[{ value: "desc", label: "最新在前" }, { value: "asc", label: "最旧在前" }]}
            onChange={(value) => { setLedgerSortDesc(value === "desc"); setPage(1); }}
          />
          {/* 导出格式靠下拉选择，触发按钮保持「导出」两字：UI 规范要求筛选栏文案简短 */}
          <Dropdown
            disabled={ledgerExporting}
            trigger={["click"]}
            menu={{
              items: [
                { key: "xlsx", label: "导出 Excel（5 个 sheet：订单 + 详情 + 三类明细）" },
                { key: "csv", label: "导出 CSV（单表，单行表头）" },
              ],
              onClick: ({ key }) => {
                if (key === "xlsx") void onExportLedgerXlsx();
                else void onExportLedger();
              },
            }}
          >
            <PermissionButton permission="finance.read" size="small" loading={ledgerExporting}>导出</PermissionButton>
          </Dropdown>

        </Space>
        <DataTable
          columns={markMobileHiddenColumns(arrangeLedgerColumns(ledgerColumns), LEDGER_MOBILE_HIDDEN_KEYS)}
          rows={filteredOrders}
          loading={loading}
          page={page}
          pageSize={pageSize}
          total={filteredOrders.length}
          emptyText="暂无业务订单"
          ariaLabel="订单台账表格"
          className="orders-ledger"
          expandable={{
            expandedRowKeys: expandedOrderIds,
            onExpand: handleLedgerExpand,
            expandedRowRender: (order) => {
              const accountId = order.account_id ?? null;
              if (accountId === null) return <Typography.Text type="secondary">该订单未关联库存账号，暂无库存详情。</Typography.Text>;
              const detail = ledgerDetails[accountId];
              if (!detail) return <Spin size="small" />;
              return (
                <OrderDetail
                  row={detail.account}
                  className="inventory-detail--ledger"
                  detail={detail}
                  contextOrderNo={order.order_no}
                  loading={Boolean(ledgerDetailLoading[accountId])}
                  onPartyClick={(party: InventoryPartyLink) => onNavigate?.(party.entityType === "customer" ? `customers?customer_id=${party.id}` : `customers?counterparty_id=${party.id}`)}
                  editing={inlineEditId === detail.account.id ? editingAccount : undefined}
                  onEdit={setEditingAccount}
                  eventDrafts={eventDrafts}
                  onEventEdit={updateEventDraft}
                  timeDrafts={timeDrafts}
                  onTimeEdit={updateTimeDraft}
                  orderDrafts={orderDrafts}
                  onOrderEdit={updateOrderDraft}
                  partyDrafts={partyDrafts}
                  onPartyEdit={updatePartyDraft}
                  employees={employees}
                  extraForm={orderEditExtraForm}
                  onSave={saveInline}
                  onCancel={cancelInlineEdit}
                  saving={savingAccount}
                />
              );
            },
          }}
          onPageChange={(nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize); }}
        />
      </Card>
    </section>
  );
}
