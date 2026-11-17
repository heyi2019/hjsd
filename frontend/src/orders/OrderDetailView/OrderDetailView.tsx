import { Space } from "antd";
import type { FormInstance } from "antd";
import type { AccountExecutionDetail, AccountExecutionEvent } from "../../shared/api/types/account-execution";
import type { Account } from "../../shared/api/types/accounts";
import { BusinessRegistrationForm, PermissionButton } from "../../shared/ui";
import { FieldConfigScope } from "../ConfigurableField";
import { OrderDetailDeliverySection } from "./OrderDetailDeliverySection";
import { OrderDetailExecutionSection } from "./OrderDetailExecutionSection";
import { OrderDetailFinanceSection } from "./OrderDetailFinanceSection";
import { OrderDetailOperationSection } from "./OrderDetailOperationSection";
import { OrderDetailProfileSection } from "./OrderDetailProfileSection";
import { OrderDetailPartySection } from "./OrderDetailPartySection";
import type {
  OrderDetailMeta,
  OrderEmployeeOption,
  OrderEventDraft,
  OrderOperationDraft,
  OrderExecutionRow,
  OrderFinanceRow,
} from "./OrderDetail.shared";
import type { FinanceDraft } from "./editing/use-order-detail-editor";
import type { OrderDraft } from "./editing/use-order-detail-editor";
import type { PartyAddition } from "./editing/use-order-detail-editor";
import "./OrderDetail.css";

type OrderDetailViewProps = {
  meta: OrderDetailMeta;
  detail?: AccountExecutionDetail | null;
  account?: Account | null;
  executionRows: OrderExecutionRow[];
  operationEvents?: Record<string, AccountExecutionEvent[]>;
  financeRows: OrderFinanceRow[];
  expenseCount: number;
  incomeCount: number;
  totalExpense: string;
  totalIncome: string;
  editing?: Account | null;
  eventDrafts?: Record<number, OrderEventDraft>;
  operationDrafts?: Partial<Record<string, OrderOperationDraft>>;
  onEventEdit?: (event: AccountExecutionEvent, changes: { amount?: string; note?: string | null; occurred_at?: string; form_extra?: Record<string, unknown>; operator_user_ids?: number[] }) => void;
  onOperationEdit?: (key: string, changes: Partial<OrderOperationDraft>) => void;
  onAddOperationRow?: (operationType: NonNullable<OrderOperationDraft["operation_type"]>) => void;
  onRemoveOperationRow?: (key: string) => void;
  financeDrafts?: Record<string, FinanceDraft>;
  onFinanceEdit?: (flowNo: string, changes: Partial<Omit<FinanceDraft, "flow_no">>) => void;
  onProfileChange?: (changes: Partial<Account>) => void;
  orderDrafts?: Record<number, OrderDraft>;
  onOrderEdit?: (orderId: number, changes: Partial<Omit<OrderDraft, "order_id">>) => void;
  onOrderExtraChange?: (orderId: number, key: string, value: unknown) => void;
  onPartyEdit?: (orderId: number, addition: PartyAddition) => void;
  employees: OrderEmployeeOption[];
  operatorUsername?: string;
  extraForm?: FormInstance;
  /** 编辑态底部操作：保存 / 取消。不传则编辑态不渲染底部按钮（纯展示用）。 */
  onSave?: () => void;
  onCancel?: () => void;
  saving?: boolean;
};

/** 详情容器：只负责「板块怎么摆」，板块内部各自独立成文件（见 OrderDetail*.tsx）。
 *  - 编辑态（行展开内联 / 移动端详情弹窗，无 Tab）：字段板块上下堆叠，操作明细最后展示，底部附保存/取消。
 *  - 只读态（行展开 / 库存详情弹窗）：字段板块分栏，操作明细最后展示。 */
