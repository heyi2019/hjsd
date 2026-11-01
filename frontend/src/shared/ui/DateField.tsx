import { DatePicker, type DatePickerProps } from "antd";
import dayjs, { type Dayjs } from "dayjs";

/** ERP 业务表单统一使用的日期控件，表单值仍保持 YYYY-MM-DD 字符串。 */
export const dateValueProps = (value: unknown) => ({
  value: value ? dayjs(String(value)) : null,
});

export const dateValueFromEvent = (value: Dayjs | null) => value?.format("YYYY-MM-DD") ?? undefined;

export function DateField(props: DatePickerProps) {
  return <DatePicker {...props} format="YYYY-MM-DD" className="ui-control-full" />;
}
