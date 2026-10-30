import { Space, Tabs } from "antd";
import type { Account, AccountExecutionEvent } from "../shared/api/catalog";
import { BusinessForm, PermissionButton } from "../shared/ui";
import { FieldConfigScope } from "../orders/ConfigurableField";
import { OrderDetailDeliverySection } from "./OrderDetailDeliverySection";
import { OrderDetailExecutionSection } from "./OrderDetailExecutionSection";
import { OrderDetailFinanceSection } from "./OrderDetailFinanceSection";
import { OrderDetailOperationSection } from "./OrderDetailOperationSection";
import { OrderDetailProfileSection } from "./OrderDetailProfileSection";
import type {
  OrderDetailField,
  OrderDetailMeta,
  InventoryEmployeeOption,
  InventoryEventDraft,
  InventoryExecutionRow,
  InventoryFinanceRow,
} from "./OrderDetail.shared";
import "./OrderDetail.css";

// 兼容既有引用路径：外部仍从本文件取这三个行类型。
export type { InventoryExecutionRow, InventoryFinanceRow, InventoryPartyLink } from "./OrderDetail.shared";

type OrderDetailViewProps = {
  meta: OrderDetailMeta;
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
        <OrderDetailProfileSection meta={meta} editing account={editing} onEdit={onEdit} />
        <BusinessForm scope="INVEDIT" form={extraForm as never}>
          <FieldConfigScope scope="INVEDIT" active={Boolean(editing)}>
            <OrderDetailDeliverySection meta={meta} editing />
            <OrderDetailOperationSection meta={meta} editing />
          </FieldConfigScope>
        </BusinessForm>
        <OrderDetailExecutionSection
          rows={executionRows}
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
          editing
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
      <Tabs
        className="inventory-detail__tabs"
        size="small"
        defaultActiveKey="profile"
        // forceRender：五个板块一次性挂载。既有用例会同时断言不同板块的字段，
        // 若不预渲染，未激活板块尚未进入 DOM，断言会失效。
        items={[
          { key: "profile", label: "游戏账号信息", forceRender: true, children: <OrderDetailProfileSection meta={meta} /> },
          { key: "delivery", label: "交付信息", forceRender: true, children: <OrderDetailDeliverySection meta={meta} /> },
          { key: "operation", label: "运营信息", forceRender: true, children: <OrderDetailOperationSection meta={meta} /> },
          {
            key: "finance",
            label: "资金明细",
            forceRender: true,
            children: (
              <OrderDetailFinanceSection
                rows={financeRows}
                extraFields={extraFieldsBySection("FINANCE")}
                expenseCount={expenseCount}
                incomeCount={incomeCount}
                totalExpense={totalExpense}
                totalIncome={totalIncome}
                flowCount={flowCount}
              />
            ),
          },
          { key: "execution", label: "操作明细", forceRender: true, children: <OrderDetailExecutionSection rows={executionRows} employees={employees} /> },
        ]}
      />
    </div>
  );
}
