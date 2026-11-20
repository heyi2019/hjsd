/** 报表导出按钮：按当前页筛选导出该报表 CSV。 */

import { useState } from "react";
import { reportsApi } from "../../shared/api/reports.api";
import { normalizeError } from "../../shared/api/client";
import { ExportButton } from "../../shared/ui";
import { appMessage } from "../../shared/ui/appFeedback";

type ReportExportParams = {
  from?: string;
  to?: string;
  /** 分润对账专用：与 /reports/commission 列表同口径，避免「我的收益/指定员工」导出成默认全员。 */
  mine?: boolean;
  all_people?: boolean;
  user_id?: number;
};

export function ReportExportButton({ name, params }: { name: string; params?: ReportExportParams }) {
  const [exporting, setExporting] = useState(false);

  const exportCsv = async () => {
    const from = params?.from || undefined;
    const to = params?.to || undefined;
    if (from && to && from > to) {
      appMessage.error("导出开始日期不能晚于结束日期");
      return;
    }
    // 条件展开：月度损益、业务损益、订单利润等报表无视图筛选，不把 undefined 键塞进请求。
    const exportParams: ReportExportParams = {
      from,
      to,
      ...(params?.mine ? { mine: true } : {}),
      ...(params?.all_people ? { all_people: true } : {}),
      ...(params?.user_id ? { user_id: params.user_id } : {}),
    };
    setExporting(true);
    try {
      const blob = await reportsApi.exportCsv(name, exportParams);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${name}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
      appMessage.success("报表已导出");
    } catch (err) {
      appMessage.error(normalizeError(err).message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <ExportButton permission="report.export" loading={exporting} onClick={() => void exportCsv()} />
  );
}
