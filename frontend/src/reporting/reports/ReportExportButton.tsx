/** 报表页底部的单报表导出按钮：按当前页筛选导出该报表 CSV（替代原顶部统一导出卡）。 */

import { useState } from "react";
import { reportsApi } from "../../shared/api/catalog";
import { normalizeError } from "../../shared/api/client";
import { PermissionButton } from "../../shared/ui";
import { appMessage } from "../../shared/ui/appFeedback";

export function ReportExportButton({ name, params }: { name: string; params?: { from?: string; to?: string } }) {
  const [exporting, setExporting] = useState(false);

  const exportCsv = async () => {
    const from = params?.from || undefined;
    const to = params?.to || undefined;
    if (from && to && from > to) {
      appMessage.error("导出开始日期不能晚于结束日期");
      return;
    }
    setExporting(true);
    try {
      const blob = await reportsApi.exportCsv(name, { from, to });
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
