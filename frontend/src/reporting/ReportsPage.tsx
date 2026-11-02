/** 经营中心：库存 R1 / 月度损益 R2 / 提成对账 R3 / 资金日报 R4 / 业务损益 R5 / 数据中心（RPT-01）。
 * 各报表视图拆到 ./reports/*.tsx，本文件只留 Tab 壳与批量导出。 */
import { Card, Input, Space, Tabs, Typography } from "antd";
import { useEffect, useState } from "react";
import { AttachmentPanel } from "../attachments/AttachmentPanel";
import { AuditPanel } from "../audit/AuditPanel";
import { NotificationsPanel } from "../notifications/NotificationsPanel";
import { QualityPanel } from "../quality/QualityPanel";
import { SearchPanel } from "../search/SearchPanel";
import { reportsApi } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { useOptionSet } from "../shared/lib/optionSets";
import { PermissionButton, Select } from "../shared/ui";
import { appMessage } from "../shared/ui/appFeedback";
import { DataCenterPanel } from "./DataCenterPanel";
import { BusinessPnl } from "./reports/BusinessPnlReport";
import { Commission } from "./reports/CommissionReport";
import { DailyFunds } from "./reports/DailyFundsReport";
import { FinanceDimensions } from "./reports/FinanceDimensionsReport";
import { InventoryReport } from "./reports/InventoryReport";
import { MonthlyPnl } from "./reports/MonthlyPnlReport";
import { OrderProfit } from "./reports/OrderProfitReport";
import { type ReportRange, ReportsActiveContext } from "./reports/shared";

const REPORT_NAMES = [
  "inventory-health",
  "monthly-pnl",
  "commission",
  "daily-funds",
  "business-pnl",
  "finance-dimensions",
  "order-profit",
];

const REPORT_LABEL: Record<string, string> = {
  "inventory-health": "库存健康",
  "monthly-pnl": "月度损益",
  commission: "提成对账",
  "daily-funds": "资金日报",
  "business-pnl": "业务损益",
  "finance-dimensions": "资金属性",
  "order-profit": "订单利润",
};

/** 词典未加载时的回落值：顺序与 REPORT_NAMES 一致，保证与改造前零行为变化。 */
const REPORT_FALLBACK = REPORT_NAMES.map((name) => ({ value: name, label: REPORT_LABEL[name] }));

export function ReportsPage({ onNavigate, active = true, initialReportTab }: { onNavigate?: (key: string) => void; active?: boolean; initialReportTab?: "commission" | "my-earnings" }) {
  const reportOptions = useOptionSet("REPORT_NAME") ?? REPORT_FALLBACK;
  const [myEarnings, setMyEarnings] = useState(initialReportTab === "my-earnings");
  const [activeTab, setActiveTab] = useState(initialReportTab === "commission" || myEarnings ? "r3" : "r1");
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportSuccess, setExportSuccess] = useState<string | null>(null);
  const [exportFrom, setExportFrom] = useState("");
  const [exportTo, setExportTo] = useState("");
  const [selectedReports, setSelectedReports] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);
  // 报表视图统计周期：提升到父级，避免切换 Tab（非挂载）后筛选条件丢失。
  const [reportFrom, setReportFrom] = useState("");
  const [reportTo, setReportTo] = useState("");
  useEffect(() => {
    // keep-alive 下离开经营中心时保留个人视图，避免隐藏页在切换期间改请求口径；
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
  const exportSelected = async () => {
    if (selectedReports.length === 0) {
      setExportError("请至少勾选一项报表");
      setExportSuccess(null);
      return;
    }
    if (exportFrom && exportTo && exportFrom > exportTo) {
      setExportError("导出开始日期不能晚于结束日期");
      setExportSuccess(null);
      return;
    }
    setExporting(true);
    setExportError(null);
    setExportSuccess(null);
    let lastError: string | null = null;
    let successCount = 0;
    try {
      for (const name of selectedReports) {
        try {
          const blob = await reportsApi.exportCsv(name, { from: exportFrom || undefined, to: exportTo || undefined });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = `${name}.csv`;
          anchor.click();
          URL.revokeObjectURL(url);
          successCount += 1;
        } catch (err) {
          lastError = normalizeError(err).message;
        }
      }
    } finally {
      setExporting(false);
    }
    if (lastError) {
      setExportError(lastError);
    } else {
      const message = `已导出 ${successCount} 份报表`;
      setExportSuccess(message);
      appMessage.success(message);
    }
  };
  const tabItems = [
    { key: "r1", label: "库存 R1", render: () => <InventoryReport /> },
    { key: "r2", label: "月度损益 R2", render: () => <MonthlyPnl range={reportRange} /> },
    { key: "r3", label: "提成对账 R3", render: () => <Commission range={reportRange} mine={myEarnings} /> },
    { key: "r4", label: "资金日报 R4", render: () => <DailyFunds /> },
    { key: "r5", label: "业务损益 R5", render: () => <BusinessPnl range={reportRange} /> },
    { key: "finance-dimensions", label: "资金属性分析", render: () => <FinanceDimensions range={reportRange} /> },
    { key: "profit", label: "订单利润", render: () => <OrderProfit range={reportRange} /> },
    { key: "data-center", label: "数据中心", render: () => <DataCenterPanel onNavigate={onNavigate} /> },
    { key: "quality", label: "质量中心", render: () => <QualityPanel /> },
    { key: "notifications", label: "系统提醒", render: () => <NotificationsPanel /> },
    { key: "search", label: "全局搜索", render: () => <SearchPanel /> },
    { key: "audit", label: "审计记录", render: () => <AuditPanel /> },
    { key: "attachments", label: "附件中心", render: () => <AttachmentPanel /> },
  ];

  return (
    <ReportsActiveContext.Provider value={active}>
    <section className="ui-stack">
      <Card className="glass" title="报表导出">
        <div className="ui-filter-bar">
          <Space size="small" className="ui-filter-bar__range">
            <Input type="date" value={exportFrom} onChange={(event) => setExportFrom(event.target.value)} aria-label="导出开始日期" className="ui-control-width-date" />
            <span className="muted">至</span>
            <Input type="date" value={exportTo} onChange={(event) => setExportTo(event.target.value)} aria-label="导出结束日期" className="ui-control-width-date" />
          </Space>
          <Select
            mode="multiple"
            allowClear
            virtual={false}
            placeholder="选择导出报表"
            value={selectedReports}
            onChange={setSelectedReports}
            options={reportOptions}
            className="ui-control-width-import"
            maxTagCount="responsive"
          />
          <PermissionButton permission="report.export" loading={exporting} onClick={() => void exportSelected()}>
            导出
          </PermissionButton>
        </div>
        <Typography.Text type="secondary">
          导出列与「设置 → 列表字段」一致：被隐藏的列不导出，表头与枚举值均为中文（取自选项词典）；合计行独有字段仍保留在末尾。
        </Typography.Text>
        {exportError ? <Typography.Text type="danger">{exportError}</Typography.Text> : null}
        {exportSuccess ? <Typography.Text type="success">{exportSuccess}</Typography.Text> : null}
      </Card>
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
