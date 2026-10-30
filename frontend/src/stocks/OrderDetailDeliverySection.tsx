import { Descriptions } from "antd";
import { CustomFieldSection } from "../orders/ConfigurableField";
import {
  InventorySectionHeading,
  type OrderDetailField,
  type OrderDetailMeta,
} from "./OrderDetail.shared";

/** 板块2：交付信息（买号、卖号）。只读态展示 DELIVER section 字段；编辑态渲染可编辑自定义字段表单（form 由外层 BusinessForm 提供）。 */
export function OrderDetailDeliverySection({
  meta,
  editing,
}: {
  meta: OrderDetailMeta;
  editing?: boolean;
}) {
  if (editing) {
    return (
      <div className="inventory-detail__section inventory-detail__section--delivery">
        <InventorySectionHeading title="交付信息" />
        <CustomFieldSection section="DELIVER" testIdSuffix="inv-edit-deliver" />
      </div>
    );
  }

  const deliveryFields: OrderDetailField[] = meta.orderExtras
    .filter((field) => field.section === "DELIVER")
    .map((field) => ({ key: `order-extra-${field.key}`, label: field.label, value: field.value }));

  return (
    <div className="inventory-detail__section inventory-detail__section--delivery">
      {editing ? <InventorySectionHeading title="交付信息" /> : null}
      {deliveryFields.length ? (
        <Descriptions className="inventory-detail__meta-table" size="small" bordered column={4}>
          {deliveryFields.map((field) => <Descriptions.Item key={field.key} label={field.label}>{field.value}</Descriptions.Item>)}
        </Descriptions>
      ) : <span className="inventory-detail__empty">暂无交付信息</span>}
    </div>
  );
}
