import { Descriptions } from "antd";
import { useMemo, type ReactNode } from "react";
import type { Account, AccountExecutionDetail, AccountExecutionOrder, EmployeeOption } from "../shared/api/catalog";
import { CustomFieldSection } from "../orders/ConfigurableField";
import {
  buildFormExtraDisplay,
  fieldLabel,
  formatExtraDisplayValue,
  isFieldActive,
  useOrderFormConfig,
} from "../orders/ConfigurableField";
import {
  InventorySectionHeading,
  findCreationOrder,
  findSellOrder,
  type OrderDetailMeta,
} from "./OrderDetail.shared";

/** 交付主字段（与建单 DeliveryInfoSection 对齐）。值：bound_phone / bound_phone_owner 来自账号（买号交接），
 *  其余来自订单 extra_values。显隐与标签由 OrderFormField 配置驱动。 */
const DELIVERY_FIELD_MAP: Record<string, { fallback: string }> = {
  bound_phone: { fallback: "换绑手机号" },
  bound_phone_owner: { fallback: "手机号绑定人" },
  intermediary_platform: { fallback: "交易平台" },
  intermediary_type: { fallback: "中介类型" },
  compensation_type: { fallback: "包赔类型" },
  delivery_responsible_ids: { fallback: "交付负责人" },
};

/** 单个交付子块（买号交付 / 卖号交付）：按对应订单类型配置驱动渲染主交付字段 + DELIVER 自定义字段。 */
function DeliverySubSection({
  title,
  orderType,
  order,
  account,
  employeeNames,
}: {
  title: string;
  orderType?: string | null | undefined;
  order?: AccountExecutionOrder;
  account?: Account | null;
  employeeNames?: Map<number, string>;
}) {
  const { config } = useOrderFormConfig(orderType ?? undefined);
  if (!order) {
    return (
      <div className="inventory-detail__meta-group">
        <div className="inventory-detail__meta-group-title">{title}</div>
        <span className="inventory-detail__empty">暂无{title}</span>
      </div>
    );
  }
  const extraValues = order.extra_values ?? {};
  const mainFields = Object.entries(DELIVERY_FIELD_MAP).map(([key, { fallback }]) => {
    let value: ReactNode = "-";
    if (key === "bound_phone" || key === "bound_phone_owner") {
      value = (account?.[key as keyof Account] as string) || (extraValues[key] as string) || "-";
    } else {
      const raw = extraValues[key];
      if (raw == null || raw === "") {
        value = "-";
      } else if (key === "delivery_responsible_ids" && Array.isArray(raw) && employeeNames?.size) {
        value = raw.map((id) => employeeNames.get(id as number) ?? "未知负责人").join("、") || "-";
      } else if (key === "delivery_responsible_ids" && Array.isArray(raw)) {
        value = raw.length ? "负责人信息加载中" : "-";
      } else {
        value = formatExtraDisplayValue(raw);
      }
    }
    return { key, fallback, value };
  });
  const deliveryItems = buildFormExtraDisplay(extraValues, Object.values(config)).filter(
    (item) => (config[item.key]?.section ?? "EXTRA") === "DELIVER",
  );
  return (
    <div className="inventory-detail__meta-group">
      <div className="inventory-detail__meta-group-title">{title}</div>
      <Descriptions className="inventory-detail__meta-table" size="small" bordered column={6}>
        {mainFields
          .filter((field) => isFieldActive(config, field.key))
          .map((field) => (
            <Descriptions.Item key={field.key} label={fieldLabel(config, field.key, field.fallback)}>{field.value}</Descriptions.Item>
          ))}
      </Descriptions>
      {deliveryItems.length ? (
        <Descriptions className="inventory-detail__meta-table" size="small" bordered column={6}>
          {deliveryItems.map((item) => (
            <Descriptions.Item key={item.key} label={`${item.label}${item.status === "deleted" ? "（已删除）" : item.status === "inactive" ? "（已停用）" : ""}`}>
              {formatExtraDisplayValue(item.value) || "-"}
            </Descriptions.Item>
          ))}
        </Descriptions>
      ) : null}
    </div>
  );
}

/** 板块2：交付信息（买号交付、卖号交付）。只读态拆为两个配置驱动子块；编辑态沿用 DELIVER 自定义字段表单。 */
export function OrderDetailDeliverySection({
  meta,
  editing,
  detail,
  account,
  employees,
}: {
  meta: OrderDetailMeta;
  editing?: boolean;
  detail?: AccountExecutionDetail | null;
  account?: Account | null;
  employees?: EmployeeOption[];
}) {
  const creationOrder = useMemo(() => findCreationOrder(detail, meta.sourceOrderNo), [detail, meta.sourceOrderNo]);
  const sellOrder = useMemo(() => findSellOrder(detail, creationOrder), [detail, creationOrder]);
  const employeeNames = useMemo(
    () => new Map((employees ?? []).map((employee) => [employee.id, employee.display_name] as const)),
    [employees],
  );

  if (editing) {
    return (
      <div className="inventory-detail__section inventory-detail__section--delivery">
        <InventorySectionHeading title="交付信息" />
        <CustomFieldSection section="DELIVER" testIdSuffix="inv-edit-deliver" />
      </div>
    );
  }

  return (
    <div className="inventory-detail__section inventory-detail__section--delivery">
      <InventorySectionHeading title="交付信息" />
      <div className="inventory-detail__meta">
        <DeliverySubSection title="买号交付" orderType={creationOrder?.order_type} order={creationOrder} account={account} employeeNames={employeeNames} />
        <DeliverySubSection title="卖号交付" orderType={sellOrder?.order_type} order={sellOrder} employeeNames={employeeNames} />
      </div>
    </div>
  );
}
