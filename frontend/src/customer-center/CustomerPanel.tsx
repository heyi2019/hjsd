import { SearchInput } from "../shared/ui/SearchInput";
import { TimeOrderControl } from "../shared/ui/TimeOrderControl";
import { ToolbarSelect } from "../shared/ui/ToolbarSelect";
import { SearchOutlined } from "@ant-design/icons";
import { Card, Space } from "antd";
import type { Customer } from "../shared/api/types/customers";
import { markMobileHiddenColumns } from "../shared/lib/listColumns";
import { DataTable, ErrorBanner, ExportButton, PermissionButton, PermissionGate, StatRow } from "../shared/ui";
import { CustomerCreateModal } from "./CustomerCreateModal";
import { CustomerDetailDrawer } from "./CustomerDetailDrawer";
import { CustomerEditModal } from "./CustomerEditModal";
import { CustomerMergeModal } from "./CustomerMergeModal";
import { useCustomerController } from "./useCustomerController";
import { useSession } from "../shared/state/session";
import type { ReactNode } from "react";
import { ToolbarMultiSelect } from "../shared/ui/ToolbarMultiSelect";

/** ≤640px 隐藏：联系方式与建立时间，详情里可看；状态与操作必须常驻。 */
const CUSTOMER_MOBILE_HIDDEN_KEYS = ["phone", "wechat", "qq", "created_at"] as const;

