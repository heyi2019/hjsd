import { DatePicker, Space, Typography } from "antd";
import dayjs from "dayjs";
import type { PeriodState } from "../state/businessPeriod";

export function BusinessPeriodPicker({ label = "当期日期区间", state }: { label?: string; state: PeriodState }) {
  const { period, setPeriod, useCurrentPeriod, usePreviousPeriod, ready } = state;
  return <Space size="small">
    <DatePicker.RangePicker
      aria-label={label} placeholder={["开始日期", "结束日期"]} format="YYYY-MM-DD"
      size="small" placement="bottomLeft" classNames={{ popup: { root: "compact-date-range-picker" } }}
      value={[dayjs(period.from), dayjs(period.to)]} allowClear={false} disabled={!ready}
      onChange={(value) => {
        if (value?.[0] && value?.[1]) setPeriod({ from: value[0].format("YYYY-MM-DD"), to: value[1].format("YYYY-MM-DD") });
      }}
    />
    <Typography.Link role="button" tabIndex={0} onClick={useCurrentPeriod}>本期</Typography.Link>
    <Typography.Link role="button" tabIndex={0} onClick={usePreviousPeriod}>上期</Typography.Link>
  </Space>;
}
