import dayjs, { type Dayjs } from "dayjs";

export interface ReportPeriod {
  from: string;
  to: string;
}

function currentPeriodStart(reference: Dayjs): Dayjs {
  const month = reference.date() >= 16
    ? reference.startOf("month")
    : reference.subtract(1, "month").startOf("month");
  return month.date(16);
}

export function currentReportPeriod(reference: Dayjs = dayjs()): ReportPeriod {
  const from = currentPeriodStart(reference);
  return { from: from.format("YYYY-MM-DD"), to: from.add(1, "month").date(15).format("YYYY-MM-DD") };
}

export function previousReportPeriod(reference: Dayjs = dayjs()): ReportPeriod {
  const currentFrom = currentPeriodStart(reference);
  const from = currentFrom.subtract(1, "month").date(16);
  return { from: from.format("YYYY-MM-DD"), to: currentFrom.subtract(1, "day").format("YYYY-MM-DD") };
}
