import { Card, Input, Segmented, Space, Typography } from "antd";
import { DataTable, DateRangeField, PermissionButton, Select } from "../../shared/ui";
import { OrderDetail } from "../../orders/orderedit";
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
    expandedAccountIds,
    gameTypeFilter,
    gameTypeOptions,
    handleExpand,
    handleExport,
    inventoryType,
    inventoryTypeOptions,
    inventoryStatus,
    inventoryStatusOptions,
    inlineEditId,
    orderEditExtraForm,
    keyword,
    orderedRows,
    page,
    pageSize,
    savingAccount,
    setDateRange,
    setBusinessMode,
    setGameTypeFilter,
    setInventoryType,
    setInventoryStatus,
    setPage,
    setPageSize,
    setSortDesc,
    sortDesc,
    exporting,
    editingAccount,
    eventDrafts,
    timeDrafts,
    updateTimeDraft,
    orderDrafts,
    updateOrderDraft,
    partyDrafts,
    updatePartyDraft,
    employees,
    updateEventDraft,
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
        <DateRangeField
          ariaLabel="库存日期区间"
          rangeId="inventory-date-range"
          placeholder={["开始日期", "结束日期"]}
          format="YYYY-MM-DD"
          size="small"
          classNames={{ popup: { root: "compact-date-range-picker" } }}
          value={dateRange}
          onChange={(value) => {
            setDateRange(value?.[0] && value[1] ? [value[0], value[1]] : null);
            setPage(1);
          }}
        />
        <Typography.Text strong>游戏类型筛选</Typography.Text>
        <Select
          aria-label="游戏类型筛选"
          className="ui-filter-select"
          value={gameTypeFilter ?? "all"}
          options={[{ value: "all", label: "全部游戏类型" }, ...gameTypeOptions]}
          onChange={(value) => { setGameTypeFilter(value === "all" ? undefined : value); setPage(1); }}
        />
        <Typography.Text strong>类型筛选</Typography.Text>
        <Segmented
          aria-label="库存类型筛选"
          value={inventoryType ?? "all"}
          options={[
            { value: "all", label: `全部 ${countInventoryRows()}` },
            ...(inventoryTypeOptions ?? []).map((item) => ({ value: item.value, label: `${item.label} ${countInventoryRows(item.value)}` })),
          ]}
          onChange={(value) => { setInventoryType(value === "all" ? undefined : String(value)); setPage(1); }}
        />
        <Typography.Text strong>库存状态筛选</Typography.Text>
        <Segmented
          aria-label="库存状态筛选"
          value={inventoryStatus}
          options={inventoryStatusOptions}
          onChange={(value) => setInventoryStatus(value as "WAITING" | "SOLD")}
        />
        <Typography.Text strong>业务筛选</Typography.Text>
        <Segmented
          aria-label="库存业务筛选"
          value={businessMode ?? "all"}
          options={[{ value: "all", label: "全部业务" }, ...(businessOptions ?? []).map((item) => ({ value: item.value, label: item.label }))]}
          onChange={(value) => { setBusinessMode(value === "all" ? undefined : String(value)); setPage(1); }}
        />
        <Typography.Text strong>排序</Typography.Text>
        <Segmented
          aria-label="库存排序"
          value={sortDesc ? "desc" : "asc"}
          options={[{ value: "desc", label: "最新在前" }, { value: "asc", label: "最旧在前" }]}
          onChange={(value) => { setSortDesc(value === "desc"); setPage(1); }}
        />
        <PermissionButton permission="report.read" aria-label="导出" size="small" loading={exporting} onClick={() => void handleExport()}>导出</PermissionButton>
      </Space>
      <DataTable
        key={`account-ledger-${expandedAccountIds.join("|")}`}
        className="inventory-table inventory-table--single-scroll"
        columns={arrangeColumns(columns)}
        rows={orderedRows}
        page={page}
        pageSize={pageSize}
        total={controller.visibleRows.length}
        controlledPaging
        expandable={{
          expandedRowKeys: expandedAccountIds,
          expandedRowRender: (row) => (
            <OrderDetail
              row={row}
              detail={executionDetails[row.id]}
              loading={Boolean(executionLoading[row.id])}
              onPartyClick={openPartyCard}
              editing={inlineEditId === row.id ? editingAccount : undefined}
              onEdit={controller.setEditingAccount}
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
          ),
          expandRowByClick: true,
          onExpand: (expanded, row) => void handleExpand(expanded, row),
        }}
        emptyText="暂无账号"
        ariaLabel="库存台账表格"
        onPageChange={(nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize); }}
      />
    </Card>
  );
}
