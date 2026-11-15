/** 数据中心：订单、库存成本与经营结果总览。资金池余额、押金和流水归资金中心负责。 */
import { Space } from "antd";
import { useCallback, useEffect, useState } from "react";
import { cashflowsApi } from "../shared/api/cashflows.api";
import { ordersApi } from "../shared/api/orders.api";
import { reportsApi } from "../shared/api/reports.api";
import { stocksApi } from "../shared/api/stocks.api";
import type { BusinessPnlReport } from "../shared/api/types/reporting";
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
  const [businessPnl, setBusinessPnl] = useState<BusinessPnlReport | null>(null);
  const [inventoryCost, setInventoryCost] = useState<string | null>(null);
  const [studioExpense, setStudioExpense] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<{ message: string; code?: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const orderParams = range?.params.from || range?.params.to
        ? { trade_date_from: range.params.from, trade_date_to: range.params.to }
        : undefined;
      setOrderSummary(await ordersApi.summary(orderParams));
      const reportParams = range?.params.from || range?.params.to
        ? { from: range.params.from, to: range.params.to }
        : undefined;
      setBusinessPnl(await reportsApi.businessPnl(reportParams));
      const studioSummary = await cashflowsApi.studioSummary({
        occurred_from: range?.params.from,
        occurred_to: range?.params.to,
      });
      setStudioExpense(studioSummary.approved_expense);
      const inventorySummary = await stocksApi.inventoryCostSummary({
        entry_date_from: range?.params.from,
        entry_date_to: range?.params.to,
      });
      setInventoryCost(inventorySummary.total_cost);
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

  const totalInventoryCost = inventoryCost ?? "—";
  const totalProfit = businessPnl?.total.main_profit ?? "—";
  const totalStudioExpense = studioExpense ?? "—";

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
          { label: "在途成本", amount: totalInventoryCost },
          { label: "利润", amount: totalProfit, tone: "auto" },
          { label: "工作室支出", amount: totalStudioExpense },
        ]}
      />

      <Space className="muted" size="small">
        在途成本按库存入库口径统计；资金池余额、押金和流水请进入资金中心查看。
      </Space>
    </section>
  );
}
