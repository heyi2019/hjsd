import { Card, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { ImportRow, MappingPreview, ReconciliationReport } from "../shared/api/types/imports";
import { DataTable, ErrorBanner, MoneyText, StatCard } from "../shared/ui";

/** 原始行与人工指派。 */
export function RowsTab({ columns, rows, loading }: {
  columns: ColumnsType<ImportRow>;
  rows: ImportRow[];
  loading: boolean;
}) {
  return (
              <Card className="glass" title="导入原始行">
                <Typography.Paragraph type="secondary">
                  映射只能人工指派且必须留依据；系统不提供任何候选推断。
                </Typography.Paragraph>
                <DataTable<ImportRow>
                  columns={columns}
                  rows={rows}
                  loading={loading}
                  page={1}
                  pageSize={20}
                  total={rows.length}
                  emptyText="该批次暂无行"
                  onPageChange={() => undefined}
               />
              </Card>
  );
}

/** 字段映射预览（只给建议，不落库）。 */
export function PreviewTab({ preview }: { preview: MappingPreview | null }) {
  return (
              <Card className="glass" title="字段映射预览">
                <Typography.Paragraph type="secondary">
                  预览只提供建议，不落库、不自动指派；未识别的核心列会阻断确认。
                </Typography.Paragraph>
                {preview ? (
                  <>
                    {preview.blockers.length ? (
                      <ErrorBanner
                        error={{ message: `以下源列未识别，阻断确认：${preview.blockers.join("、")}` }}
                      />
                    ) : null}
                    <DataTable
                      columns={[
                        { title: "源列", dataIndex: "source_column", width: 160 },
                        {
                          title: "建议目标字段",
                          dataIndex: "target_field",
                          width: 160,
                          render: (v?: string | null) => v ?? "未识别",
                        },
                        { title: "出现行数", dataIndex: "present_count", align: "right", width: 100 },
                        { title: "非空数", dataIndex: "filled_count", align: "right", width: 100 },
                        {
                          title: "填充率",
                          dataIndex: "fill_rate",
                          align: "right",
                          width: 100,
                          render: (v: number) => `${v}%`,
                        },
                        { title: "样例", dataIndex: "samples" },
                      ]}
                      rows={preview.columns}
                      page={1}
                      pageSize={Math.max(preview.columns.length, 10)}
                      total={preview.columns.length}
                      onPageChange={() => undefined}
                    />
                  </>
                ) : (
                  <Typography.Text type="secondary">请选择批次</Typography.Text>
                )}
              </Card>
  );
}

/** 导入前后对账报告。 */
export function ReconTab({ report }: { report: ReconciliationReport | null }) {
  return (
              <Card className="glass" title="导入前后对账报告">
                <Typography.Paragraph type="secondary">
                  {report?.funds.note ??
                    "导入不写任何现金流，池余额/损益/权益导入前后必须一致。"}
                </Typography.Paragraph>
                {report ? (
                  <>
                    <div className="ui-stat-row">
                      <StatCard label="源总行" value={String(report.rows.source_total)} />
                      <StatCard label="已导入" value={String(report.rows.imported)} />
                      <StatCard label="未映射" value={String(report.rows.unmapped)} />
                      <StatCard label="已跳过" value={String(report.rows.skipped)} />
                      <StatCard
                        label="未裁决划转"
                        value={String(report.rows.unlinked_transfer)}
                        tone={report.rows.unlinked_transfer ? "warn" : "plain"}
                      />
                      <StatCard
                        label="未平项"
                        value={String(report.rows.unaccounted)}
                        tone={report.rows.unaccounted ? "warn" : "plain"}
                      />
                    </div>
                    <DataTable
                      columns={[
                        { title: "金额项", dataIndex: "key", width: 160 },
                        {
                          title: "导入前",
                          dataIndex: "before",
                          align: "right",
                          render: (_v: Record<string, string>, row) => (
                            <MoneyText value={row.before} />
                          ),
                        },
                        {
                          title: "导入后",
                          dataIndex: "after",
                          align: "right",
                          render: (_v: unknown, row) => <MoneyText value={row.after} />,
                        },
                        {
                          title: "差异",
                          dataIndex: "delta",
                          align: "right",
                          render: (_v: unknown, row) => (
                            <MoneyText value={row.delta} tone="auto" strong />
                          ),
                        },
                      ]}
                      rows={Object.keys(report.amounts.before).map((key) => ({
                        key,
                        before: report.amounts.before[key],
                        after: report.amounts.after[key] ?? "0.00",
                        delta: report.amounts.delta[key] ?? "0.00",
                      }))}
                      page={1}
                      pageSize={Math.max(Object.keys(report.amounts.before).length, 10)}
                      total={Object.keys(report.amounts.before).length}
                      onPageChange={() => undefined}
                      rowKey="key"
                   />
                    {report.requires_adjudication ? (
                      <ErrorBanner error={{ message: "存在未映射、未裁决或未平项：差异须裁决后方可上线。" }} />
                    ) : null}
                  </>
                ) : (
                  <Typography.Text type="secondary">请选择批次</Typography.Text>
                )}
              </Card>
  );
}
