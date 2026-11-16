import { Button, Card, DatePicker, Input, Segmented, Space, Typography } from "antd";
import { ArrowDownOutlined, ArrowUpOutlined } from "@ant-design/icons";
import { DataTable, PermissionButton, Select } from "../../shared/ui";
import { OrderDetail } from "../../orders/OrderDetailView/OrderDetail";
import type { InventoryController } from "./useInventoryController";

export function InventoryLedger({ controller }: { controller: InventoryController }) {
  const {
    businessMode,
    businessOptions,
    arrangeColumns,
    columns,
    countInventoryRows,
    dateRange,
    executionDetails,
    executionLoading,
    orderExecutionDetails,
    orderExecutionLoading,
    expandedOrderIds,
    gameTypeFilter,
    gameTypeOptions,
    handleExpand,
    handleExport,
    inventoryType,
    inventoryTypeOptions,
    inlineEditId,
    invEditExtraForm,
    keyword,
    rows,
    page,
    pageSize,
    savingAccount,
    setDateRange,
    setBusinessMode,
    setGameTypeFilter,
    setInventoryType,
    setPage,
    setPageSize,
    setSortDesc,
    sortDesc,
    exporting,
    editingAccount,
    eventDrafts,
    operationDrafts,
    financeDrafts,
    employees,
    updateEventDraft,
    updateOperationDraft,
    addOperationDraft,
    updateFinanceDraft,
    updateEditingAccount,
    orderDrafts,
    updateOrderDraft,
    updatePartyDraft,
    saveInline,
    cancelInlineEdit,
    openPartyCard,
  } = controller;

  return (
    <Card className="glass">
      <Space wrap className="ui-filter-bar ui-filter-bar--spaced inventory-filters">
        <Input
          allowClear
          value={keyword}
          placeholder="搜索游戏账号/产品 / 游戏/产品类型 / 平台"
          aria-label="搜索库存账号"
          className="ui-ledger-search"
          onChange={(event) => { controller.setKeyword(event.target.value); setPage(1); }}
        />
        <DatePicker.RangePicker
          aria-label="库存日期区间"
          placeholder={["开始日期", "结束日期"]}
          format="YYYY-MM-DD"
          size="small"
          placement="bottomLeft"
          classNames={{ popup: { root: "compact-date-range-picker" } }}
          value={dateRange}
          onChange={(value) => {
            setDateRange(value?.[0] && value[1] ? [value[0], value[1]] : null);
            setPage(1);
          }}
        />
        <Select
          aria-label="游戏类型筛选"
          className="ui-filter-select"
          value={gameTypeFilter ?? "all"}
          options={[{ value: "all", label: "全部游戏类型" }, ...gameTypeOptions]}
          onChange={(value) => { setGameTypeFilter(value === "all" ? undefined : value); setPage(1); }}
        />
        <Segmented
          aria-label="库存类型筛选"
          value={inventoryType ?? "all"}
          options={[
            { value: "all", label: `全部 ${countInventoryRows()}` },
            ...(inventoryTypeOptions ?? []).map((item) => ({ value: item.value, label: `${item.label} ${countInventoryRows(item.value)}` })),
          ]}
          onChange={(value) => { setInventoryType(value === "all" ? undefined : String(value)); setPage(1); }}
        />
        <Segmented
          aria-label="库存业务筛选"
          value={businessMode ?? "all"}
          options={[{ value: "all", label: "全部业务" }, ...(businessOptions ?? []).map((item) => ({ value: item.value, label: item.label }))]}
          onChange={(value) => { setBusinessMode(value === "all" ? undefined : String(value)); setPage(1); }}
        />
        <Typography.Text strong>排序</Typography.Text>
        <Space.Compact className="ledger-sort-actions" aria-label="库存排序">
          <Button
            size="small"
            type="text"
            icon={<ArrowDownOutlined />}
            aria-label="最新在前"
            title="最新在前"
            onClick={() => { setSortDesc(true); setPage(1); }}
          />
          <Button
            size="small"
            type="text"
            icon={<ArrowUpOutlined />}
            aria-label="最旧在前"
            title="最旧在前"
            onClick={() => { setSortDesc(false); setPage(1); }}
          />
        </Space.Compact>
        <PermissionButton permission="report.read" aria-label="导出" size="small" loading={exporting} onClick={() => void handleExport()}>导出</PermissionButton>
      </Space>
      <DataTable
        className="inventory-table"
        columns={arrangeColumns(columns)}
        rows={rows}
        rowKey={(row) => `${row.id}:${row.account.id}`}
        page={page}
        pageSize={pageSize}
        total={controller.totalCount}
        controlledPaging
        expandable={{
          expandedRowKeys: expandedOrderIds,
          expandedRowRender: (row) => (
            <OrderDetail
              row={row.account}
              detail={orderExecutionDetails[row.id]}
              contextOrderId={row.id}
              loading={Boolean(orderExecutionLoading[row.id])}
              onPartyClick={openPartyCard}
              editing={inlineEditId === row.account.id ? editingAccount : undefined}
              eventDrafts={eventDrafts}
              operationDrafts={operationDrafts}
              onEventEdit={updateEventDraft}
              onOperationEdit={updateOperationDraft}
              onAddOperationRow={addOperationDraft}
              financeDrafts={financeDrafts}
              onFinanceEdit={updateFinanceDraft}
              onProfileChange={updateEditingAccount}
              orderDrafts={orderDrafts}
              onOrderEdit={updateOrderDraft}
              onOrderExtraChange={updateOrderDraft && ((orderId, key, value) => updateOrderDraft(orderId, { form_extra: { [key]: value } }))}
              onPartyEdit={updatePartyDraft}
              employees={employees}
              extraForm={invEditExtraForm}
              onSave={saveInline}
              onCancel={cancelInlineEdit}
              saving={savingAccount}
            />
          ),
          expandRowByClick: true,
          onExpand: (expanded, row) => void handleExpand(expanded, row),
        }}
        emptyText="暂无账号"
        onPageChange={(nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize); }}
      />
    </Card>
  );
}
