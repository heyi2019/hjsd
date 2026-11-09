import { DatePicker, type DatePickerProps } from "antd";
import type { RangePickerProps } from "antd/es/date-picker";
import dayjs, { type Dayjs } from "dayjs";

/** ERP 业务表单统一使用的日期控件。默认只选日期（YYYY-MM-DD）；
 *  调用方传入 format / showTime 时可升级为分钟级选择（如台账时间联动）。 */
export const dateValueProps = (value: unknown) => ({
  value: value ? dayjs(String(value)) : null,
});

export const dateValueFromEvent = (value: Dayjs | null) => value?.format("YYYY-MM-DD") ?? undefined;

export function DateField(props: DatePickerProps) {
  const { format = "YYYY-MM-DD", ...rest } = props;
  return <DatePicker {...rest} format={format} className="ui-control-full" />;
}

type DateRangeFieldProps = Omit<RangePickerProps, "aria-label"> & {
  /** 可访问的范围名称；开始/结束字段会在该名称后追加明确的字段名。 */
  ariaLabel: string;
  /** 同一页面内稳定、唯一的字段前缀。 */
  rangeId: string;
  startLabel?: string;
  endLabel?: string;
};

/** 日期范围控件：给两个原生输入分别建立标签，并统一使用中文范围分隔符。 */
export function DateRangeField({
  ariaLabel,
  rangeId,
  startLabel = "开始日期",
  endLabel = "结束日期",
  separator = "至",
  ...props
}: DateRangeFieldProps) {
  const startId = `${rangeId}-start`;
  const endId = `${rangeId}-end`;
  return (
    <div className="ui-date-range-field" role="group" aria-label={ariaLabel}>
      <label className="ui-visually-hidden" htmlFor={startId}>{`${ariaLabel}${startLabel}`}</label>
      <label className="ui-visually-hidden" htmlFor={endId}>{`${ariaLabel}${endLabel}`}</label>
      <DatePicker.RangePicker
        {...props}
        id={{ start: startId, end: endId }}
        separator={separator}
      />
    </div>
  );
}
