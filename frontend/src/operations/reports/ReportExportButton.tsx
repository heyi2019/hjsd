/** 报表导出按钮：按当前页筛选导出该报表 CSV。 */

import { useState } from "react";
import { reportsApi, type ReportExportParams } from "../../shared/api/reports.api";
import { normalizeError } from "../../shared/api/client";
import { downloadBlob } from "../../shared/api/download";
import { ExportButton } from "../../shared/ui";
import { appMessage } from "../../shared/ui/appFeedback";

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
      ...(params?.sort_desc !== undefined ? { sort_desc: params.sort_desc } : {}),
    };
    setExporting(true);
    try {
      const blob = await reportsApi.exportCsv(name, exportParams);
      downloadBlob(blob, `${name}.csv`);
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
