import { SearchInput } from "../../shared/ui/SearchInput";
import { TimeOrderControl } from "../../shared/ui/TimeOrderControl";
import { ToolbarSelect } from "../../shared/ui/ToolbarSelect";
import { Card, Dropdown, Segmented, Space, Spin, Tag } from "antd";
import type { BusinessCenterEntryTab } from "../businessCenter";
import { DataTable, ExportButton, StatRow } from "../../shared/ui";
import { OrderDetail } from "../shared/order-detail/OrderDetail";
import { BusinessDateRangeFilter } from "../shared/BusinessDateRangeFilter";
import { ReferenceDataErrors } from "../shared/order-detail/editing/ReferenceDataErrors";
import { UnboundOrderDetail } from "./UnboundOrderDetail";
import type { OrderPartyLink } from "../shared/order-detail/OrderDetail.shared";
import type { BusinessFilterKey, BusinessModeFilterKey } from "./helpers";
import type { OrdersPageController } from "./useOrdersPageController";
import { markMobileHiddenColumns, markMobileIdentityColumn } from "../../shared/lib/listColumns";
import { ORDER_STATUS_LABEL } from "../../shared/lib/format";
import { ToolbarMultiSelect } from "../../shared/ui/ToolbarMultiSelect";
import "../shared/BusinessLedger.css";
import "./OrdersLedgerPanel.css";
import type { ReactNode } from "react";
import { indexEmployeeNames } from "../shared/employee-names";

/** ≤640px 隐藏列：原规则写 nth-child(4)，但表格有展开列占位，实测命中的是
 *  「游戏账号/产品」而非入库操作人。本次保持默认隐藏目标不变，只把序号换成稳定 key，
 *  避免「设置 → 列表字段」过滤/调序后隐藏错列。 */
const LEDGER_MOBILE_HIDDEN_KEYS = ["account_game_account"] as const;

