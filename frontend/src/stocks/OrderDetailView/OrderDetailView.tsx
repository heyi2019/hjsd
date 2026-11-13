import { Space } from "antd";
import type { FormInstance } from "antd";
import type { AccountExecutionDetail, AccountExecutionEvent } from "../../shared/api/types/account-execution";
import type { Account } from "../../shared/api/types/accounts";
import { BusinessRegistrationForm, PermissionButton } from "../../shared/ui";
import { FieldConfigScope } from "../../orders/ConfigurableField";
import { OrderDetailDeliverySection } from "./OrderDetailDeliverySection";
import { OrderDetailExecutionSection } from "./OrderDetailExecutionSection";
import { OrderDetailFinanceSection } from "./OrderDetailFinanceSection";
import { OrderDetailOperationSection } from "./OrderDetailOperationSection";
import { OrderDetailProfileSection } from "./OrderDetailProfileSection";
import { OrderDetailPartySection } from "./OrderDetailPartySection";
import type {
  OrderDetailMeta,
  InventoryEmployeeOption,
  InventoryEventDraft,
  InventoryExecutionRow,
  InventoryFinanceRow,
} from "./OrderDetail.shared";
import "./OrderDetail.css";
import { OrderDetailTimeShiftSection } from "./OrderDetailTimeShiftSection";

type OrderDetailViewProps = {
  meta: OrderDetailMeta;
  detail?: AccountExecutionDetail | null;
  account?: Account | null;
  executionRows: InventoryExecutionRow[];
  financeRows: InventoryFinanceRow[];
  expenseCount: number;
  incomeCount: number;
  totalExpense: string;
  totalIncome: string;
  editing?: Account | null;
  eventDrafts?: Record<number, InventoryEventDraft>;
  onEventEdit?: (event: AccountExecutionEvent, changes: { amount?: string; note?: string | null; operator_user_ids?: number[] }) => void;
  employees: InventoryEmployeeOption[];
  extraForm?: FormInstance;
  /** 编辑态底部操作：保存 / 取消。不传则编辑态不渲染底部按钮（纯展示用）。 */
  onSave?: () => void;
  onCancel?: () => void;
  saving?: boolean;
  /** 编辑态时间联动：当前平移天数与 setter（由库存台账控制器持有）。 */
  timeShiftMinutes?: number;
  onTimeShift?: (minutes: number) => void;
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
  onEventEdit,
  employees,
  executionRows,
  financeRows,
  expenseCount,
  incomeCount,
  totalExpense,
  totalIncome,
  extraForm,
  onSave,
  onCancel,
  saving,
  timeShiftMinutes,
  onTimeShift,
}: OrderDetailViewProps) {
  if (editing) {
    return (
      <div className="inventory-detail inventory-detail--editing">
        <OrderDetailProfileSection meta={meta} detail={detail} account={account ?? editing} />
        <OrderDetailTimeShiftSection
          registeredAt={meta.registeredAt}
          soldAt={meta.soldAt}
          flowAt={financeRows.find((row) => row.key.startsWith("flow-"))?.occurredAt ?? financeRows[0]?.occurredAt ?? "-"}
          shiftMinutes={timeShiftMinutes ?? 0}
          onShift={onTimeShift ?? (() => undefined)}
        />
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope="INVEDIT" form={extraForm}>
          <FieldConfigScope scope="INVEDIT" active={Boolean(editing)}>
            <OrderDetailDeliverySection meta={meta} detail={detail} account={account} employees={employees} editing />
            <OrderDetailOperationSection meta={meta} editing />
          </FieldConfigScope>
        </BusinessRegistrationForm>
        <OrderDetailFinanceSection
          rows={financeRows}
          orderExtras={meta.orderExtras}
          expenseCount={expenseCount}
          incomeCount={incomeCount}
          totalExpense={totalExpense}
          totalIncome={totalIncome}
          editing
        />
        <OrderDetailPartySection meta={meta} editing />
        <OrderDetailExecutionSection
          rows={executionRows}
          editing
          eventDrafts={eventDrafts}
          onEventEdit={onEventEdit}
          employees={employees}
        />
        <div className="inventory-detail__footer">
          <Space>
            <PermissionButton permission="order.create" type="primary" loading={saving} onClick={() => onSave?.()}>保存修改</PermissionButton>
            <PermissionButton permission="order.create" onClick={() => onCancel?.()}>取消</PermissionButton>
          </Space>
        </div>
      </div>
    );
  }

  return (
    <div className="inventory-detail">
      <OrderDetailProfileSection meta={meta} detail={detail} account={account} />
      <OrderDetailDeliverySection meta={meta} detail={detail} account={account} employees={employees} />
      <OrderDetailOperationSection meta={meta} />
      <OrderDetailFinanceSection
        rows={financeRows}
        orderExtras={meta.orderExtras}
        expenseCount={expenseCount}
        incomeCount={incomeCount}
        totalExpense={totalExpense}
        totalIncome={totalIncome}
      />
      <OrderDetailPartySection meta={meta} />
      <OrderDetailExecutionSection rows={executionRows} employees={employees} />
    </div>
  );
}
