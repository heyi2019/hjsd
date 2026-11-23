import { DatePicker } from "antd";
import type { Dayjs } from "dayjs";

export function BusinessDateRangeFilter({ label, value, onChange }: {
  label: string;
  value: [Dayjs, Dayjs] | null;
  onChange: (value: [Dayjs, Dayjs] | null) => void;
}) {
  return <DatePicker.RangePicker
    aria-label={label}
    placeholder={["开始日期", "结束日期"]}
    format="YYYY-MM-DD"
    size="small"
    placement="bottomLeft"
    classNames={{ popup: { root: "compact-date-range-picker" } }}
    value={value}
    onChange={(next) => onChange(next?.[0] && next[1] ? [next[0], next[1]] : null)}
  />;
}
