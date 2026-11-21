import { DatePicker, Space } from "antd";
import dayjs from "dayjs";
import type { PeriodState } from "../state/businessPeriod";
import "./BusinessPeriodPicker.css";

export function BusinessPeriodPicker({ label = "当期日期区间", state, showAll = false }: { label?: string; state: PeriodState; showAll?: boolean }) {
  const { period, setPeriod, useCurrentPeriod, usePreviousPeriod, useAllPeriods, ready } = state;
  return <Space size="small" wrap>
    <DatePicker.RangePicker
      aria-label={label} placeholder={["开始日期", "结束日期"]} format="YYYY-MM-DD"
      size="small" placement="bottomLeft" classNames={{ popup: { root: "compact-date-range-picker" } }}
      value={period ? [dayjs(period.from), dayjs(period.to)] : null} allowClear={false} allowEmpty={[true, true]} disabled={!ready}
      onChange={(value) => {
        if (value?.[0] && value?.[1]) setPeriod({ from: value[0].format("YYYY-MM-DD"), to: value[1].format("YYYY-MM-DD") });
      }}
    />
    <Space size="small">
      <button type="button" className="ui-period-shortcut" disabled={!ready} onClick={useCurrentPeriod}>本期</button>
      <button type="button" className="ui-period-shortcut" disabled={!ready} onClick={usePreviousPeriod}>上期</button>
      {showAll ? <button type="button" className="ui-period-shortcut" disabled={!ready} aria-pressed={period === null} onClick={useAllPeriods}>全部</button> : null}
    </Space>
  </Space>;
}
