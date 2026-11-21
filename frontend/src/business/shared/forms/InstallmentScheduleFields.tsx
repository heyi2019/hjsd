import { DatePicker, Form } from "antd";
import { BusinessRegistrationField } from "../../../shared/ui";
import "./InstallmentScheduleFields.css";

export type InstallmentScheduleItem = { due_on?: unknown };

/** 唯一的期数→计划行同步规则；两种分期业务不可各自实现。 */
export function resizeInstallmentSchedule(
  current: InstallmentScheduleItem[] | undefined,
  periods: number,
  makeItem: (index: number) => InstallmentScheduleItem = () => ({}),
) {
  const existing = current ?? [];
  return periods > existing.length
    ? [...existing, ...Array.from({ length: periods - existing.length }, (_, index) => makeItem(existing.length + index))]
    : existing.slice(0, periods);
}

/** 合约 API 的计划载荷统一由此生成，确保期号和日期转换一致。 */
export function serializeInstallmentSchedule(
  items: InstallmentScheduleItem[] | undefined,
  toDateString: (value: unknown) => string,
) {
  return (items ?? []).map((item, index) => ({ period_no: index + 1, due_on: toDateString(item.due_on) }));
}

/** 库存售出共用的逐期到期日计划。期数由各自业务表单负责同步。 */
export function InstallmentScheduleFields(props: { name: string }) {
  return <Form.List name={props.name} initialValue={[{}]}>{(fields) => (
    <div className="installment-schedule-list">
      {fields.map((field, index) => <div className="installment-schedule-row" key={field.key}>
        <BusinessRegistrationField label={`第 ${index + 1} 期到期日`} required>
          <Form.Item noStyle name={[field.name, "due_on"]} rules={[{ required: true, message: "请选择到期日" }]}><DatePicker aria-label={`第 ${index + 1} 期到期日`} className="ui-control-full" placeholder="请选择日期" /></Form.Item>
        </BusinessRegistrationField>
      </div>)}
    </div>
  )}</Form.List>;
}
