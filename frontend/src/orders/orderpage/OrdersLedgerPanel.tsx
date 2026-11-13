import { Button, Card, DatePicker, Dropdown, Input, Segmented, Space, Spin, Typography } from "antd";
import { ArrowDownOutlined, ArrowUpOutlined } from "@ant-design/icons";
import type { BusinessCenterEntryTab } from "../businessCenter";
import { DataTable, PermissionButton, Select, StatRow } from "../../shared/ui";
import { OrderDetail } from "../../stocks/OrderDetail";
import type { InventoryPartyLink } from "../../stocks/OrderDetailView/OrderDetail.shared";
import { countBusinessOrders } from "./helpers";
import type { BusinessFilterKey, BusinessModeFilterKey } from "./helpers";
import type { OrdersPageController } from "./useOrdersPageController";
import { markMobileHiddenColumns } from "../../shared/lib/listColumns";
import "./OrdersLedgerPanel.css";

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
    ledgerOrderDetailLoading,
    ledgerOrderDetails,
    ledgerExporting,
    ledgerSortDesc,
    loadError,
    loading,
    onExportLedger,
    onExportLedgerXlsx,
    orderBusinessModeOptions,
    orderBusinessOptions,
    orderTypeFilter,
    page,
    typeCountBase,
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
    inlineEditId,
    eventDrafts,
    updateEventDraft,
    employees,
    timeShiftMinutes,
    setTimeShiftDays,
    invEditExtraForm,
    savingAccount,
    cancelInlineEdit,
    saveInline,
    openLedgerEditor,
  } = controller;

  const statValue = (value: number) => (loading ? "—" : loadError ? "不可用" : String(value));
  // 计数基线由 useLedgerList 提供（已应用关键词/日期/游戏类型/库存状态/业务模式，独独不含「类型」），
  // 与「订单总量」卡片同口径；用原始 orders 计数会出现「全部 627 / 订单总量 12」的自相矛盾。
  const typeCount = (key: BusinessFilterKey) => countBusinessOrders(typeCountBase, key, businessModeFilter);

  return (
    <section className="ui-stack orders-ledger-panel">
      <StatRow items={[
        { label: "订单总量", kind: "count", amount: statValue(filteredOrders.length) },
        { label: "进行中订单", kind: "count", amount: statValue(filteredOrders.filter((order) => ["ACTIVE", "INSTALLMENT"].includes(order.status)).length) },
        { label: "完成订单量", kind: "count", amount: statValue(filteredOrders.filter((order) => order.status === "COMPLETED").length) },
        { label: "已取消订单", kind: "count", amount: statValue(filteredOrders.filter((order) => order.status === "CANCELLED").length) },
      ]} />
      <Card className="glass orders-ledger-card">
        <Space wrap className="ui-filter-bar ui-filter-bar--spaced inventory-filters orders-ledger-filters">
          <Input
            allowClear
            value={keyword}
            placeholder="搜索订单号 / 游戏账号/产品 / 对方 / 备注"
            aria-label="搜索订单"
            className="ui-ledger-search"
            onChange={(event) => { setKeyword(event.target.value); setPage(1); }}
          />
          <DatePicker.RangePicker
            aria-label="订单日期区间"
            placeholder={["开始日期", "结束日期"]}
            format="YYYY-MM-DD"
            size="small"
            placement="bottomLeft"
            classNames={{ popup: { root: "compact-date-range-picker" } }}
            value={dateRange}
            onChange={(value) => { setDateRange(value?.[0] && value[1] ? [value[0], value[1]] : null); setPage(1); }}
          />
          <Select aria-label="游戏类型筛选" className="ui-filter-select" value={gameTypeFilter} options={gameTypeOptions} onChange={(value) => { setGameTypeFilter(value); setPage(1); }} />
          <Select aria-label="库存状态筛选" className="ui-filter-select" value={inventoryStatusFilter} options={inventoryStatusOptions} onChange={(value) => { setInventoryStatusFilter(value); setPage(1); }} />
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
          <Typography.Text strong className="orders-ledger-filter-label">排序</Typography.Text>
          <Space.Compact className="ledger-sort-actions" aria-label="台账排序">
            <Button
              size="small"
              type="text"
              icon={<ArrowDownOutlined />}
              aria-label="最新在前"
              title="最新在前"
              onClick={() => { setLedgerSortDesc(true); setPage(1); }}
            />
            <Button
              size="small"
              type="text"
              icon={<ArrowUpOutlined />}
              aria-label="最旧在前"
              title="最旧在前"
              onClick={() => { setLedgerSortDesc(false); setPage(1); }}
            />
          </Space.Compact>
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
          className="inventory-table orders-ledger"
          expandable={{
            expandedRowKeys: expandedOrderIds,
            expandRowByClick: true,
            onExpand: handleLedgerExpand,
            expandedRowRender: (order) => {
              const accountId = order.account_id ?? null;
              if (accountId === null) return <Typography.Text type="secondary">该订单未关联库存账号，暂无库存详情。</Typography.Text>;
              const detail = ledgerOrderDetails[order.id];
              if (!detail) return <Spin size="small" />;
              return (
                <OrderDetail
                  row={detail.account}
                  detail={detail}
                  contextOrderId={order.id}
                  loading={Boolean(ledgerOrderDetailLoading[order.id])}
                  onPartyClick={(party: InventoryPartyLink) => onNavigate?.(party.entityType === "customer" ? `customers?customer_id=${party.id}` : `customers?counterparty_id=${party.id}`)}
                  editing={inlineEditId === detail.account.id ? editingAccount : undefined}
                  eventDrafts={eventDrafts}
                  onEventEdit={updateEventDraft}
                  employees={employees}
                  extraForm={invEditExtraForm}
                  onSave={saveInline}
                  onCancel={cancelInlineEdit}
                  saving={savingAccount}
                  timeShiftMinutes={timeShiftMinutes}
                  onTimeShift={setTimeShiftDays}
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
