import dayjs, { type Dayjs } from "dayjs";

export interface ReportPeriod {
  from: string;
  to: string;
}

function periodStart(month: Dayjs, startDay: number): Dayjs {
  return month.startOf("month").date(Math.min(startDay, month.daysInMonth()));
}

function currentPeriodStart(reference: Dayjs, startDay: number): Dayjs {
  const month = reference.startOf("month");
  const start = periodStart(month, startDay);
  return reference.startOf("day").isBefore(start) ? periodStart(month.subtract(1, "month"), startDay) : start;
}

export function currentReportPeriod(reference: Dayjs = dayjs(), startDay = 16): ReportPeriod {
  const from = currentPeriodStart(reference, startDay);
  const next = periodStart(from.startOf("month").add(1, "month"), startDay);
  return { from: from.format("YYYY-MM-DD"), to: next.subtract(1, "day").format("YYYY-MM-DD") };
}

export function previousReportPeriod(reference: Dayjs = dayjs(), startDay = 16): ReportPeriod {
  const currentFrom = currentPeriodStart(reference, startDay);
  const from = periodStart(currentFrom.startOf("month").subtract(1, "month"), startDay);
  return { from: from.format("YYYY-MM-DD"), to: currentFrom.subtract(1, "day").format("YYYY-MM-DD") };
}
