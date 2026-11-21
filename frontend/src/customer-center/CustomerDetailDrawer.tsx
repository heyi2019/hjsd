import { Descriptions, Drawer, Spin, Typography } from "antd";
import type { ReactNode } from "react";
import { buildFormExtraDisplay, formatExtraDisplayValue } from "../shared/forms/ConfigurableField";
import type { Customer, CustomerBusiness, CustomerDetail, CustomerInstallment } from "../shared/api/types/customers";
import type { OrderFormField } from "../shared/api/types/forms";
import { money } from "../shared/lib/format";
import { orderTypeLabel } from "../shared/lib/labels";
import { configurableLabel } from "../shared/lib/optionSets";
import { DataTable, ErrorBanner, PermissionButton, StatRow, StatusTag } from "../shared/ui";

export function CustomerDetailDrawer({
  detailTarget,
  detailId,
  detailError,
  detailData,
  detailLoading,
  fieldDefs,
  renderContact,
  onClose,
  onRetry,
  onRequestEdit,
}: {
  detailTarget: Customer | null;
  detailId: number | null;
  detailError: { message: string; code?: string } | null;
  detailData: CustomerDetail | null;
  detailLoading: boolean;
  fieldDefs: OrderFormField[];
  renderContact: (row: Customer, field: "phone" | "wechat" | "qq") => ReactNode;
  onClose: () => void;
  onRetry: () => void;
  onRequestEdit: (target: Customer) => void;
}) {
  const customer = detailData?.customer;
  return (
      <Drawer
        title={detailTarget ? `客户档案 · ${detailTarget.customer_no}` : "客户档案"}
        open={detailId !== null}
        onClose={onClose}
        width={720}
        destroyOnHidden
        extra={
          customer && customer.status === "ACTIVE" ? (
            <PermissionButton
              permission="customer.update"
              size="small"
              onClick={() => onRequestEdit(customer)}
            >
              编辑
            </PermissionButton>
          ) : null
        }
      >
        {detailError ? <ErrorBanner error={detailError} onRetry={onRetry} retrying={detailLoading} /> : detailLoading ? (
          <div role="status" aria-label="正在加载客户详情"><Spin /></div>
        ) : customer ? (
          <>
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label="客户编号">{customer.customer_no}</Descriptions.Item>
              <Descriptions.Item label="名字">{customer.display_name}</Descriptions.Item>
              <Descriptions.Item label="联系人">{customer.contact_name || "-"}</Descriptions.Item>
              <Descriptions.Item label="手机">{renderContact(customer, "phone")}</Descriptions.Item>
              <Descriptions.Item label="微信">{renderContact(customer, "wechat")}</Descriptions.Item>
              <Descriptions.Item label="QQ">{renderContact(customer, "qq")}</Descriptions.Item>
              <Descriptions.Item label="状态">
                <StatusTag status={customer.status} optionSet="CUSTOMER_STATUS" />
              </Descriptions.Item>
              <Descriptions.Item label="创建操作人">{customer.created_by || "-"}</Descriptions.Item>
              <Descriptions.Item label="备注">{customer.note || "-"}</Descriptions.Item>
            </Descriptions>
            <Typography.Title level={5} className="ui-title-spaced">
              扩展字段
            </Typography.Title>
            {(() => {
              const items = buildFormExtraDisplay(customer.extra_values, fieldDefs);
              if (items.length === 0) {
                return (
                  <Typography.Paragraph type="secondary">
                    {fieldDefs.length === 0
                      ? "未配置扩展字段；在「设置 › 表单字段 › 客户建档」新增自定义字段后，建档与详情会自动带出。"
                      : "无扩展字段值"}
                  </Typography.Paragraph>
                );
              }
              return (
                <Descriptions column={1} bordered size="small">
                  {items.map((it) => (
                    <Descriptions.Item
                      key={it.key}
                      label={`${it.label}${it.status === "deleted" ? "（已删除）" : it.status === "inactive" ? "（已停用）" : ""}`}
                    >
                      {formatExtraDisplayValue(it.value) || "未填写"}
                    </Descriptions.Item>
                  ))}
                </Descriptions>
              );
            })()}
            {detailData ? (
              <>
                <Typography.Title level={5} className="ui-title-spaced">经营概览</Typography.Title>
                <StatRow
                  items={[
                    { label: "关联订单", amount: detailData.overview.order_count, kind: "count" },
                    { label: "进行中订单", amount: detailData.overview.active_order_count, kind: "count" },
                    { label: "已完成订单", amount: detailData.overview.completed_order_count, kind: "count" },
                    { label: "累计利润", amount: detailData.overview.cumulative_profit, kind: "money" },
                    { label: "分期已收", amount: detailData.overview.installment_paid_total, kind: "money" },
                    { label: "分期应收", amount: detailData.overview.installment_receivable_total, kind: "money" },
                    { label: "剩余应收", amount: detailData.overview.installment_remaining_total, kind: "money", tone: "warn" },
                    { label: "逾期期数", amount: detailData.overview.overdue_period_count, kind: "count", tone: detailData.overview.overdue_period_count > 0 ? "warn" : "plain" },
                  ]}
                />
                <Typography.Title level={5} className="ui-title-spaced">关联订单</Typography.Title>
                <DataTable<CustomerBusiness>
                  columns={[
                    { title: "订单", dataIndex: "order_no" },
                    { title: "业务", render: (_value, row) => orderTypeLabel(row.order_type) },
                    {
                      title: "角色",
                      render: (_value, row) =>
                        row.roles
                          .map((role) => configurableLabel("ORDER_CUSTOMER_ROLE", role))
                          .join("、") || "-",
                    },
                    { title: "状态", render: (_value, row) => <StatusTag status={row.status} optionSet="ORDER_STATUS" /> },
                    { title: "日期", dataIndex: "trade_date" },
                  ]}
                  rows={detailData.business}
                  page={1}
                  pageSize={detailData.business.length || 1}
                  total={detailData.business.length}
                  onPageChange={() => undefined}
                  pagination={false}
                  emptyText="暂无关联订单"
               />
                <Typography.Title level={5} className="ui-title-spaced">分期收款</Typography.Title>
                <DataTable<CustomerInstallment>
                  columns={[
                    { title: "合约", dataIndex: "inst_no" },
                    { title: "订单", dataIndex: "order_no" },
                    { title: "状态", render: (_value, row) => <StatusTag status={row.status} optionSet="INSTALLMENT_STATUS" /> },
                    { title: "已收", render: (_value, row) => `¥${money(row.paid_amount)}` },
                    { title: "剩余", render: (_value, row) => `¥${money(row.remaining_amount)}` },
                    { title: "逾期", render: (_value, row) => row.overdue_periods > 0 ? `逾期 ${row.overdue_periods} 期` : "-" },
                  ]}
                  rows={detailData.installments}
                  page={1}
                  pageSize={detailData.installments.length || 1}
                  total={detailData.installments.length}
                  onPageChange={() => undefined}
                  pagination={false}
                  emptyText="暂无分期合约"
               />
              </>
            ) : null}
          </>
        ) : null}
      </Drawer>
  );
}
