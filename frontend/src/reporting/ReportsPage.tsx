/** 经营中心：月度损益 / 分润对账 / 业务损益 / 数据中心（RPT-01）。
 * 各报表视图拆到 ./reports/*.tsx（导出按钮在各自页内），本文件只留 Tab 壳。 */
import { Input, Space, Tabs, Typography } from "antd";
import { useEffect, useState } from "react";
import { DataCenterPanel } from "./DataCenterPanel";
import { currentReportPeriod, previousReportPeriod } from "./reportPeriod";
import { BusinessPnl } from "./reports/BusinessPnlReport";
import { Commission } from "./reports/CommissionReport";
import { MonthlyPnl } from "./reports/MonthlyPnlReport";
import { OrderProfit } from "./reports/OrderProfitReport";
import { type ReportRange, ReportsActiveContext } from "./reports/shared";

export function ReportsPage({ onNavigate, active = true, initialReportTab }: { onNavigate?: (key: string) => void; active?: boolean; initialReportTab?: "commission" | "my-earnings" }) {
  const [myEarnings, setMyEarnings] = useState(initialReportTab === "my-earnings");
  const [activeTab, setActiveTab] = useState(initialReportTab === "commission" || myEarnings ? "r3" : "r2");
  // 报表视图统计周期：提升到父级，避免切换 Tab（非挂载）后筛选条件丢失。
  const [reportFrom, setReportFrom] = useState("");
  const [reportTo, setReportTo] = useState("");
  const applyReportPeriod = (period: { from: string; to: string }) => {
    setReportFrom(period.from);
    setReportTo(period.to);
  };
  useEffect(() => {
    // keep-alive 下离开经营中心时保留个人视图，避免隐藏页在切换期间改请求口径；
    // 重新激活后再按 URL 入口决定是「我的收益」还是完整分润对账。
    if (!active) return;
    setMyEarnings(initialReportTab === "my-earnings");
    if (initialReportTab === "commission" || initialReportTab === "my-earnings") setActiveTab("r3");
  }, [active, initialReportTab]);
  const reportRange: ReportRange = {
    params: { from: reportFrom || undefined, to: reportTo || undefined },
    picker: (
      <Space size="small">
        <Input type="date" value={reportFrom} onChange={(event) => setReportFrom(event.target.value)} className="ui-control-width-date" />
        <span className="muted">至</span>
        <Input type="date" value={reportTo} onChange={(event) => setReportTo(event.target.value)} className="ui-control-width-date" />
        <Typography.Link role="button" tabIndex={0} onClick={() => applyReportPeriod(currentReportPeriod())}>本期</Typography.Link>
        <Typography.Link role="button" tabIndex={0} onClick={() => applyReportPeriod(previousReportPeriod())}>上期</Typography.Link>
      </Space>
    ),
  };
  const tabItems = [
    { key: "data-center", label: "数据中心", render: () => <DataCenterPanel onNavigate={onNavigate} range={reportRange} /> },
    { key: "profit", label: "订单利润", render: () => <OrderProfit range={reportRange} /> },
    { key: "r3", label: "分润对账", render: () => <Commission range={reportRange} mine={myEarnings} /> },
    { key: "r2", label: "月度损益", render: () => <MonthlyPnl range={reportRange} /> },
    { key: "r5", label: "业务损益", render: () => <BusinessPnl range={reportRange} /> },
  ];

  return (
    <ReportsActiveContext.Provider value={active}>
    <section className="ui-stack">
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={tabItems.map(({ render, ...item }) => ({
          ...item,
          // 隐藏 Tab 不挂载：避免首屏同时发起 13 组请求，也避免切换无关页面时产生状态更新。
          children: activeTab === item.key ? render() : null,
        }))}
      />
    </section>
    </ReportsActiveContext.Provider>
  );
}
