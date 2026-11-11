/** 报表页底部的单报表导出按钮：按当前页筛选导出该报表 CSV（替代原顶部统一导出卡）。 */

import { useState } from "react";
import { reportsApi } from "../../shared/api/catalog";
import { normalizeError } from "../../shared/api/client";
import { PermissionButton } from "../../shared/ui";
import { appMessage } from "../../shared/ui/appFeedback";

type ReportExportParams = {
  from?: string;
  to?: string;
  /** R3 专用：与 /reports/commission 列表同口径，避免「我的收益/指定员工」导出成默认全员。 */
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
    // 条件展开：R2/R5/订单利润等报表无视图筛选，不把 undefined 键塞进请求（保持既有导出契约）。
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
      appMessage.success(`已导出 ${name}.csv`);
    } catch (err) {
      appMessage.error(normalizeError(err).message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <PermissionButton permission="report.export" loading={exporting} onClick={() => void exportCsv()}>
      导出 CSV
    </PermissionButton>
  );
}
