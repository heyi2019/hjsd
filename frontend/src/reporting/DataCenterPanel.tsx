/** 数据中心：订单、三类成本与利润构成总览；资金明细仍归资金中心负责。 */
import { Space } from "antd";
import { useCallback, useEffect, useState } from "react";
import { ordersApi } from "../shared/api/orders.api";
import { reportsApi } from "../shared/api/reports.api";
import type { DataCenterSummary } from "../shared/api/types/reporting";
import { normalizeError } from "../shared/api/client";
import type { BusinessCenterEntryTab } from "../orders/businessCenter";
import type { ReportRange } from "./reports/shared";
import {
  EntryCard,
  EntryRow,
  ErrorBanner,
  StatRow,
} from "../shared/ui";

export function DataCenterPanel({ onNavigate, range }: { onNavigate?: (key: string, tab?: BusinessCenterEntryTab) => void; range?: ReportRange }) {
  const [orderSummary, setOrderSummary] = useState<{ total_count: number; active_count: number } | null>(null);
  const [summary, setSummary] = useState<DataCenterSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<{ message: string; code?: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const orderParams = range?.params.from || range?.params.to
        ? { trade_date_from: range.params.from, trade_date_to: range.params.to }
        : undefined;
      const reportParams = range?.params.from || range?.params.to
        ? { from: range.params.from, to: range.params.to }
        : undefined;
      const [nextOrderSummary, nextSummary] = await Promise.all([
        ordersApi.summary(orderParams),
        reportsApi.dataCenter(reportParams),
      ]);
      setOrderSummary(nextOrderSummary);
      setSummary(nextSummary);
      setLoadError(null);
    } catch (error) {
      setLoadError(normalizeError(error));
    } finally {
      setLoading(false);
    }
  }, [range?.params.from, range?.params.to]);

  useEffect(() => {
    void load();
  }, [load]);

  const orderCardsUnavailable = orderSummary === null;

  return (
    <section className="ui-stack">
      <ErrorBanner error={loadError} onRetry={() => void load()} retrying={loading} />

      {range ? <Space className="ui-filter-bar ui-filter-bar--spaced">{range.picker}</Space> : null}

      <EntryRow>
        <EntryCard
          title="订单总数"
          value={orderSummary === null ? "不可用" : String(orderSummary.total_count)}
          description="点击进入业务中心 · 订单台账"
          disabled={orderCardsUnavailable}
          onClick={() => onNavigate?.("business", "ledger")}
        />
        <EntryCard
          title="进行中"
          value={orderSummary === null ? "不可用" : String(orderSummary.active_count)}
          description="点击进入业务中心 · 订单台账"
          disabled={orderCardsUnavailable}
          onClick={() => onNavigate?.("business", "ledger")}
        />
      </EntryRow>

      <StatRow
        items={[
          { label: "售出成本", amount: summary?.sold_cost ?? "—" },
          { label: "库存成本（未售出）", amount: summary?.inventory_cost ?? "—" },
          { label: "工作室成本", amount: summary?.studio_cost ?? "—" },
          { label: "账号售出利润", amount: summary?.account_sale_profit ?? "—", tone: "auto" },
          { label: "工作室其他收入", amount: summary?.studio_other_income ?? "—", tone: "auto" },
          { label: "利润", amount: summary?.profit ?? "—", tone: "auto" },
        ]}
      />

      <Space className="muted" size="small">
        利润 = 账号售出利润 + 工作室其他收入；资金池余额、押金和流水请进入资金中心查看。
      </Space>
    </section>
  );
}
