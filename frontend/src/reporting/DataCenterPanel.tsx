/** 数据中心：订单、三类成本与利润构成总览；资金明细仍归资金中心负责。 */
import { Space } from "antd";
import { useCallback } from "react";
import { reportsApi } from "../shared/api/reports.api";
import type { DataCenterSummary } from "../shared/api/types/reporting";
import type { BusinessCenterEntryTab } from "../orders/businessCenter";
import { type ReportRange, useReport } from "./reports/shared";
import {
  EntryCard,
  EntryRow,
  ErrorBanner,
  StatRow,
} from "../shared/ui";

export function DataCenterPanel({ onNavigate, range }: { onNavigate?: (key: string, tab?: BusinessCenterEntryTab) => void; range?: ReportRange }) {
  const from = range?.params.from;
  const to = range?.params.to;
  const reportParams = from || to ? { from, to } : undefined;
  const summaryReport = useReport<DataCenterSummary>(
    () => reportsApi.dataCenter(reportParams),
    [from, to],
  );
  const loading = summaryReport.loading;
  const loadError = summaryReport.error;
  const reload = useCallback(() => {
    summaryReport.reload();
  }, [summaryReport.reload]);
  const summary = summaryReport.data;

  const orderCardsUnavailable = summary === null;

  return (
    <section className="ui-stack">
      <ErrorBanner error={loadError} onRetry={reload} retrying={loading} />

      {range ? <Space className="ui-filter-bar ui-filter-bar--spaced">{range.picker}</Space> : null}

      <EntryRow>
        <EntryCard
          title="订单总数"
          value={summary === null ? "不可用" : String(summary.order_count)}
          description="点击进入业务中心 · 订单台账"
          disabled={orderCardsUnavailable}
          onClick={() => onNavigate?.("business", "ledger")}
        />
        <EntryCard
          title="进行中"
          value={summary === null ? "不可用" : String(summary.active_order_count)}
          description="点击进入业务中心 · 订单台账"
          disabled={orderCardsUnavailable}
          onClick={() => onNavigate?.("business", "ledger")}
        />
      </EntryRow>

      <StatRow
        items={[
          { label: "售出成本", amount: summary?.sold_cost ?? "—" },
          { label: "在途成本", amount: summary?.in_transit_cost ?? "—" },
          { label: "押金占用", amount: summary?.deposit_held ?? "—" },
          { label: "工作室成本", amount: summary?.studio_cost ?? "—" },
          { label: "账号售出利润", amount: summary?.account_sale_profit ?? "—", tone: "auto" },
          { label: "工作室其他收入", amount: summary?.studio_other_income ?? "—", tone: "auto" },
          { label: "利润", amount: summary?.profit ?? "—", tone: "auto" },
        ]}
      />

      <Space className="muted" size="small">
        利润 = 账号售出利润 + 工作室其他收入；资金池余额和流水请进入资金中心查看。
      </Space>
    </section>
  );
}
