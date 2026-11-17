/** 经营中心：经营损益 / 分润对账 / 数据中心（RPT-01）。
 * 各报表视图拆到 ./reports/*.tsx（导出按钮在各自页内），本文件只留 Tab 壳。
 * 统计周期用合并 RangePicker（与工作室经营/资金明细同款）；URL 只带 from 时
 * 选择器显示为空但筛选仍生效（reportFrom 状态保留）。 */
import { DatePicker, Space, Tabs, Typography } from "antd";
import dayjs from "dayjs";
import { useEffect, useState } from "react";
import { DataCenterPanel } from "./DataCenterPanel";
import { currentReportPeriod, previousReportPeriod } from "./reportPeriod";
import { Commission } from "./reports/CommissionReport";
import { OrderProfit } from "./reports/OrderProfitReport";
import { OperatingPnl } from "./reports/OperatingPnlReport";
import { type ReportRange, ReportsActiveContext } from "./reports/shared";

export function ReportsPage({ onNavigate, active = true, initialReportTab, initialReportFrom, initialReportTo }: { onNavigate?: (key: string) => void; active?: boolean; initialReportTab?: "commission" | "my-earnings"; initialReportFrom?: string; initialReportTo?: string }) {
  const [myEarnings, setMyEarnings] = useState(initialReportTab === "my-earnings");
  const [activeTab, setActiveTab] = useState(initialReportTab === "commission" || myEarnings ? "r3" : "pnl");
  // 报表视图统计周期：提升到父级，避免切换 Tab（非挂载）后筛选条件丢失。
  const [reportFrom, setReportFrom] = useState(initialReportFrom ?? "");
  const [reportTo, setReportTo] = useState(initialReportTo ?? "");
  const applyReportPeriod = (period: { from: string; to: string }) => {
    setReportFrom(period.from);
    setReportTo(period.to);
  };
  useEffect(() => {
    // keep-alive 下离开经营中心时保留个人视图，避免隐藏页在切换期间改请求口径；
    // 重新激活后再按 URL 入口决定是「我的收益」还是完整分润对账。
    if (!active) return;
    setMyEarnings(initialReportTab === "my-earnings");
    setReportFrom(initialReportFrom ?? "");
    setReportTo(initialReportTo ?? "");
    if (initialReportTab === "commission" || initialReportTab === "my-earnings") setActiveTab("r3");
  }, [active, initialReportTab, initialReportFrom, initialReportTo]);
  const reportRange: ReportRange = {
    params: { from: reportFrom || undefined, to: reportTo || undefined },
    picker: (
      <Space size="small">
        <DatePicker.RangePicker
          aria-label="报表日期区间"
          placeholder={["开始日期", "结束日期"]}
          format="YYYY-MM-DD"
          size="small"
          placement="bottomLeft"
          classNames={{ popup: { root: "compact-date-range-picker" } }}
          value={reportFrom && reportTo ? [dayjs(reportFrom), dayjs(reportTo)] : null}
          onChange={(value) => {
            setReportFrom(value?.[0] ? value[0].format("YYYY-MM-DD") : "");
            setReportTo(value?.[1] ? value[1].format("YYYY-MM-DD") : "");
          }}
        />
        <Typography.Link role="button" tabIndex={0} onClick={() => applyReportPeriod(currentReportPeriod())}>本期</Typography.Link>
        <Typography.Link role="button" tabIndex={0} onClick={() => applyReportPeriod(previousReportPeriod())}>上期</Typography.Link>
      </Space>
    ),
  };
  const tabItems = [
    { key: "data-center", label: "数据中心", render: () => <DataCenterPanel onNavigate={onNavigate} range={reportRange} /> },
    { key: "profit", label: "订单利润", render: () => <OrderProfit range={reportRange} /> },
    { key: "r3", label: "分润对账", render: () => <Commission range={reportRange} mine={myEarnings} /> },
    { key: "pnl", label: "经营损益", render: () => <OperatingPnl range={reportRange} /> },
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
