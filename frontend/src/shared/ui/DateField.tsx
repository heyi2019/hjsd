import { DatePicker, type DatePickerProps } from "antd";
import dayjs, { type Dayjs } from "dayjs";

/** ERP 业务表单统一使用的日期控件。默认只选日期（YYYY-MM-DD）；
 *  调用方传入 format / showTime 时可升级为分钟级选择。 */
export const dateValueProps = (value: unknown) => ({
  value: value ? dayjs(String(value)) : null,
});

export const dateValueFromEvent = (value: Dayjs | null) => value?.format("YYYY-MM-DD") ?? undefined;

export function DateField(props: DatePickerProps) {
  const { format = "YYYY-MM-DD", className, ...rest } = props;
  return <DatePicker {...rest} format={format} className={["ui-control-full", className].filter(Boolean).join(" ")} />;
}
