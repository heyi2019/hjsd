/** 经营中心：经营损益 / 分润对账 / 数据中心（RPT-01）。
 * 各报表视图拆到 ./reports/*.tsx（导出按钮在各自页内），本文件只留 Tab 壳。
 * 统计周期与工作台共享。 */
import { Tabs } from "antd";
import dayjs from "dayjs";
import { useEffect, useState } from "react";
import { DataCenterPanel } from "./DataCenterPanel";
import { useBusinessPeriod } from "../shared/state/businessPeriod";
import { BusinessPeriodPicker } from "../shared/ui/BusinessPeriodPicker";
import { ErrorBanner } from "../shared/ui";
import { Commission } from "./reports/CommissionReport";
import { OrderProfit } from "./reports/OrderProfitReport";
import { OperatingPnl } from "./reports/OperatingPnlReport";
import { type ReportRange, ReportsActiveContext } from "./reports/shared";

export function ReportsPage({ onNavigate, active = true, initialReportTab, initialReportFrom, initialReportTo, initialReportAll = false }: { onNavigate?: (key: string) => void; active?: boolean; initialReportTab?: "commission" | "my-earnings"; initialReportFrom?: string; initialReportTo?: string; initialReportAll?: boolean }) {
  const [myEarnings, setMyEarnings] = useState(initialReportTab === "my-earnings");
  const [activeTab, setActiveTab] = useState(initialReportTab === "commission" || myEarnings ? "r3" : "pnl");
  const periodState = useBusinessPeriod();
  const entryKey = JSON.stringify([initialReportTab, initialReportFrom, initialReportTo, initialReportAll]);
  const [appliedEntry, setAppliedEntry] = useState<string | null>(null);
  useEffect(() => {
    // keep-alive 下离开经营中心时保留个人视图，避免隐藏页在切换期间改请求口径；
    // 重新激活后再按 URL 入口决定是「我的收益」还是完整分润对账。
    if (!active) {
      setAppliedEntry(null);
      return;
    }
    if (!periodState.ready || appliedEntry === entryKey) return;
    setMyEarnings(initialReportTab === "my-earnings");
    if (initialReportAll) {
      periodState.useAllPeriods();
    } else if (initialReportFrom && initialReportTo && dayjs(initialReportFrom).isValid() && dayjs(initialReportTo).isValid() && initialReportFrom <= initialReportTo) {
      periodState.setPeriod({ from: initialReportFrom, to: initialReportTo });
    }
    if (initialReportTab === "commission" || initialReportTab === "my-earnings") setActiveTab("r3");
    setAppliedEntry(entryKey);
  }, [active, initialReportTab, initialReportFrom, initialReportTo, initialReportAll, periodState.ready, appliedEntry, entryKey]);
  const reportRange: ReportRange = {
    params: periodState.period ?? {},
    picker: <BusinessPeriodPicker label="报表日期区间" state={periodState} showAll />,
  };
  const tabItems = [
    { key: "data-center", label: "数据中心", render: () => <DataCenterPanel onNavigate={onNavigate} range={reportRange} /> },
    { key: "profit", label: "订单利润", render: () => <OrderProfit range={reportRange} /> },
    { key: "r3", label: "分润对账", render: () => <Commission range={reportRange} mine={myEarnings} /> },
    { key: "pnl", label: "经营损益", render: () => <OperatingPnl range={reportRange} /> },
  ];
  const entryReady = periodState.ready && appliedEntry === entryKey;

  return (
    <ReportsActiveContext.Provider value={active && entryReady}>
    <section className="ui-stack">
      <ErrorBanner error={periodState.error ? { message: periodState.error } : null} onRetry={periodState.retry} />
      {active && !entryReady && !periodState.error ? <div role="status">正在准备报表…</div> : null}
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={tabItems.map(({ render, ...item }) => ({
          ...item,
          // 隐藏 Tab 不挂载：避免首屏同时发起 13 组请求，也避免切换无关页面时产生状态更新。
          children: activeTab === item.key ? <div hidden={!entryReady}>{render()}</div> : null,
        }))}
      />
    </section>
    </ReportsActiveContext.Provider>
  );
}
