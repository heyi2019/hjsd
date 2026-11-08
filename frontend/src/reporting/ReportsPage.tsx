/** 经营中心：库存 R1 / 月度损益 R2 / 提成对账 R3 / 资金报表·日报 R4 / 业务损益 R5。
 * 各报表视图拆到 ./reports/*.tsx（导出按钮在各自页内），本文件只留 Tab 壳。 */
import { Input, Space, Tabs } from "antd";
import { useEffect, useState } from "react";
import { AuditPanel } from "../audit/AuditPanel";
import { BusinessPnl } from "./reports/BusinessPnlReport";
import { Commission } from "./reports/CommissionReport";
import { DailyFunds } from "./reports/DailyFundsReport";
import { InventoryReport } from "./reports/InventoryReport";
import { MonthlyPnl } from "./reports/MonthlyPnlReport";
import { OrderProfit } from "./reports/OrderProfitReport";
import { type ReportRange, ReportsActiveContext } from "./reports/shared";

export function ReportsPage({ active = true, initialReportTab }: { active?: boolean; initialReportTab?: "commission" | "my-earnings" }) {
  const [myEarnings, setMyEarnings] = useState(initialReportTab === "my-earnings");
  const [activeTab, setActiveTab] = useState(initialReportTab === "commission" || myEarnings ? "r3" : "r1");
  // 报表视图统计周期：提升到父级，避免切换 Tab（非挂载）后筛选条件丢失。
  const [reportFrom, setReportFrom] = useState("");
  const [reportTo, setReportTo] = useState("");
  useEffect(() => {
    // 离开经营中心时保留个人视图，避免切换期间改请求口径；
    // 重新激活后再按 URL 入口决定是「我的收益」还是完整提成对账。
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
      </Space>
    ),
  };
  const tabItems = [
    { key: "r1", label: "库存 R1", render: () => <InventoryReport /> },
    { key: "r2", label: "月度损益 R2", render: () => <MonthlyPnl range={reportRange} /> },
    { key: "r3", label: "提成对账 R3", render: () => <Commission range={reportRange} mine={myEarnings} /> },
    { key: "r4", label: "资金报表·日报", render: () => <DailyFunds /> },
    { key: "r5", label: "业务损益 R5", render: () => <BusinessPnl range={reportRange} /> },
    { key: "profit", label: "订单利润", render: () => <OrderProfit range={reportRange} /> },
    { key: "audit", label: "审计记录", render: () => <AuditPanel /> },
  ];

  return (
    <ReportsActiveContext.Provider value={active}>
    <section className="ui-stack">
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={tabItems.map(({ render, ...item }) => ({
          ...item,
          // 隐藏 Tab 不挂载：避免首屏同时发起多组请求，也避免切换无关页面时产生状态更新。
          children: activeTab === item.key ? render() : null,
        }))}
      />
    </section>
    </ReportsActiveContext.Provider>
  );
}
