import { SearchOutlined } from "@ant-design/icons";
import { Button, Card, Input, Space, Typography } from "antd";
import type { Customer } from "../shared/api/types/customers";
import { markMobileHiddenColumns } from "../shared/lib/listColumns";
import { DataTable, ErrorBanner, PermissionButton, Select, StatRow } from "../shared/ui";
import { CustomerCreateModal } from "./CustomerCreateModal";
import { CustomerDetailDrawer } from "./CustomerDetailDrawer";
import { CustomerEditModal } from "./CustomerEditModal";
import { CustomerMergeModal } from "./CustomerMergeModal";
import { useCustomerController } from "./useCustomerController";

const SearchButton = Button;
/** ≤640px 隐藏：联系方式与建立时间，详情里可看；状态与操作必须常驻。 */
const CUSTOMER_MOBILE_HIDDEN_KEYS = ["phone", "wechat", "qq", "created_at"] as const;
const CUSTOMER_STATUS_OPTIONS = [
  { value: "ACTIVE", label: "启用中" },
  { value: "DISABLED", label: "已拉黑" },
  { value: "MERGED", label: "已合并" },
];

export function CustomerPanel({ active = true, focusId }: { active?: boolean; focusId?: number }) {
  const {
    activeDefs,
    arrangeColumns,
    cancelEdit,
    cancelMerge,
    closeDetail,
    columns,
    createOpen,
    currentDate,
    customerStatusOptions,
    detailData,
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
    mergeTarget,
    newThisMonthCount,
    newTodayCount,
    page,
    pageSize,
    renderContact,
    requestEdit,
    rows,
    summary,
    searchInput,
    setCreateOpen,
    setKeyword,
    setPage,
    setPageSize,
    setSearchInput,
    setStatusFilter,
    statusFilter,
    submitCreate,
    submitEdit,
    submitMerge,
  } = useCustomerController({ active, focusId });
  return (
    <Card
      className="glass"
      title="客户档案"
      extra={
        <Space>
          <Button
            size="small"
            aria-label="导出客户CSV"
            loading={exporting}
            disabled={Boolean(error) || rows === null}
            onClick={() => void exportCustomers()}
          >
            导出 CSV
          </Button>
          <PermissionButton permission="customer.create" type="primary" disabled={Boolean(error) || rows === null} onClick={() => setCreateOpen(true)}>
            新建客户
          </PermissionButton>
        </Space>
      }
    >
      <ErrorBanner error={error} onRetry={() => void load()} />
      <Typography.Paragraph type="secondary">
        联系方式直接展示已建档原值；拉黑或已合并客户不可作为新订单参与方。
      </Typography.Paragraph>
      <StatRow
        items={[
          { label: "客户总数", kind: "count", amount: rows === null ? "不可用" : String(summary?.total_count ?? 0) },
          { label: "本月新增客户数", kind: "count", amount: rows === null ? "不可用" : String(newThisMonthCount ?? 0) },
          { label: "今日新增客户数", kind: "count", amount: rows === null ? "不可用" : String(newTodayCount ?? 0) },
        ]}
      />
      <Space wrap className="customer-list-filters customer-list-filters--separated">
        <Input.Search
          aria-label="搜索客户"
          enterButton={<SearchButton icon={<SearchOutlined />} aria-label="搜索客户" />}
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
        <Select
          aria-label="客户状态"
          allowClear
          placeholder="全部状态"
          value={statusFilter}
          disabled={Boolean(error) || rows === null}
          options={customerStatusOptions ?? CUSTOMER_STATUS_OPTIONS}
          onChange={(value) => {
            setStatusFilter(value);
            setPage(1);
          }}
        />
      </Space>
      <DataTable<Customer>
        // 移动端隐藏按列 key 绑定，不随「设置 → 列表字段」的过滤/排序而错位。
        columns={markMobileHiddenColumns(arrangeColumns(columns), CUSTOMER_MOBILE_HIDDEN_KEYS)}
        rows={rows ?? []}
        loading={loading}
        page={page}
        pageSize={pageSize}
        total={rows?.length ?? 0}
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
        onCancel={() => setCreateOpen(false)}
        onSubmit={submitCreate}
      />
      <CustomerEditModal
        editTarget={editTarget}
        activeDefs={activeDefs}
        editForm={editForm}
        onCancel={cancelEdit}
        onSubmit={submitEdit}
      />
      <CustomerDetailDrawer
        detailTarget={detailTarget}
        detailData={detailData}
        detailLoading={detailLoading}
        fieldDefs={fieldDefs}
        renderContact={renderContact}
        onClose={closeDetail}
        onRequestEdit={requestEdit}
      />
      <CustomerMergeModal
        mergeTarget={mergeTarget}
        rows={rows}
        mergeForm={mergeForm}
        onCancel={cancelMerge}
        onSubmit={submitMerge}
      />
    </Card>
  );
}
