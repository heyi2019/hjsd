import { Descriptions } from "antd";
import { Select } from "../../shared/ui";
import type { AccountExecutionDetail } from "../../shared/api/catalog";
import {
  InventorySectionHeading,
  type OrderDetailField,
  type OrderDetailMeta,
  type InventoryPartyDraft,
} from "./OrderDetail.shared";

/** 板块6：参与方信息 = 参与方链接（客户 / 合作伙伴）+ PARTICIPANT 自定义字段。复用既有渲染（meta.orderParties 与 orderExtras）。 */
export function OrderDetailPartySection({ meta, detail, editing, partyDraft, onPartyEdit }: { meta: OrderDetailMeta; detail?: AccountExecutionDetail | null; editing?: boolean; partyDraft?: InventoryPartyDraft; onPartyEdit?: (orderId: number, draft: InventoryPartyDraft) => void }) {
  const order = detail?.orders[0];
  const parties = [
    ...(order?.customers ?? []).map((party) => ({ ...party, kind: "customer" as const })),
    ...(order?.counterparties ?? []).map((party) => ({ ...party, kind: "counterparty" as const })),
  ];
  const value = partyDraft
    ? [...partyDraft.customer_roles.map((item) => `customer:${item.customer_id}:${item.role}`), ...partyDraft.counterparty_roles.map((item) => `counterparty:${item.counterparty_id}:${item.role}`)]
    : parties.map((party) => `${party.kind}:${party.id}:${party.role}`);
  const options = parties.map((party) => ({ value: `${party.kind}:${party.id}:${party.role}`, label: `${party.display_name}（${party.role}）` }));
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
            {participantFields.map((field) => <Descriptions.Item key={field.key} className={field.className} label={field.label}>{editing && field.key === "orderParties" && order ? <span aria-label="编辑参与方 买家A"><Select mode="multiple" value={value} options={options} onChange={(next) => {
              const selected = (next as string[]).map((item) => item.split(":"));
              onPartyEdit?.(order.order_id, {
                customer_roles: selected.filter((item) => item[0] === "customer").map((item) => ({ customer_id: Number(item[1]), role: item[2] })),
                counterparty_roles: selected.filter((item) => item[0] === "counterparty").map((item) => ({ counterparty_id: Number(item[1]), role: item[2] })),
              });
            }} /></span> : field.value}</Descriptions.Item>)}
          </Descriptions>
        </div>
      ) : <span className="inventory-detail__empty">暂无参与方信息</span>}
    </div>
  );
}
