import { Space, Typography } from "antd";
import dayjs from "dayjs";
import type { Account, AccountExecutionDetail, AccountExecutionEvent } from "../shared/api/catalog";
import { BusinessRegistrationForm, DateField, PermissionButton } from "../shared/ui";
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
  TimeFieldKey,
  TimeSet,
} from "./OrderDetail.shared";
import "./OrderDetail.css";

// 详情视图的共享行类型出口。
export type { InventoryExecutionRow, InventoryFinanceRow, InventoryPartyLink } from "./OrderDetail.shared";
export type { TimeFieldKey, TimeSet } from "./OrderDetail.shared";

/** 编辑态时间编辑（#15 需求2）：三个系统时间戳可独立绝对设值或清空。
 *  台账显示的这三个值分别是 Order.created_at / SELL 事件 posted_at / Cashflow.created_at，
 *  后端按字段绝对写入（清空=置 NULL），不涉及相对平移。 */
function TimeShiftFields({
  base, timeSet, onTimeSet,
}: {
  base: Record<TimeFieldKey, string>;
  timeSet: TimeSet;
  onTimeSet: (field: TimeFieldKey, value: string | null) => void;
}) {
  const items: { key: TimeFieldKey; label: string }[] = [
    { key: "registeredAt", label: "订单创建时间" },
    { key: "soldAt", label: "售出时间" },
    { key: "flowAt", label: "流水时间" },
  ];
  return (
    <div className="inventory-detail__section inventory-time-shift">
      <div className="inventory-detail__section-heading">
        <Typography.Text strong>时间编辑</Typography.Text>
        <Typography.Text type="secondary">
          三个系统时间戳可独立设值或清空（清空即删除该时间），分期还款计划不变
        </Typography.Text>
      </div>
      <div className="inventory-time-shift__fields">
        {items.map(({ key, label }) => {
          const raw = timeSet[key] !== undefined ? timeSet[key] : base[key];
          const value = raw && raw !== "-" ? dayjs(String(raw)) : null;
          return (
            <label key={key} className="inventory-time-shift__field">
              <span>{label}</span>
              <DateField
                showTime={{ format: "HH:mm" }}
                format="YYYY-MM-DD HH:mm"
                minuteStep={1}
                allowClear
                aria-label={`编辑${label}`}
                value={value}
                onChange={(v) => onTimeSet(key, v && v.isValid() ? v.format("YYYY-MM-DDTHH:mm:ss") : null)}
              />
            </label>
          );
        })}
      </div>
    </div>
  );
}

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
  /** 编辑态时间编辑：已改动的字段与 setter（由库存台账控制器持有）。 */
  timeSet?: TimeSet;
  onTimeSet?: (field: TimeFieldKey, value: string | null) => void;
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
  timeSet,
  onTimeSet,
}: OrderDetailViewProps) {
  const extraFieldsBySection = (section: string): OrderDetailField[] => meta.orderExtras
    .filter((field) => field.section === section)
    .map((field) => ({ key: `order-extra-${field.key}`, label: field.label, value: field.value }));

  if (editing) {
    return (
      <div className="inventory-detail inventory-detail--editing">
        <OrderDetailProfileSection meta={meta} detail={detail} account={editing ?? account} editing onEdit={onEdit} />
        <TimeShiftFields
          base={{
            registeredAt: meta.registeredAt,
            soldAt: meta.soldAt,
            flowAt: financeRows.find((row) => row.key.startsWith("flow-"))?.occurredAt ?? financeRows[0]?.occurredAt ?? "-",
          }}
          timeSet={timeSet ?? {}}
          onTimeSet={onTimeSet ?? (() => undefined)}
        />
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
