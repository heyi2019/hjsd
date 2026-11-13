import { Space, Typography } from "antd";
import dayjs from "dayjs";
import type { AccountExecutionDetail, AccountExecutionEvent } from "../shared/api/types/account-execution";
import type { Account } from "../shared/api/types/accounts";
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
} from "./OrderDetail.shared";
import "./OrderDetail.css";

/** 编辑态时间联动：三个锚点都能改，任一改动按天数差平移整条时间轴，另两项即时预览。
 *  台账显示的这三个值分别是 Order.created_at / SELL 事件 posted_at / Cashflow.created_at，
 *  后端按同一个 delta 平移账期与展示时间戳，保证界面与报表归属不脱节。 */
function TimeShiftFields({
  registeredAt, soldAt, flowAt, shiftMinutes, onShift,
}: {
  registeredAt: string;
  soldAt: string;
  flowAt: string;
  shiftMinutes: number;
  onShift: (minutes: number) => void;
}) {
  const field = (label: string, original: string) => {
    const base = original && original !== "-" ? original : "";
    const shown = base ? dayjs(base).add(shiftMinutes, "minute").format("YYYY-MM-DD HH:mm") : "";
    return (
      <label className="inventory-time-shift__field">
        <span>{label}</span>
        <DateField
          showTime={{ format: "HH:mm" }}
          format="YYYY-MM-DD HH:mm"
          minuteStep={1}
          aria-label={`编辑${label}`}
          disabled={!base}
          value={shown ? dayjs(shown) : null}
          onChange={(value) => onShift(value && base ? value.diff(dayjs(base), "minute") : 0)}
        />
      </label>
    );
  };
  return (
    <div className="inventory-detail__section inventory-time-shift">
      <div className="inventory-detail__section-heading">
        <Typography.Text strong>时间联动</Typography.Text>
        <Typography.Text type="secondary">
          {shiftMinutes === 0
            ? "改任一项，本单订单、事件与资金流水时间同步平移，分期还款计划不变"
            : `整单时间轴平移 ${shiftMinutes} 分钟，分期还款计划不变`}
        </Typography.Text>
      </div>
      <div className="inventory-time-shift__fields">
        {field("订单创建时间", registeredAt)}
        {field("售出时间", soldAt)}
        {field("流水时间", flowAt)}
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
  eventDrafts?: Record<number, InventoryEventDraft>;
  onEventEdit?: (event: AccountExecutionEvent, changes: { amount?: string; note?: string | null; operator_user_ids?: number[] }) => void;
  employees: InventoryEmployeeOption[];
  extraForm?: unknown;
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
  flowCount,
  extraForm,
  onSave,
  onCancel,
  saving,
  timeShiftMinutes,
  onTimeShift,
}: OrderDetailViewProps) {
  const extraFieldsBySection = (section: string): OrderDetailField[] => meta.orderExtras
    .filter((field) => field.section === section)
    .map((field) => ({ key: `order-extra-${field.key}`, label: field.label, value: field.value }));

  if (editing) {
    return (
      <div className="inventory-detail inventory-detail--editing">
        <OrderDetailProfileSection meta={meta} detail={detail} account={account ?? editing} />
        <TimeShiftFields
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
          wrapperCol={{ flex: "auto" }} scope="INVEDIT" form={extraForm as never}>
          <FieldConfigScope scope="INVEDIT" active={Boolean(editing)}>
            <OrderDetailDeliverySection meta={meta} detail={detail} account={account} employees={employees} editing />
            <OrderDetailOperationSection meta={meta} editing />
          </FieldConfigScope>
        </BusinessRegistrationForm>
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
        extraFields={extraFieldsBySection("FINANCE")}
        expenseCount={expenseCount}
        incomeCount={incomeCount}
        totalExpense={totalExpense}
        totalIncome={totalIncome}
        flowCount={flowCount}
      />
      <OrderDetailPartySection meta={meta} />
      <OrderDetailExecutionSection rows={executionRows} employees={employees} />
    </div>
  );
}
