/** 历史迁移工作台（MIG-01）：导入 → 映射预览 → 人工指派 → 对账 → 提交 / 回滚 / 更正。
 *
 * 页面必须持续强调的红线（对应任务清单「阻断规则」）：
 * - 历史行只作参考，**不覆盖新单**
 * - 系统**不做自动匹配**，映射必须人工指派且留依据
 * - **不补造历史单边划转**，未裁决的只打 UNLINKED_TRANSFER 标记
 */
import { Card, Select, Space, Tabs, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import {
  historyApi,
  type ImportBatch,
  type ImportRow,
  type MappingPreview,
  type ReconciliationReport,
} from "../shared/api/catalog";
import { errorMessage } from "../shared/api/client";
import {
  DataTable,
  ErrorBanner,
  FormDrawer,
  MoneyText,
  PageHeader,
  PermissionButton,
  StatCard,
  StatRow,
  StatusTag,
} from "../shared/ui";

export function HistoryWorkbench() {
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [batchId, setBatchId] = useState<number | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [preview, setPreview] = useState<MappingPreview | null>(null);
  const [report, setReport] = useState<ReconciliationReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [mapTarget, setMapTarget] = useState<ImportRow | null>(null);
  const [unlinkedTarget, setUnlinkedTarget] = useState<ImportRow | null>(null);
  const [skipTarget, setSkipTarget] = useState<ImportRow | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<ImportBatch | null>(null);

  const current = batches.find((b) => b.id === batchId) ?? null;

  const loadBatches = useCallback(async () => {
    try {
      const data = await historyApi.batches();
      setBatches(data.items);
      setBatchId((prev) => prev ?? data.items[0]?.id ?? null);
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, []);

  useEffect(() => {
    void loadBatches();
  }, [loadBatches]);

  const loadDetail = useCallback(async () => {
    if (batchId === null) {
      setRows([]);
      setPreview(null);
      setReport(null);
      return;
    }
    setLoading(true);
    try {
      const [rowData, previewData, reportData] = await Promise.all([
        historyApi.rows(batchId),
        historyApi.preview(batchId),
        historyApi.reconciliation(batchId),
      ]);
      setRows(rowData.items);
      setPreview(previewData);
      setReport(reportData);
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, [batchId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const refreshAll = useCallback(async () => {
    await loadBatches();
    await loadDetail();
  }, [loadBatches, loadDetail]);

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setActing(true);
      setError(null);
      try {
        await fn();
        await refreshAll();
      } catch (err) {
        setError(normalizeError(err));
      } finally {
        setActing(false);
      }
    },
    [refreshAll],
  );

  const canRollback =
    current !== null && ["DRAFT", "MAPPED"].includes(current.status);

  const rowColumns: ColumnsType<ImportRow> = [
    { title: "行号", dataIndex: "row_no", width: 70 },
    {
      title: "原始内容",
      dataIndex: "raw",
      render: (raw: Record<string, unknown>) => (
        <span className="muted">
          {Object.entries(raw)
            .slice(0, 3)
            .map(([key, value]) => `${key}=${String(value).slice(0, 18)}`)
            .join(" · ")}
        </span>
      ),
    },
    { title: "状态", dataIndex: "status", width: 130, render: (v: string) => <StatusTag status={v} /> },
    {
      title: "单边划转",
      dataIndex: "unlinked_transfer",
      width: 100,
      render: (v: boolean) => (v ? <StatusTag status="OVERDUE" label="未裁决" /> : "-"),
    },
    { title: "补录依据", dataIndex: "mapping_basis", width: 140 },
    { title: "补录人", dataIndex: "mapped_by", width: 100 },
    {
      title: "操作",
      width: 220,
      render: (_v, row) => (
        <Space size="small" wrap>
          <PermissionButton
            permission="history.import"
            size="small"
            disabled={row.status === "ROLLED_BACK"}
            onClick={() => setMapTarget(row)}
          >
            指派
          </PermissionButton>
          <PermissionButton
            permission="history.import"
            size="small"
            disabled={row.unlinked_transfer || row.status === "ROLLED_BACK"}
            onClick={() => setUnlinkedTarget(row)}
          >
            标单边划转
          </PermissionButton>
          <PermissionButton
            permission="history.import"
            size="small"
            danger
            disabled={row.status === "ROLLED_BACK"}
            onClick={() => setSkipTarget(row)}
          >
            跳过
          </PermissionButton>
        </Space>
      ),
    },
  ];

  return (
    <section className="ui-stack">
      <PageHeader
        title="历史迁移工作台"
        description="历史数据仅作参考与回归样本：不覆盖新单、不自动匹配、不补造历史划转。"
        actions={
          <Space className="ui-filter-bar">
            <Select
              style={{ width: 280 }}
              value={batchId ?? undefined}
              placeholder="选择导入批次"
              options={batches.map((b) => ({
                value: b.id,
                label: `${b.batch_no} · ${b.source_name}（${b.status}）`,
              }))}
              onChange={setBatchId}
            />
            <PermissionButton
              permission="history.import"
              type="primary"
              loading={acting}
              disabled={!canRollback}
              onClick={() => current && act(() => historyApi.commit(current.id))}
            >
              确认批次
            </PermissionButton>
            <PermissionButton
              permission="history.import"
              danger
              disabled={!canRollback}
              onClick={() => current && setRollbackTarget(current)}
            >
              回滚
            </PermissionButton>
          </Space>
        }
      />

      <ErrorBanner message={error?.message} code={error?.code} />

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
            children: (
              <Card className="glass" title="历史原始行">
                <Typography.Paragraph type="secondary">
                  映射只能人工指派且必须留依据；系统不提供任何候选推断。
                </Typography.Paragraph>
                <DataTable<ImportRow>
                  columns={rowColumns}
                  rows={rows}
                  loading={loading}
                  page={1}
                  pageSize={Math.max(rows.length, 10)}
                  total={rows.length}
                  emptyText="该批次暂无行"
                  onPageChange={() => undefined}
                />
              </Card>
            ),
          },
          {
            key: "preview",
            label: "映射预览",
            children: (
              <Card className="glass" title="字段映射预览">
                <Typography.Paragraph type="secondary">
                  预览只提供建议，不落库、不自动指派；未识别的核心列会阻断确认。
                </Typography.Paragraph>
                {preview ? (
                  <>
                    {preview.blockers.length ? (
                      <ErrorBanner
                        message={`以下源列未识别，阻断确认：${preview.blockers.join("、")}`}
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
            ),
          },
          {
            key: "recon",
            label: "迁移对账",
            children: (
              <Card className="glass" title="迁移前后对账报告">
                <Typography.Paragraph type="secondary">
                  {report?.funds.note ??
                    "历史导入不写任何现金流，池余额/损益/权益迁移前后必须一致。"}
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
                          title: "迁移前",
                          dataIndex: "before",
                          align: "right",
                          render: (v: Record<string, string>, row) => (
                            <MoneyText value={row.before} />
                          ),
                        },
                        {
                          title: "迁移后",
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
                      <ErrorBanner message="存在未映射、未裁决或未平项：差异须裁决后方可上线。" />
                    ) : null}
                  </>
                ) : (
                  <Typography.Text type="secondary">请选择批次</Typography.Text>
                )}
              </Card>
            ),
          },
        ]}
      />

      <FormDrawer
        open={mapTarget !== null}
        title={`人工指派 · 第 ${mapTarget?.row_no ?? ""} 行`}
        fields={[
          { name: "basis", label: "补录依据", required: true, kind: "textarea" as const, placeholder: "如：对账单 7 月第 9 行 / 客户确认记录" },
          { name: "order_id", label: "关联订单 ID（可空）", kind: "number" as const },
          { name: "account_id", label: "关联账号 ID（可空）", kind: "number" as const },
        ]}
        submitText="确认指派"
        onClose={() => setMapTarget(null)}
        onSubmit={(values) => {
          const target = mapTarget;
          if (!target) return;
          const basis = String(values.basis ?? "");
          const orderId = values.order_id === undefined || values.order_id === null ? null : Number(values.order_id);
          const accountId =
            values.account_id === undefined || values.account_id === null ? null : Number(values.account_id);
          void act(async () => {
            await historyApi.map(target.id, { order_id: orderId, account_id: accountId, basis });
            setMapTarget(null);
          });
        }}
      />

      <FormDrawer
        open={unlinkedTarget !== null}
        title={`标记单边划转 · 第 ${unlinkedTarget?.row_no ?? ""} 行`}
        fields={[{ name: "note", label: "说明", kind: "textarea" as const }]}
        submitText="确认标记"
        onClose={() => setUnlinkedTarget(null)}
        onSubmit={(values) => {
          const target = unlinkedTarget;
          if (!target) return;
          void act(async () => {
            await historyApi.markUnlinked(target.id, values.note ? String(values.note) : undefined);
            setUnlinkedTarget(null);
          });
        }}
        extra={
          <p className="ui-drawer-hint">
            标记后系统只生成异常工单，**不会**补造任何配对流水；新系统内部划转必须成对。
          </p>
        }
      />

      <FormDrawer
        open={skipTarget !== null}
        title={`跳过 · 第 ${skipTarget?.row_no ?? ""} 行`}
        fields={[{ name: "reason", label: "跳过理由", required: true, kind: "textarea" as const }]}
        submitText="确认跳过"
        onClose={() => setSkipTarget(null)}
        onSubmit={(values) => {
          const target = skipTarget;
          if (!target) return;
          void act(async () => {
            await historyApi.skip(target.id, String(values.reason ?? ""));
            setSkipTarget(null);
          });
        }}
      />

      <FormDrawer
        open={rollbackTarget !== null}
        title={`回滚批次 · ${rollbackTarget?.batch_no ?? ""}`}
        fields={[{ name: "reason", label: "回滚理由", required: true, kind: "textarea" as const }]}
        submitText="确认回滚"
        onClose={() => setRollbackTarget(null)}
        onSubmit={(values) => {
          const target = rollbackTarget;
          if (!target) return;
          void act(async () => {
            await historyApi.rollback(target.id, String(values.reason ?? ""));
            setRollbackTarget(null);
          });
        }}
        extra={
          <p className="ui-drawer-hint">
            回滚是逻辑操作：原始行与审计日志全部保留，不删除任何数据。
          </p>
        }
      />
    </section>
  );
}

function normalizeError(err: unknown): { message: string; code?: string } {
  const detail = (err as { response?: { data?: { detail?: { message?: string; code?: string } } } })
    ?.response?.data?.detail;
  if (detail?.message) return { message: detail.message, code: detail.code };
  return { message: errorMessage(err) };
}
