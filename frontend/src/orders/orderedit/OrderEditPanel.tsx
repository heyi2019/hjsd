import { Space } from "antd";
import type { Account, AccountExecutionDetail, AccountExecutionEvent } from "../../shared/api/catalog";
import { BusinessRegistrationForm, PermissionButton } from "../../shared/ui";
import { FieldConfigScope } from "../ConfigurableField";
import { OrderDetailDeliverySection } from "./OrderDetailDeliverySection";
import { OrderDetailExecutionSection } from "./OrderDetailExecutionSection";
import { OrderDetailFinanceSection } from "./OrderDetailFinanceSection";
import { OrderDetailOperationSection } from "./OrderDetailOperationSection";
import { OrderDetailPartySection } from "./OrderDetailPartySection";
import { OrderDetailProfileSection } from "./OrderDetailProfileSection";
import type {
  InventoryEmployeeOption,
  InventoryEventDraft,
  InventoryExecutionRow,
  InventoryFinanceRow,
  InventoryOrderDraft,
  InventoryPartyDraft,
  OrderDetailField,
  OrderDetailMeta,
} from "./OrderDetail.shared";

export type OrderEditPanelProps = {
  meta: OrderDetailMeta;
  className?: string;
  detail?: AccountExecutionDetail | null;
  account?: Account | null;
  editing: Account;
  executionRows: InventoryExecutionRow[];
  financeRows: InventoryFinanceRow[];
  expenseCount: number;
  incomeCount: number;
  totalExpense: string;
  totalIncome: string;
  flowCount: number;
  onEdit?: (account: Account) => void;
  eventDrafts?: Record<number, InventoryEventDraft>;
  onEventEdit?: (event: AccountExecutionEvent, changes: { amount?: string; note?: string | null; occurred_at?: string | null; flow_occurred_at?: string | null; operator_user_ids?: number[] }) => void;
  employees: InventoryEmployeeOption[];
  extraForm?: unknown;
  onSave?: () => void;
  onCancel?: () => void;
  saving?: boolean;
  timeDrafts?: { registered_at?: string | null; sold_at?: string | null };
  onTimeEdit?: (key: "registered_at" | "sold_at", value: string | null) => void;
  orderDrafts?: Record<number, InventoryOrderDraft>;
  onOrderEdit?: (orderId: number, changes: InventoryOrderDraft) => void;
  partyDrafts?: Record<number, InventoryPartyDraft>;
  onPartyEdit?: (orderId: number, draft: InventoryPartyDraft) => void;
};

/** 订单编辑功能板块：库存中心与订单台账共享的完整编辑界面。 */
export function OrderEditPanel({
  meta,
  className,
  detail,
  account,
  editing,
  onEdit,
  eventDrafts,
  onEventEdit,
  employees,
  executionRows,
  financeRows,
  expenseCount,
  incomeCount,
  totalExpense,
  totalIncome,
  flowCount,
  extraForm,
  onSave,
  onCancel,
  saving,
  timeDrafts,
  onTimeEdit,
  orderDrafts,
  onOrderEdit,
  partyDrafts,
  onPartyEdit,
}: OrderEditPanelProps) {
  const extraFieldsBySection = (section: string): OrderDetailField[] => meta.orderExtras
    .filter((field) => field.section === section)
    .map((field) => ({ key: `order-extra-${field.key}`, label: field.label, value: field.value }));

  return (
    <div
      className={["inventory-detail", "inventory-detail--editing", className].filter(Boolean).join(" ")}
      data-testid="order-edit-feature-panel"
      aria-label="订单编辑功能板块"
    >
      <OrderDetailProfileSection meta={meta} detail={detail} account={editing ?? account} editing onEdit={onEdit} timeDrafts={timeDrafts} onTimeEdit={onTimeEdit} orderDrafts={orderDrafts} onOrderEdit={onOrderEdit} />
      <BusinessRegistrationForm
        layout="horizontal"
        labelAlign="left"
        labelCol={{ flex: "108px" }}
        wrapperCol={{ flex: "auto" }}
        scope="INVEDIT"
        form={extraForm as never}
      >
        <FieldConfigScope scope="INVEDIT" active>
          <OrderDetailDeliverySection meta={meta} detail={detail} account={editing ?? account} employees={employees} editing onEdit={onEdit} onOrderEdit={onOrderEdit} />
          <OrderDetailOperationSection meta={meta} editing />
        </FieldConfigScope>
      </BusinessRegistrationForm>
      <OrderDetailExecutionSection rows={executionRows} audit={detail?.audit} editing eventDrafts={eventDrafts} onEventEdit={onEventEdit} employees={employees} />
      <OrderDetailFinanceSection
        rows={financeRows}
        extraFields={extraFieldsBySection("FINANCE")}
        expenseCount={expenseCount}
        incomeCount={incomeCount}
        totalExpense={totalExpense}
        totalIncome={totalIncome}
        flowCount={flowCount}
        editing
        eventDrafts={eventDrafts}
        onEventEdit={onEventEdit}
      />
      <OrderDetailPartySection meta={meta} detail={detail} editing partyDraft={detail?.orders[0] ? partyDrafts?.[detail.orders[0].order_id] : undefined} onPartyEdit={onPartyEdit} />
      <div className="inventory-detail__footer">
        <Space>
          <PermissionButton permission="order.create" type="primary" loading={saving} onClick={() => onSave?.()}>保存修改</PermissionButton>
          <PermissionButton permission="order.create" onClick={() => onCancel?.()}>取消</PermissionButton>
        </Space>
      </div>
    </div>
  );
}
