import { Descriptions } from "antd";
import { type ReactNode } from "react";
import { useMemo } from "react";
import type { AccountExecutionDetail, AccountExecutionOrder } from "../../shared/api/types/account-execution";
import type { Account } from "../../shared/api/types/accounts";
import type { EmployeeOption } from "../../shared/api/types/org";
import { CustomFieldSection } from "../../orders/ConfigurableField";
import {
  buildFormExtraDisplay,
  fieldLabel,
  formatExtraDisplayValue,
  isFieldActive,
  useOrderFormConfig,
} from "../../orders/ConfigurableField";
import {
  InventorySectionHeading,
  type OrderDetailMeta,
} from "./OrderDetail.shared";

/** 交付主字段（与建单 DeliveryInfoSection 对齐）。值：bound_phone / bound_phone_owner 来自账号（买号交接），
 *  其余来自订单 extra_values。显隐与标签由 OrderFormField 配置驱动。 */
const DELIVERY_FIELDS = [
  { key: "bound_phone", fallback: "换绑手机号" },
  { key: "bound_phone_owner", fallback: "手机号绑定人" },
  { key: "intermediary_platform", fallback: "交易平台" },
  { key: "intermediary_type", fallback: "中介类型" },
  { key: "compensation_type", fallback: "包赔类型" },
  { key: "delivery_responsible_ids", fallback: "交付负责人" },
] as const;

function textValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "-";
}

/** 单个交付子块（买号交付 / 卖号交付）：按对应订单类型配置驱动渲染主交付字段 + DELIVER 自定义字段。
 * 两个交付方向都保留字段表格，便于详情查看、编辑和补录。 */
function DeliverySubSection({
  title,
  orderType,
  order,
  account,
  employees,
}: {
  title: string;
  orderType?: string | null | undefined;
  order?: AccountExecutionOrder;
  account?: Account | null;
  employees?: EmployeeOption[];
}) {
  const { config } = useOrderFormConfig(orderType ?? undefined);
  const extraValues = order?.extra_values;
  const employeeNames = useMemo(
    () => new Map((employees ?? []).map((employee) => [employee.id, employee.display_name])),
    [employees],
  );
  const mainFields = useMemo(() => DELIVERY_FIELDS.map(({ key, fallback }) => {
    let value: ReactNode = "-";
    const values = extraValues ?? {};
    if (key === "bound_phone") {
      value = account?.bound_phone || textValue(values[key]);
    } else if (key === "bound_phone_owner") {
      value = account?.bound_phone_owner || textValue(values[key]);
    } else {
      const raw = values[key];
      if (raw == null || raw === "") {
        value = "-";
      } else if (key === "delivery_responsible_ids" && Array.isArray(raw) && employees?.length) {
        value = raw.map((id) => employeeNames.get(id) ?? "未知负责人").join("、") || "-";
      } else if (key === "delivery_responsible_ids" && Array.isArray(raw)) {
        value = raw.length ? "负责人信息加载中" : "-";
      } else {
        value = formatExtraDisplayValue(raw);
      }
    }
    return { key, fallback, value };
  }), [account, employees, employeeNames, extraValues]);
  const deliveryItems = useMemo(
    () => buildFormExtraDisplay(extraValues ?? {}, Object.values(config)).filter(
      (item) => (config[item.key]?.section ?? "EXTRA") === "DELIVER",
    ),
    [config, extraValues],
  );
  return (
    <div className="inventory-detail__meta-group">
      <div className="inventory-detail__meta-group-title">{title}</div>
      <Descriptions className="inventory-detail__meta-table" size="small" bordered column={3}>
        {mainFields
          .filter((field) => isFieldActive(config, field.key))
          .map((field) => (
            <Descriptions.Item key={field.key} label={fieldLabel(config, field.key, field.fallback)}>{field.value}</Descriptions.Item>
          ))}
      </Descriptions>
      {deliveryItems.length ? (
        <Descriptions className="inventory-detail__meta-table" size="small" bordered column={3}>
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

/** 板块2：交付信息（买号交付、卖号交付）。两侧统一呈现字段表格；编辑态沿用 DELIVER 自定义字段表单。 */
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
  const creationOrder = useMemo(
    () => detail?.orders.find((order) => order.order_no === meta.sourceOrderNo),
    [detail, meta.sourceOrderNo],
  );
  const sellOrder = useMemo(
    () => detail?.orders.find(
      (order) => order.order_id !== creationOrder?.order_id && order.events.some((event) => event.event_type === "SELL"),
    ),
    [creationOrder, detail],
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
        <DeliverySubSection title="买号交付" orderType={creationOrder?.order_type} order={creationOrder} account={account} employees={employees} />
        <DeliverySubSection
          title="卖号交付"
          orderType={sellOrder?.order_type ?? creationOrder?.order_type}
          order={sellOrder}
          employees={employees}
        />
      </div>
    </div>
  );
}
