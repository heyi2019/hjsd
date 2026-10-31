import { Descriptions } from "antd";
import {
  InventorySectionHeading,
  type OrderDetailField,
  type OrderDetailMeta,
} from "./OrderDetail.shared";

/** 板块6：参与方信息 = 参与方链接（客户 / 合作方）+ PARTICIPANT 自定义字段。复用既有渲染（meta.orderParties 与 orderExtras）。 */
export function OrderDetailPartySection({ meta }: { meta: OrderDetailMeta }) {
  const participantFields: OrderDetailField[] = [
    ...(meta.orderParties !== "-" ? [{ key: "orderParties", label: "参与方", value: meta.orderParties, className: "inventory-detail__multiline" }] : []),
    ...meta.orderExtras
      .filter((field) => field.section === "PARTICIPANT")
      .map((field) => ({ key: `order-extra-${field.key}`, label: field.label, value: field.value })),
  ];

  return (
    <div className="inventory-detail__section inventory-detail__section--party">
      <InventorySectionHeading title="参与方信息" />
      {participantFields.length ? (
        <div className="inventory-detail__meta">
          <Descriptions className="inventory-detail__meta-table" size="small" bordered column={4}>
            {participantFields.map((field) => <Descriptions.Item key={field.key} className={field.className} label={field.label}>{field.value}</Descriptions.Item>)}
          </Descriptions>
        </div>
      ) : <span className="inventory-detail__empty">暂无参与方信息</span>}
    </div>
  );
}
