import { SearchInput } from "../../../shared/ui/SearchInput";
import { TimeOrderControl } from "../../../shared/ui/TimeOrderControl";
import { ToolbarSelect } from "../../../shared/ui/ToolbarSelect";
import { Card, DatePicker, Segmented, Space } from "antd";
import { DataTable, ExportButton, StatRow } from "../../../shared/ui";
import { OrderDetail } from "../../shared/order-detail/OrderDetail";
import type { InventoryController } from "./useInventoryController";
import { ToolbarMultiSelect } from "../../../shared/ui/ToolbarMultiSelect";
import type { ReactNode } from "react";
import { indexEmployeeNames } from "../../employee-names";
import "../../BusinessLedger.css";

export function InventoryLedger({ controller, createAction }: { controller: InventoryController; createAction?: ReactNode }) {
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
    inventoryOperatorIds,
    ageGtDays,
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
    setInventoryOperatorIds,
    setAgeGtDays,
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
    operatorUsername,
    updateEventDraft,
    updateOperationDraft,
    addOperationDraft,
    removeOperationDraft,
    updateFinanceDraft,
    updateEditingAccount,
    orderDrafts,
    updateOrderDraft,
    updatePartyDraft,
    saveInline,
    cancelInlineEdit,
    openPartyCard,
  } = controller;

  const employeeNames = indexEmployeeNames(employees);

  return (
    <Card className="glass" title="库存中心" extra={createAction}>
      <Space wrap className="ui-filter-bar ui-filter-bar--spaced business-ledger-filters">
        <SearchInput
          allowClear
          searchButtonLabel="搜索库存账号"
          onSearch={(_value, _event, info) => { if (info?.source !== "clear") controller.submitSearch(); }}
          value={keyword}
          placeholder="搜索账号 / 产品 / 游戏类型 / 区服 / 成本"
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
        <ToolbarSelect
          aria-label="游戏类型筛选"

          value={gameTypeFilter ?? "all"}
          options={[{ value: "all", label: "全部游戏类型" }, ...gameTypeOptions]}
          onChange={(value) => { setGameTypeFilter(value === "all" ? undefined : value); setPage(1); }}
        />
        <ToolbarMultiSelect
          allowClear
          aria-label="入库负责人筛选"
          selectedLabels={inventoryOperatorIds.map((id) => employeeNames.get(id) ?? String(id))}
          placeholder="入库负责人"
          value={inventoryOperatorIds}
          options={employees.filter((employee) => employee.is_active).map((employee) => ({ value: employee.id, label: employee.display_name }))}
          onChange={(values) => { setInventoryOperatorIds((values as number[]).map(Number)); setPage(1); }}
        />
        <ToolbarSelect
          aria-label="库存库龄筛选"

          value={ageGtDays ?? "all"}
          options={[{ value: "all", label: "全部库龄" }, { value: 7, label: "超过 7 天" }, { value: 30, label: "超过 30 天" }]}
          onChange={(value) => { setAgeGtDays(value === "all" ? undefined : Number(value)); setPage(1); }}
        />
        <Segmented
          aria-label="库存类型筛选"
          value={inventoryType ?? "all"}
          options={[
            { value: "all", label: `全部 ${controller.listLoading || controller.listError ? "—" : countInventoryRows()}` },
            ...(inventoryTypeOptions ?? []).map((item) => ({ value: item.value, label: `${item.label} ${controller.listLoading || controller.listError ? "—" : countInventoryRows(item.value)}` })),
          ]}
          onChange={(value) => { setInventoryType(value === "all" ? undefined : String(value)); setPage(1); }}
        />
        <Segmented
          aria-label="库存业务筛选"
          value={businessMode ?? "all"}
          options={[{ value: "all", label: "全部业务" }, ...(businessOptions ?? []).map((item) => ({ value: item.value, label: item.label }))]}
          onChange={(value) => { setBusinessMode(value === "all" ? undefined : String(value)); setPage(1); }}
        />
        <TimeOrderControl descending={sortDesc} onChange={(value) => { setSortDesc(value); setPage(1); }} />
        <ExportButton permission="report.read" aria-label="导出" loading={exporting} onClick={() => void handleExport()} />
      </Space>
      <StatRow items={[
        { label: "在库账号", kind: "count", amount: !controller.listLoading && controller.inventoryStats ? String(controller.inventoryStats.account_count) : "—" },
        { label: "占用成本合计", amount: controller.listLoading ? "—" : controller.inventoryStats?.occupied_cost ?? "—" },
        { label: "超7天库存账号", kind: "count", amount: !controller.listLoading && controller.inventoryStats ? String(controller.inventoryStats.over_7d_count) : "—" },
        { label: "超30天库存账号", kind: "count", amount: !controller.listLoading && controller.inventoryStats ? String(controller.inventoryStats.over_30d_count) : "—" },
      ]} />
      <DataTable
        className="ui-datatable--expandable inventory-table"
        columns={arrangeColumns(columns)}
        rows={rows}
        loading={controller.listLoading}
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
              onRemoveOperationRow={removeOperationDraft}
              financeDrafts={financeDrafts}
              onFinanceEdit={updateFinanceDraft}
              onProfileChange={updateEditingAccount}
              orderDrafts={orderDrafts}
              onOrderEdit={updateOrderDraft}
              onOrderExtraChange={updateOrderDraft && ((orderId, key, value) => updateOrderDraft(orderId, { form_extra: { [key]: value } }))}
              onPartyEdit={updatePartyDraft}
              employees={employees}
              operatorUsername={operatorUsername}
              extraForm={invEditExtraForm}
              onSave={saveInline}
              onCancel={cancelInlineEdit}
              saving={savingAccount}
            />
          ),
          expandRowByClick: true,
          onExpand: (expanded, row) => void handleExpand(expanded, row),
        }}
        emptyText={controller.listError ? "库存数据不可用，请点击重新加载" : "暂无账号"}
        pagination={controller.listError ? false : undefined}
        onPageChange={(nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize); }}
      />
    </Card>
  );
}