export function OrderDetailView({
  meta,
  detail,
  account,
  editing,
  eventDrafts,
  operationDrafts,
  onEventEdit,
  onOperationEdit,
  onAddOperationRow,
  onRemoveOperationRow,
  financeDrafts,
  onFinanceEdit,
  onProfileChange,
  orderDrafts,
  onOrderEdit,
  onOrderExtraChange,
  onPartyEdit,
  employees,
  operatorUsername,
  executionRows,
  operationEvents,
  financeRows,
  expenseCount,
  incomeCount,
  totalExpense,
  totalIncome,
  extraForm,
  onSave,
  onCancel,
  saving,
}: OrderDetailViewProps) {
  if (editing) {
    return (
      <div className="order-detail order-detail--editing">
        <OrderDetailProfileSection meta={meta} detail={detail} account={editing ?? account} editing onProfileChange={onProfileChange} />
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope="INVEDIT" form={extraForm}>
          <FieldConfigScope scope="INVEDIT" active={Boolean(editing)}>
            <OrderDetailDeliverySection meta={meta} detail={detail} account={editing ?? account} employees={employees} editing orderDrafts={orderDrafts} onOrderExtraChange={onOrderExtraChange} onOrderEdit={onOrderEdit} onProfileChange={onProfileChange} />
            <OrderDetailOperationSection meta={meta} editing account={editing ?? account} eventDrafts={eventDrafts} operationDrafts={operationDrafts} onEventEdit={onEventEdit} onOperationEdit={onOperationEdit} onAddOperationRow={onAddOperationRow} onRemoveOperationRow={onRemoveOperationRow} onProfileChange={onProfileChange} employees={employees} operationEvents={operationEvents} operatorUsername={operatorUsername} />
          </FieldConfigScope>
        </BusinessRegistrationForm>
        <OrderDetailFinanceSection
          rows={financeRows}
          orderExtras={meta.orderExtras}
          expenseCount={expenseCount}
          incomeCount={incomeCount}
          totalExpense={totalExpense}
          totalIncome={totalIncome}
          financeDrafts={financeDrafts}
          onFinanceEdit={onFinanceEdit}
          orderDraft={meta.orderId ? orderDrafts?.[meta.orderId] : undefined}
          onOrderExtraChange={meta.orderId == null ? undefined : (key, value) => onOrderExtraChange?.(meta.orderId!, key, value)}
          employees={employees}
          operatorUsername={operatorUsername}
          editing
        />
        <OrderDetailPartySection
          meta={meta}
          detail={detail}
          editing
          onPartyEdit={onPartyEdit}
          orderDraft={meta.orderId ? orderDrafts?.[meta.orderId] : undefined}
          onOrderExtraChange={meta.orderId == null ? undefined : (key, value) => onOrderExtraChange?.(meta.orderId!, key, value)}
        />
        <OrderDetailExecutionSection
          rows={executionRows}
          editing
          eventDrafts={eventDrafts}
          onEventEdit={onEventEdit}
          orderDrafts={orderDrafts}
          onOrderEdit={onOrderEdit}
          onOrderExtraChange={onOrderExtraChange}
          employees={employees}
          operatorUsername={operatorUsername}
        />
        <div className="order-detail__footer">
          <Space>
            <PermissionButton permission="order.update" type="primary" loading={saving} onClick={() => onSave?.()}>保存修改</PermissionButton>
            <PermissionButton permission="order.update" onClick={() => onCancel?.()}>取消</PermissionButton>
          </Space>
        </div>
      </div>
    );
  }

  return (
    <div className="order-detail">
      <OrderDetailProfileSection meta={meta} detail={detail} account={account} />
      <OrderDetailDeliverySection meta={meta} detail={detail} account={account} employees={employees} />
        <OrderDetailOperationSection meta={meta} account={account} operationEvents={operationEvents} operatorUsername={operatorUsername} />
      <OrderDetailFinanceSection
        rows={financeRows}
        orderExtras={meta.orderExtras}
        expenseCount={expenseCount}
        incomeCount={incomeCount}
        totalExpense={totalExpense}
        totalIncome={totalIncome}
      />
      <OrderDetailPartySection meta={meta} />
      <OrderDetailExecutionSection rows={executionRows} employees={employees} operatorUsername={operatorUsername} />
    </div>
  );
}
