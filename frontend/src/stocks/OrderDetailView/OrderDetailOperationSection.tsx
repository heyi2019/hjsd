import { Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useMemo } from "react";
import { DataTable } from "../../shared/ui";
import { CustomFieldSection } from "../../orders/ConfigurableField";
import { OrderDetailImageGallery } from "./OrderDetailImageGallery";
import {
  InventorySectionHeading,
  type OrderDetailMeta,
  type InventoryOperationRow,
} from "./OrderDetail.shared";

const OPERATION_COLUMNS: ColumnsType<InventoryOperationRow> = [
  { title: "动作", dataIndex: "action", key: "action", width: 88 },
  {
    title: "内容",
    dataIndex: "content",
    key: "content",
    onCell: () => ({ className: "inventory-operation-content" }),
    render: (value: InventoryOperationRow["content"]) => value || "-",
  },
  { title: "时间", dataIndex: "occurredAt", key: "occurredAt", width: 142 },
  { title: "操作人", dataIndex: "operator", key: "operator", width: 82 },
];

/** 板块3：运营信息只展示四个可独立登记的动作。 */
export function OrderDetailOperationSection({
  meta,
  editing,
}: {
  meta: OrderDetailMeta;
  editing?: boolean;
}) {
  const rows = useMemo<InventoryOperationRow[]>(() => [
    { key: "consignment", action: "上架平台", content: meta.listedPlatform, occurredAt: meta.listedAt, operator: meta.listedOperator },
    { key: "unlist", action: "下架平台", content: meta.unlistedPlatform, occurredAt: meta.unlistedAt, operator: meta.unlistedOperator },
    { key: "description", action: "描述", content: meta.accountDescription, occurredAt: meta.descriptionAt, operator: meta.descriptionOperator },
    { key: "images", action: "作图", content: <OrderDetailImageGallery images={meta.accountImages} altPrefix="作图" limit={9} />, occurredAt: meta.imagesAt, operator: meta.imagesOperator },
  ], [meta]);

  if (editing) {
    return (
      <div className="inventory-detail__section inventory-detail__section--operation">
        <InventorySectionHeading title="运营信息" />
        <CustomFieldSection section="OPERATION" testIdSuffix="inv-edit-operation" />
        <CustomFieldSection section="BUSINESS" testIdSuffix="inv-edit-business" />
        <CustomFieldSection testIdSuffix="inv-edit" />
      </div>
    );
  }

  return (
    <div className="inventory-detail__section inventory-detail__section--operation">
      <div className="inventory-detail__section-heading"><Typography.Text strong>运营信息</Typography.Text></div>
      <DataTable
        className="inventory-detail__data-table inventory-operation-table"
        columns={OPERATION_COLUMNS}
        rows={rows}
        page={1}
        pageSize={10}
        total={rows.length}
        onPageChange={() => undefined}
        pagination={false}
        rowKey="key"
        size="small"
      />
    </div>
  );
}