export function OrdersLedgerPanel({ controller, onNavigate, createAction }: {
  controller: OrdersPageController;
  createAction?: ReactNode;
  onNavigate?: (key: string, tab?: BusinessCenterEntryTab) => void;
}) {
  const {
    arrangeLedgerColumns,
    businessModeFilter,
    dateRange,
    expandedOrderIds,
    filteredOrders,
    ledgerSummary,
    summaryLoading,
    summaryError,
    gameTypeFilter,
    gameTypeOptions,
    handleLedgerExpand,
    inventoryStatusFilter,
    inventoryStatusOptions,
    inventoryOperatorIds,
    saleOperatorIds,
    myOperator,
    setMineOrders,
    keyword,
    ledgerColumns,
    ledgerOrderDetailLoading,
    ledgerOrderDetails,
    ledgerExporting,
    ledgerSortDesc,
    loading,
    onExportLedger,
    onExportLedgerXlsx,
    orderBusinessModeOptions,
    orderBusinessOptions,
    orderStatusFilter,
    orderTypeFilter,
    page,
    pageTotal,
    pageSize,
    setBusinessModeFilter,
    setDateRange,
    setGameTypeFilter,
    setInventoryStatusFilter,
    setInventoryOperatorIds,
    setSaleOperatorIds,
    setKeyword,
    setLedgerSortDesc,
    setOrderTypeFilter,
    setOrderStatusFilter,
    setPage,
    setPageSize,
    editingAccount,
    inlineEditId,
    eventDrafts,
    operationDrafts,
    updateEventDraft,
    updateOperationDraft,
    addOperationDraft,
    removeOperationDraft,
    employees,
    pools,
    operatorUsername,
    invEditExtraForm,
    savingAccount,
    cancelInlineEdit,
    saveInline,
    openLedgerEditor,
  } = controller;

  const statValue = (value: number | undefined) => (summaryLoading ? "—" : summaryError || typeof value !== "number" || !Number.isFinite(value) ? "不可用" : String(value));
  const typeCount = (key: BusinessFilterKey) => summaryLoading || summaryError || !ledgerSummary ? "—" : key === "all"
    ? ledgerSummary.type_total ?? "—"
    : ledgerSummary.type_counts[key] ?? 0;
  const operatorOptions = [
    ...employees.filter((employee) => employee.is_active).map((employee) => ({ value: employee.id, label: employee.display_name })),
    ...(myOperator && !employees.some((employee) => employee.id === myOperator.id)
      ? [{ value: myOperator.id, label: myOperator.display_name }]
      : []),
  ];
  const operatorNames = indexEmployeeNames(operatorOptions.map((option) => ({ id: option.value, display_name: option.label })));

  return (
    <section className="ui-stack orders-ledger-panel">
      <Card className="glass orders-ledger-card" title="订单台账" extra={createAction}>
        <Space wrap className="ui-filter-bar ui-filter-bar--spaced business-ledger-filters">
          <SearchInput
            allowClear
            searchButtonLabel="执行订单搜索"
            onSearch={(_value, _event, info) => { if (info?.source !== "clear") controller.submitSearch(); }}
            value={keyword}
            placeholder="搜索订单号 / 账号 / 对方 / 备注 / 买入价 / 售出价"
            aria-label="搜索订单"
            className="ui-ledger-search ui-filter-search"
            onChange={(event) => { setKeyword(event.target.value); setPage(1); }}
          />
          <BusinessDateRangeFilter
            label="订单日期区间"
            value={dateRange}
            onChange={(value) => { setDateRange(value); setPage(1); }}
          />
          {orderStatusFilter !== "all" ? (
            <Tag
              closable
              closeIcon={<span aria-label="清除订单状态筛选">×</span>}
              onClose={() => { setOrderStatusFilter("all"); setPage(1); }}
            >
              订单状态：{orderStatusFilter === "IN_PROGRESS" ? "进行中" : ORDER_STATUS_LABEL[orderStatusFilter] ?? orderStatusFilter}
            </Tag>
          ) : null}
          <ToolbarSelect aria-label="游戏类型筛选" value={gameTypeFilter} options={gameTypeOptions} onChange={(value) => { setGameTypeFilter(value); setPage(1); }} />
          <ToolbarSelect aria-label="库存状态筛选" value={inventoryStatusFilter} options={inventoryStatusOptions} onChange={(value) => { setInventoryStatusFilter(value); setPage(1); }} />
          <ToolbarMultiSelect
            allowClear
            aria-label="入库负责人筛选"
            selectedLabels={inventoryOperatorIds.map((id) => operatorNames.get(id) ?? String(id))}
            placeholder="入库负责人"
            value={inventoryOperatorIds}
            options={operatorOptions}
            onChange={(values) => { setMineOrders(false); setInventoryOperatorIds((values as number[]).map(Number)); setPage(1); }}
          />
          <ToolbarMultiSelect
            allowClear
            aria-label="售出操作人筛选"
            selectedLabels={saleOperatorIds.map((id) => operatorNames.get(id) ?? String(id))}
            placeholder="售出操作人"
            value={saleOperatorIds}
            options={operatorOptions}
            onChange={(values) => { setMineOrders(false); setSaleOperatorIds((values as number[]).map(Number)); setPage(1); }}
          />
          <Segmented
            value={orderTypeFilter}
            options={[
              { value: "all", label: `全部 ${typeCount("all")}` },
              ...orderBusinessOptions.map((item) => ({ value: item.value, label: `${item.label} ${typeCount(item.value as BusinessFilterKey)}` })),
            ]}
            onChange={(value) => { setOrderTypeFilter(value as BusinessFilterKey); setPage(1); }}
          />
          <Segmented
            value={businessModeFilter}
            options={[{ value: "all", label: "全部业务" }, ...orderBusinessModeOptions.map((item) => ({ value: item.value, label: item.label }))]}
            onChange={(value) => { setBusinessModeFilter(value as BusinessModeFilterKey); setPage(1); }}
          />
          <TimeOrderControl descending={ledgerSortDesc} onChange={(value) => { setLedgerSortDesc(value); setPage(1); }} />
          {/* 导出格式靠下拉选择，触发按钮保持「导出」两字：UI 规范要求筛选栏文案简短 */}
          <Dropdown
            disabled={ledgerExporting}
            trigger={["click"]}
            menu={{
              items: [
                { key: "xlsx", label: "导出工作簿（5 个工作表：订单 + 详情 + 三类明细）" },
                { key: "csv", label: "导出表格（单表，单行表头）" },
              ],
              onClick: ({ key }) => {
                if (key === "xlsx") void onExportLedgerXlsx();
                else void onExportLedger();
              },
            }}
          >
            <ExportButton permission="report.export" loading={ledgerExporting} />
          </Dropdown>

        </Space>
        <StatRow items={[
          { label: "订单总量", kind: "count", amount: statValue(ledgerSummary?.total_count) },
          { label: "进行中订单", kind: "count", amount: statValue(ledgerSummary?.in_progress_count) },
          { label: "完成订单量", kind: "count", amount: statValue(ledgerSummary?.completed_count) },
          { label: "已取消订单", kind: "count", amount: statValue(ledgerSummary?.cancelled_count) },
        ]} />
        <DataTable
          columns={markMobileIdentityColumn(markMobileHiddenColumns(arrangeLedgerColumns(ledgerColumns), LEDGER_MOBILE_HIDDEN_KEYS), "order_no")}
          rows={filteredOrders}
          loading={loading}
          page={page}
          pageSize={pageSize}
          total={pageTotal}
          controlledPaging
          emptyText="暂无业务订单"
          className="ui-datatable--expandable inventory-table orders-ledger"
          expandable={{
            expandedRowKeys: expandedOrderIds,
            expandRowByClick: true,
            onExpand: handleLedgerExpand,
            expandedRowRender: (order) => {
              const accountId = order.account_id ?? null;
              if (accountId === null) return <UnboundOrderDetail orderId={order.id} />;
              const detail = ledgerOrderDetails[order.id];
              if (!detail) return <Spin size="small" />;
              return (<>
                {inlineEditId === detail.account.id ? <ReferenceDataErrors employeeError={controller.employeeError} poolError={controller.poolError} retryEmployees={controller.retryEmployees} retryPools={controller.retryPools} /> : null}
                <OrderDetail
                  row={detail.account}
                  detail={detail}
                  contextOrderId={order.id}
                  loading={Boolean(ledgerOrderDetailLoading[order.id])}
                  onPartyClick={(party: OrderPartyLink) => onNavigate?.(party.entityType === "customer" ? `customers?customer_id=${party.id}` : `customers?counterparty_id=${party.id}`)}
                  editing={inlineEditId === detail.account.id ? editingAccount : undefined}
                  eventDrafts={eventDrafts}
                  operationDrafts={operationDrafts}
                  onEventEdit={updateEventDraft}
                  onOperationEdit={updateOperationDraft}
                  onAddOperationRow={addOperationDraft}
                  onRemoveOperationRow={removeOperationDraft}
                  financeDrafts={controller.financeDrafts}
                  onFinanceEdit={controller.updateFinanceDraft}
                  onProfileChange={controller.updateEditingAccount}
                  orderDrafts={controller.orderDrafts}
                  onOrderEdit={controller.updateOrderDraft}
                  onOrderExtraChange={(orderId, key, value) => controller.updateOrderDraft(orderId, { form_extra: { [key]: value } })}
                  onPartyEdit={controller.updatePartyDraft}
                  employees={employees}
                  pools={pools}
                  operatorUsername={operatorUsername}
                  extraForm={invEditExtraForm}
                  onSave={saveInline}
                  onCancel={cancelInlineEdit}
                  saving={savingAccount}
                />
              </>);
            },
          }}
          onPageChange={(nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize); }}
        />
      </Card>
    </section>
  );
}
