import { Typography } from "antd";
import type { Account, AccountExecutionDetail, AccountExecutionEvent } from "../../shared/api/catalog";
import { OrderEditPanel } from "./OrderEditPanel";
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
  InventoryOrderDraft,
  InventoryPartyDraft,
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
  onEventEdit?: (event: AccountExecutionEvent, changes: { amount?: string; note?: string | null; occurred_at?: string | null; flow_occurred_at?: string | null; operator_user_ids?: number[] }) => void;
  employees: InventoryEmployeeOption[];
  extraForm?: unknown;
  /** 编辑态底部操作：保存 / 取消。不传则编辑态不渲染底部按钮（纯展示用）。 */
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

/** 详情容器：只负责「板块怎么摆」，板块内部各自独立成文件（见 OrderDetail*.tsx）。
 *  - 编辑态（行展开内联 / 移动端详情弹窗，无 Tab）：各板块上下堆叠，账号、订单、交付、事件、资金与参与方统一进入同一保存动作。
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
  timeDrafts,
  onTimeEdit,
  orderDrafts,
  onOrderEdit,
  partyDrafts,
  onPartyEdit,
}: OrderDetailViewProps) {
  const extraFieldsBySection = (section: string): OrderDetailField[] => meta.orderExtras
    .filter((field) => field.section === section)
    .map((field) => ({ key: `order-extra-${field.key}`, label: field.label, value: field.value }));

  if (editing) {
    return <OrderEditPanel
      meta={meta}
      detail={detail}
      account={account}
      editing={editing}
      onEdit={onEdit}
      eventDrafts={eventDrafts}
      onEventEdit={onEventEdit}
      employees={employees}
      executionRows={executionRows}
      financeRows={financeRows}
      expenseCount={expenseCount}
      incomeCount={incomeCount}
      totalExpense={totalExpense}
      totalIncome={totalIncome}
      flowCount={flowCount}
      extraForm={extraForm}
      onSave={onSave}
      onCancel={onCancel}
      saving={saving}
      timeDrafts={timeDrafts}
      onTimeEdit={onTimeEdit}
      orderDrafts={orderDrafts}
      onOrderEdit={onOrderEdit}
      partyDrafts={partyDrafts}
      onPartyEdit={onPartyEdit}
    />;
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