export function CustomerPanel({ active = true, focusId, orderFilter, onClearOrderFilter, createdPeriod, createdPicker }: { active?: boolean; focusId?: number; orderFilter?: { from?: string; to?: string }; onClearOrderFilter?: () => void; createdPeriod?: { from: string; to: string } | null; createdPicker?: ReactNode }) {
  const { username } = useSession();
  const {
    sortDesc, setSortDesc,
    activeDefs,
    actionError,
    actionPending,
    arrangeColumns,
    cancelEdit,
    cancelMerge,
    closeDetail,
    clearActionError,
    columns,
    createOpen,
    customerStatusOptions,
    creatorFilter,
    creatorOptions,
    detailData,
    detailId,
    detailError,
    detailLoading,
    detailTarget,
    editForm,
    editTarget,
    error,
    exportCustomers,
    exporting,
    fieldDefs,
    form,
    keyword,
    load,
    loading,
    mergeForm,
    mergeCandidates,
    mergeTarget,
    newThisMonthCount,
    newTodayCount,
    page,
    pageSize,
    renderContact,
    requestEdit,
    retryDetail,
    scheduleMergeSearch,
    rows,
    summary,
    summaryLoading,
    summaryError,
    searchInput,
    setCreateOpen,
    setCreatorFilter,
    setKeyword,
    setPage,
    setPageSize,
    setSearchInput,
    setStatusFilter,
    statusFilter,
    submitCreate,
    submitEdit,
    submitMerge,
    total,
  } = useCustomerController({ active, focusId, orderFilter, createdPeriod });
  return (
    <Card
      className="glass"
      title="客户档案"
      extra={
        <Space>
          <PermissionButton permission="customer.create" type="primary" disabled={Boolean(error) || rows === null} onClick={() => { clearActionError(); setCreateOpen(true); }}>
            新建客户
          </PermissionButton>
        </Space>
      }
    >
      <ErrorBanner error={error} onRetry={() => void load()} />
      <ErrorBanner error={summaryError} onRetry={() => void load()} />
      <Space wrap className="ui-filter-bar ui-filter-bar--spaced customer-list-filters">
        <SearchInput
          className="ui-filter-search"
          aria-label="搜索客户"
          enterButton={(
            <PermissionGate permission="customer.read">
              <span aria-label="搜索客户"><SearchOutlined /></span>
            </PermissionGate>
          )}
          value={searchInput}
          allowClear
          placeholder="搜索客户编号 / 名字 / 手机 / 微信 / QQ"
          onChange={(event) => {
            setSearchInput(event.target.value);
            if (!event.target.value) {
              setKeyword("");
              setPage(1);
            }
          }}
          onSearch={(value) => {
            setKeyword(value);
            setPage(1);
          }}
        />
        {createdPicker}
        {orderFilter ? <span className="customer-order-filter">订单操作人：{creatorOptions?.find((item) => item.value === username)?.label || username} · 订单日期：{orderFilter.from && orderFilter.to ? `${orderFilter.from} 至 ${orderFilter.to}` : "全部时间"}<button type="button" aria-label="清除订单筛选" onClick={onClearOrderFilter}>×</button></span> : null}
        <ToolbarSelect
          aria-label="客户状态"
          allowClear
          placeholder="全部状态"
          value={statusFilter}
          disabled={Boolean(error) || rows === null || customerStatusOptions === null}
          options={customerStatusOptions ?? []}
          onChange={(value) => {
            setStatusFilter(value);
            setPage(1);
          }}
        />
        <ToolbarMultiSelect
          aria-label="客户创建操作人筛选"
          selectedLabels={creatorFilter.map((value) => creatorOptions?.find((option) => option.value === value)?.label ?? value)}
          allowClear
          placeholder="创建操作人"
          value={creatorFilter}
          disabled={Boolean(error) || rows === null || creatorOptions === null}
          options={creatorOptions ?? []}
          onChange={(value) => {
            setCreatorFilter(value as string[]);
            setPage(1);
          }}
        />
        <TimeOrderControl descending={sortDesc} onChange={(value) => { setSortDesc(value); setPage(1); }} />
        <ExportButton permission="customer.export" aria-label="导出客户数据" loading={exporting} disabled={Boolean(error) || rows === null} onClick={() => void exportCustomers()} />
      </Space>
      <StatRow
        items={[
          { label: "客户总数", kind: "count", amount: loading ? null : error || rows === null ? "不可用" : String(total) },
          { label: "本月新增客户数", kind: "count", amount: summaryLoading ? null : error || summaryError || rows === null ? "不可用" : String(newThisMonthCount ?? 0) },
          { label: "今日新增客户数", kind: "count", amount: summaryLoading ? null : error || summaryError || rows === null ? "不可用" : String(newTodayCount ?? 0) },
        ]}
      />
      <DataTable<Customer>
        // 移动端隐藏按列 key 绑定，不随「设置 → 列表字段」的过滤/排序而错位。
        columns={markMobileHiddenColumns(arrangeColumns(columns), CUSTOMER_MOBILE_HIDDEN_KEYS)}
        rows={error ? [] : rows ?? []}
        loading={loading}
        page={page}
        pageSize={pageSize}
        total={error ? 0 : total}
        controlledPaging
        className="customer-table"
       
        emptyText={error || rows === null ? "客户数据不可用，请点击重新加载" : "暂无客户档案"}
        onPageChange={(nextPage, nextSize) => {
          setPage(nextPage);
          setPageSize(nextSize);
        }}
      />

      <CustomerCreateModal
        createOpen={createOpen}
        activeDefs={activeDefs}
        form={form}
        error={actionError}
        pending={actionPending}
        onCancel={() => { clearActionError(); setCreateOpen(false); }}
        onSubmit={submitCreate}
      />
      <CustomerEditModal
        editTarget={editTarget}
        activeDefs={activeDefs}
        editForm={editForm}
        error={actionError}
        pending={actionPending}
        onCancel={cancelEdit}
        onSubmit={submitEdit}
      />
      <CustomerDetailDrawer
        detailTarget={detailTarget}
        detailId={detailId}
        detailError={detailError}
        detailData={detailData}
        detailLoading={detailLoading}
        fieldDefs={fieldDefs}
        renderContact={renderContact}
        onClose={closeDetail}
        onRetry={retryDetail}
        onRequestEdit={requestEdit}
      />
      <CustomerMergeModal
        mergeTarget={mergeTarget}
        candidates={mergeCandidates}
        onSearch={scheduleMergeSearch}
        mergeForm={mergeForm}
        error={actionError}
        pending={actionPending}
        onCancel={cancelMerge}
        onSubmit={submitMerge}
      />
    </Card>
  );
}
