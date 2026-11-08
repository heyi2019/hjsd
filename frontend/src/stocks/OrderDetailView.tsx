import { Space, Typography } from "antd";
import type { Account, AccountExecutionDetail, AccountExecutionEvent } from "../shared/api/catalog";
import { BusinessRegistrationForm, PermissionButton } from "../shared/ui";
import { FieldConfigScope } from "../orders/ConfigurableField";
import { OrderDetailDeliverySection } from "./OrderDetailDeliverySection";
import { OrderDetailExecutionSection } from "./OrderDetailExecutionSection";
import { OrderDetailFinanceSection } from "./OrderDetailFinanceSection";
import { OrderDetailOperationSection } from "./OrderDetailOperationSection";
import { OrderDetailProfileSection } from "./OrderDetailProfileSection";
import { OrderDetailPartySection } from "./OrderDetailPartySection";
import type {
  OrderDetailField,
  OrderDetailMeta,
  InventoryEmployeeOption,
  InventoryEventDraft,
  InventoryExecutionRow,
  InventoryFinanceRow,
} from "./OrderDetail.shared";
import "./OrderDetail.css";

// 详情视图的共享行类型出口。
export type { InventoryExecutionRow, InventoryFinanceRow, InventoryPartyLink } from "./OrderDetail.shared";
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
  flowCount: number;
  editing?: Account | null;
  onEdit?: (account: Account) => void;
  eventDrafts?: Record<number, InventoryEventDraft>;
  onEventEdit?: (event: AccountExecutionEvent, changes: { amount?: string; note?: string | null; operator_user_ids?: number[] }) => void;
  employees: InventoryEmployeeOption[];
  extraForm?: unknown;
  /** 编辑态底部操作：保存 / 取消。不传则编辑态不渲染底部按钮（纯展示用）。 */
  onSave?: () => void;
  onCancel?: () => void;
  saving?: boolean;
};

/** 详情容器：只负责「板块怎么摆」，板块内部各自独立成文件（见 OrderDetail*.tsx）。
 *  - 编辑态（行展开内联 / 移动端详情弹窗，无 Tab）：5 板块上下堆叠，1/2/3 字段可编辑、4/5 流水只读，底部附保存/取消。
 *  - 只读态（行展开 / 库存详情弹窗）：5 板块分栏，默认落在游戏账号信息。 */
export function OrderDetailView({
  meta,
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
}: OrderDetailViewProps) {
  const extraFieldsBySection = (section: string): OrderDetailField[] => meta.orderExtras
    .filter((field) => field.section === section)
    .map((field) => ({ key: `order-extra-${field.key}`, label: field.label, value: field.value }));

  if (editing) {
    return (
      <div className="inventory-detail inventory-detail--editing">
        <OrderDetailProfileSection meta={meta} detail={detail} account={editing ?? account} editing onEdit={onEdit} />
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope="INVEDIT" form={extraForm as never}>
          <FieldConfigScope scope="INVEDIT" active={Boolean(editing)}>
            <OrderDetailDeliverySection meta={meta} detail={detail} account={account} employees={employees} editing />
            <OrderDetailOperationSection meta={meta} editing />
          </FieldConfigScope>
        </BusinessRegistrationForm>
        <OrderDetailExecutionSection
          rows={executionRows}
          audit={detail?.audit}
          editing
          eventDrafts={eventDrafts}
          onEventEdit={onEventEdit}
          employees={employees}
        />
        <OrderDetailFinanceSection
          rows={financeRows}
          extraFields={extraFieldsBySection("FINANCE")}
          expenseCount={expenseCount}
          incomeCount={incomeCount}
          totalExpense={totalExpense}
          totalIncome={totalIncome}
          flowCount={flowCount}
        />
        <OrderDetailPartySection meta={meta} />
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
        extraFields={extraFieldsBySection("FINANCE")}
        expenseCount={expenseCount}
        incomeCount={incomeCount}
        totalExpense={totalExpense}
        totalIncome={totalIncome}
        flowCount={flowCount}
      />
      <OrderDetailExecutionSection rows={executionRows} audit={detail?.audit} employees={employees} />
      <OrderDetailPartySection meta={meta} />
    </div>
  );
}
