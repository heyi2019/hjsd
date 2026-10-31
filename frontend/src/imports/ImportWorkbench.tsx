/** 导入工作台（MIG-01）：导入 → 映射预览 → 人工指派 → 对账 → 提交 / 回滚 / 更正。
 *
 * 页面必须持续强调的红线（对应任务清单「阻断规则」）：
 * - 导入行只作参考，**不覆盖新单**
 * - 系统**不做自动匹配**，映射必须人工指派且留依据
 * - **不补造单边划转**，未裁决的只打 UNLINKED_TRANSFER 标记
 */
import { Tabs, Typography } from "antd";
import { ErrorBanner, PageHeader, StatRow } from "../shared/ui";
import { RED_LINE_DESC, type ImportWorkbenchProps } from "./ImportWorkbench.fragments";
import { useImportWorkbenchController } from "./useImportWorkbenchController";
import { PreviewTab, ReconTab, RowsTab } from "./ImportWorkbench.tabs";
import { ImportWorkbenchOverlays } from "./ImportWorkbench.overlays";

export function ImportWorkbench({
  embedded = false,
  batchId: batchIdProp,
  onBatchIdChange,
}: ImportWorkbenchProps) {
  const controller = useImportWorkbenchController({ batchId: batchIdProp, onBatchIdChange });
  const {
    current,
    error,
    headerActions,
    loading,
    preview,
    report,
    rowColumns,
    rows,
  } = controller;

  return (
    <section className="ui-stack">
      {embedded ? (
        <>
          <Typography.Paragraph type="secondary">{RED_LINE_DESC}</Typography.Paragraph>
          {headerActions}
        </>
      ) : (
        <PageHeader title="导入工作台" description={RED_LINE_DESC} actions={headerActions} />
      )}

      <ErrorBanner error={error} />

      {current ? (
        <StatRow
          items={[
            { label: "源行数", kind: "count", amount: String(current.row_count) },
            { label: "未映射", kind: "count", amount: String(current.unmapped_count) },
            { label: "空值单元格", kind: "count", amount: String(preview?.abnormal.empty_value ?? 0) },
            {
              label: "待裁决",
              kind: "count",
              amount: String(report?.rows.unlinked_transfer ?? 0),
              tone: report?.requires_adjudication ? "warn" : "plain",
            },
          ]}
        />
      ) : null}

      <Tabs
        defaultActiveKey="rows"
        items={[
          {
            key: "rows",
            label: "原始行与指派",
            children: <RowsTab columns={rowColumns} rows={rows} loading={loading} />,
          },
          {
            key: "preview",
            label: "映射预览",
            children: <PreviewTab preview={preview} />,
          },
          {
            key: "recon",
            label: "导入对账",
            children: <ReconTab report={report} />,
          },
        ]}
      />

      <ImportWorkbenchOverlays controller={controller} />

    </section>
  );
}
