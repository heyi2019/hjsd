import { Descriptions, Typography } from "antd";
import type { Order } from "../shared/api/catalog";
import {
  BUSINESS_MODE_LABEL,
  BUSINESS_TYPE_LABEL,
  LINK_STATUS_LABEL,
  VALUE_ADDED_SERVICE_LABEL,
  orderTypeLabel,
} from "../shared/lib/labels";
import { executionActionLabel } from "../shared/lib/format";
import { configurableLabel } from "../shared/lib/optionSets";
import { StatusTag } from "../shared/ui";
import { buildFormExtraDisplay, formatExtraDisplayValue, useOrderFormConfig } from "./ConfigurableField";

/** 业务订单详情板块分组顺序（自定义字段历史值按 section 归集展示）。 */
const ORDER_FIELD_SECTION_LABEL: Record<string, string> = {
  ACCOUNT_PRODUCT: "账号 / 产品信息",
  BUSINESS: "业务方案信息",
  DELIVER: "交付信息",
  FINANCE: "费用与资金",
  PARTICIPANT: "参与方信息",
  EXTRA: "其他补充信息",
};
const ORDER_FIELD_SECTION_ORDER = ["ACCOUNT_PRODUCT", "BUSINESS", "DELIVER", "FINANCE", "EXTRA", "PARTICIPANT"];

/** 业务订单行展开详情：仅展示订单基础信息与自定义字段（轻量卡片），
 * 不含动作记录 / 资金流水 / 返点 / 分期 / 审计 / 附件 / 关联 / 规则快照等「流水类详情」。 */
export function OrderDetailPane({ order, typeNames }: { order: Order; typeNames?: Record<string, string> }) {
  const { config: orderFieldConfig } = useOrderFormConfig(order.order_type);
  const orderExtraItems = buildFormExtraDisplay(order.form_extra, Object.values(orderFieldConfig));
  const orderExtraGroups = [
    ...orderExtraItems
      .reduce((groups, item) => {
        const section = orderFieldConfig[item.key]?.section ?? "EXTRA";
        const current = groups.get(section) ?? [];
        current.push(item);
        groups.set(section, current);
        return groups;
      }, new Map<string, typeof orderExtraItems>())
      .entries(),
  ]
    .sort(
      ([left], [right]) =>
        (ORDER_FIELD_SECTION_ORDER.indexOf(left) === -1 ? 99 : ORDER_FIELD_SECTION_ORDER.indexOf(left)) -
        (ORDER_FIELD_SECTION_ORDER.indexOf(right) === -1 ? 99 : ORDER_FIELD_SECTION_ORDER.indexOf(right)),
    )
    .map(([section, items]) => ({ section, items }));

  return (
    <div className="orders-detail-pane">
      <Descriptions column={2} bordered size="small">
        <Descriptions.Item label="业务">{BUSINESS_MODE_LABEL[order.business_mode ?? ""] || "-"}</Descriptions.Item>
        <Descriptions.Item label="类型">
          {BUSINESS_TYPE_LABEL[order.business_type ?? ""] || orderTypeLabel(order.order_type, typeNames)}
        </Descriptions.Item>
        <Descriptions.Item label="增值服务">
          {configurableLabel("INSTALLMENT_CONTRACT_TYPE", order.value_added_service, VALUE_ADDED_SERVICE_LABEL)}
        </Descriptions.Item>
        <Descriptions.Item label="游戏/产品类型">{order.account_game_type || "-"}</Descriptions.Item>
        <Descriptions.Item label="游戏账号/产品">
          {[order.account_game_account, order.account_channel_region].filter(Boolean).join(" / ") || "-"}
        </Descriptions.Item>
        <Descriptions.Item label="平台">{order.account_platform || "-"}</Descriptions.Item>
        <Descriptions.Item label="对方">{order.party_name || "-"}</Descriptions.Item>
        <Descriptions.Item label="获客来源">{order.party_source || "-"}</Descriptions.Item>
        <Descriptions.Item label="获客负责人">{order.party_created_by || "-"}</Descriptions.Item>
        <Descriptions.Item label="获客时间">
          {order.party_created_at ? new Date(order.party_created_at).toLocaleString("zh-CN") : "-"}
        </Descriptions.Item>
        <Descriptions.Item label="金额/进度">
          {order.installment_principal
            ? `¥${order.installment_paid ?? "0.00"}/${order.installment_principal} · ${order.installment_periods ?? 0}期`
            : order.event_total
              ? `¥${order.event_total}`
              : "-"}
        </Descriptions.Item>
        <Descriptions.Item label="最新动作">
          {order.last_event_type
            ? `${executionActionLabel(order.last_event_type, order.order_type)}${order.last_event_amount ? ` · ¥${order.last_event_amount}` : ""}`
            : "-"}
        </Descriptions.Item>
        <Descriptions.Item label="状态">
          <StatusTag status={order.status} optionSet="ORDER_STATUS" />
        </Descriptions.Item>
        <Descriptions.Item label="关联状态">
          <StatusTag
            status={order.link_status ?? "LINKED"}
            label={configurableLabel("ORDER_LINK_STATUS", order.link_status ?? "LINKED", LINK_STATUS_LABEL)}
          />
        </Descriptions.Item>
        <Descriptions.Item label="成交日">{order.trade_date || "-"}</Descriptions.Item>
        <Descriptions.Item label="备注">{order.note || "-"}</Descriptions.Item>
      </Descriptions>
      {orderExtraGroups.map(({ section, items }) => (
        <div className="ui-form-spaced" key={section}>
          <Typography.Text strong>{ORDER_FIELD_SECTION_LABEL[section] ?? section}</Typography.Text>
          <Descriptions column={2} bordered size="small">
            {items.map((it) => (
              <Descriptions.Item
                key={it.key}
                label={`${it.label}${it.status === "deleted" ? "（已删除）" : it.status === "inactive" ? "（已停用）" : ""}`}
              >
                {formatExtraDisplayValue(it.value) || "-"}
              </Descriptions.Item>
            ))}
          </Descriptions>
        </div>
      ))}
    </div>
  );
}
