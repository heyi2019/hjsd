import { appMessage, appModal } from "../shared/ui/appFeedback";
/** 导入工作台（MIG-01）：导入 → 映射预览 → 人工指派 → 对账 → 提交 / 回滚 / 更正。
 *
 * 页面必须持续强调的红线（对应任务清单「阻断规则」）：
 * - 导入行只作参考，**不覆盖新单**
 * - 系统**不做自动匹配**，映射必须人工指派且留依据
 * - **不补造单边划转**，未裁决的只打 UNLINKED_TRANSFER 标记
 */
import { Card, Form, Input, Modal, Select, Space, Tabs, Typography, Upload } from "antd";
import type { UploadFile } from "antd/es/upload/interface";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import {
  importsApi,
  type ImportBatch,
  type ImportRow,
  type MappingPreview,
  type ReconciliationReport,
} from "../shared/api/catalog";
import { errorMessage, normalizeError } from "../shared/api/client";
import {
  ConfirmButton,
  DataTable,
  ErrorBanner,
  FormDrawer,
  InlineError,
  MoneyText,
  PageHeader,
  PermissionButton,
  StatCard,
  StatRow,
  StatusTag,
} from "../shared/ui";
import { configurableLabel, useOptionSet } from "../shared/lib/optionSets";

/** 嵌入模式：作为「设置」页内的 Tab 渲染时，不再重复输出 PageHeader 大标题，
 *  红线说明降级为次要文本，批次选择与确认/回滚动作保留为筛选条。 */
const RED_LINE_DESC = "导入数据只保留原文与人工映射：不覆盖新单、不自动匹配、不补造单边划转。";

function parseImportText(text: string, filename: string): Record<string, unknown>[] {
  if (filename.toLowerCase().endsWith(".json")) {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.some((row) => row === null || typeof row !== "object" || Array.isArray(row))) {
      throw new Error("JSON 文件必须是对象数组");
    }
    return parsed as Record<string, unknown>[];
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error("CSV 文件至少需要一行表头和一行数据");
  const headers = lines[0].split(",").map((item) => item.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    return Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ""]));
  });
}

const IMPORT_TEMPLATES: Record<string, { filename: string; content: string }> = {
  STANDARD_ORDER: {
    filename: "订单导入模板.csv",
    content: "订单日期,订单类型,订单金额,本金,利润,经办人,备注\n2026-01-31,HS,0.00,0.00,0.00,,",
  },
  STANDARD_ACCOUNT: {
    filename: "账号导入模板.csv",
    content: "库存编号,平台,区服,状态,买入日期,买入成本,预计售价,备注\n,, ,IN_STOCK,2026-01-31,0.00,0.00,",
  },
  STANDARD_CASHFLOW: {
    filename: "资金流水导入模板.csv",
    content: "发生日期,金额,收支方向,资金池,业务类型,订单号,说明\n2026-01-31,0.00,IN,,HS,,",
  },
  STANDARD_INSTALLMENT: {
    filename: "分期导入模板.csv",
    content: "合同日期,合同类型,本金,首付,期数,每期金额,已收金额,状态,备注\n2026-01-31,ADVANCE_PURCHASE,0.00,0.00,1,0.00,0.00,PENDING,",
  },
  STANDARD_LEAD: {
    filename: "需求导入模板.csv",
    content: "客户ID,需求类型,预算,需求内容,负责人ID,备注\n1,FIND_ACCOUNT,0.00,求购指定账号,,",
  },
};

function downloadImportTemplate(sourceKind: string) {
  const template = IMPORT_TEMPLATES[sourceKind] ?? IMPORT_TEMPLATES.STANDARD_ORDER;
  const blob = new Blob([`\uFEFF${template.content}\n`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = template.filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ImportWorkbench({
  embedded = false,
  batchId: batchIdProp,
  onBatchIdChange,
}: {
  embedded?: boolean;
  /** 受控批次选择：由父级（如 SettingsPage）持有，避免 Tab 非挂载时丢失筛选。 */
  batchId?: number | null;
  onBatchIdChange?: (id: number | null) => void;
}) {
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const sourceKindOptions = useOptionSet("IMPORT_SOURCE_KIND") ?? [];
  const batchStatusOptions = useOptionSet("IMPORT_BATCH_STATUS") ?? [];
  const isBatchControlled = batchIdProp !== undefined;
  const [internalBatchId, setInternalBatchId] = useState<number | null>(null);
  const batchId = isBatchControlled ? (batchIdProp as number | null) : internalBatchId;
  const setBatchId = useCallback(
    (value: number | null) => {
      const next = value ?? null;
      if (!isBatchControlled) setInternalBatchId(next);
      onBatchIdChange?.(next);
    },
    [isBatchControlled, onBatchIdChange],
  );
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
  const [rejectTarget, setRejectTarget] = useState<ImportBatch | null>(null);
  const [correctionTarget, setCorrectionTarget] = useState<ImportBatch | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<UploadFile | null>(null);
  const [importing, setImporting] = useState(false);
  const [importForm] = Form.useForm();

  const current = batches.find((b) => b.id === batchId) ?? null;

  const loadBatches = useCallback(async () => {
    try {
      const data = await importsApi.batches();
      setBatches(data.items);
      if (batchId === null) setBatchId(data.items[0]?.id ?? null);
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
        importsApi.rows(batchId),
        importsApi.preview(batchId),
        importsApi.reconciliation(batchId),
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
  // 已确认批次禁止回滚，只能以更正批次分层保存（MIG-01-08）。
  const canCorrect = current !== null && current.status === "COMMITTED";
  // 驳回仅对未确认批次开放，且为终态：已确认批次只能回滚 / 更正。
  const canReject = canRollback;

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
    { title: "行状态", dataIndex: "status", width: 130, render: (v: string) => <StatusTag status={v} optionSet="IMPORT_ROW_STATUS" /> },
    {
      title: "单边划转",
      className: "ui-col-md-up",
      onCell: () => ({ className: "ui-col-md-up" }),
      dataIndex: "unlinked_transfer",
      width: 100,
      render: (v: boolean) => (v ? <StatusTag status="OVERDUE" label="未裁决" /> : "-"),
    },
    { title: "补录依据", dataIndex: "mapping_basis", width: 140, className: "ui-col-md-up", onCell: () => ({ className: "ui-col-md-up" }) },
    { title: "补录人", dataIndex: "mapped_by", width: 100, className: "ui-col-md-up", onCell: () => ({ className: "ui-col-md-up" }) },
    {
      title: "操作",
      width: 220,
      render: (_v, row) => (
        <Space size={2} wrap>
          <PermissionButton
            permission="import.manage"
            size="small"
            disabled={row.status === "ROLLED_BACK"}
            onClick={() => setMapTarget(row)}
          >
            指派
          </PermissionButton>
          <PermissionButton
            permission="import.manage"
            size="small"
            disabled={row.unlinked_transfer || row.status === "ROLLED_BACK"}
            onClick={() => setUnlinkedTarget(row)}
          >
            标单边划转
          </PermissionButton>
          <PermissionButton
            permission="import.manage"
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

  const headerActions = (
    <Space className="ui-filter-bar">
      <PermissionButton
        permission="import.manage"
        type="primary"
        onClick={() => setImportOpen(true)}
      >
        新建导入
      </PermissionButton>
      <Select
        className="ui-control-width-import"
        value={batchId ?? undefined}
        placeholder="选择导入批次"
        options={batches.map((b) => ({
          value: b.id,
          label: `${b.source_name}（${b.batch_no} · ${batchStatusOptions.find((o) => o.value === b.status)?.label ?? b.status}）`,
        }))}
        onChange={setBatchId}
      />
      <ConfirmButton
        permission="import.manage"
        type="primary"
        danger
        disabled={!canRollback}
        title="确认导入批次"
        description="确认后批次状态将变为「已确认」并锁定映射。确认前请确保所有未映射、未裁决项已处理。"
        okText="确认提交批次"
        onConfirm={async () => {
          if (!current) return;
          await importsApi.commit(current.id);
          await refreshAll();
        }}
      >
        确认批次
      </ConfirmButton>
      <PermissionButton
        permission="import.manage"
        danger
        disabled={!canRollback}
        onClick={() => current && setRollbackTarget(current)}
      >
        回滚
      </PermissionButton>
      <PermissionButton
        permission="import.manage"
        danger
        disabled={!canReject}
        onClick={() => current && setRejectTarget(current)}
      >
        驳回
      </PermissionButton>
      <PermissionButton
        permission="import.manage"
        disabled={!canCorrect}
        onClick={() => current && setCorrectionTarget(current)}
      >
        更正
      </PermissionButton>
    </Space>
  );

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
            children: (
              <Card className="glass" title="导入原始行">
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
            ),
          },
          {
            key: "recon",
            label: "导入对账",
            children: (
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
                          render: (v: Record<string, string>, row) => (
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
          { name: "account_id", label: "关联库存编号 ID（可空）", kind: "number" as const },
        ]}
        submitText="确认指派"
        submitting={acting}
        error={error}
        onClose={() => setMapTarget(null)}
        onSubmit={(values) => {
          const target = mapTarget;
          if (!target) return;
          const basis = String(values.basis ?? "");
          const orderId = values.order_id === undefined || values.order_id === null ? null : Number(values.order_id);
          const accountId =
            values.account_id === undefined || values.account_id === null ? null : Number(values.account_id);
          void act(async () => {
            await importsApi.map(target.id, { order_id: orderId, account_id: accountId, basis });
            setMapTarget(null);
          });
        }}
      />

      <Modal
        open={importOpen}
        title="导入导入数据"
        okText="开始导入"
        cancelText="取消"
        confirmLoading={importing}
        destroyOnHidden
        onCancel={() => {
          setImportOpen(false);
          setImportFile(null);
          importForm.resetFields();
        }}
        onOk={() => {
          void importForm.validateFields().then(async (values) => {
            if (!importFile?.originFileObj) {
              appMessage.error("请选择 JSON 或 CSV 文件");
              return;
            }
            setImporting(true);
            try {
              const text = await importFile.originFileObj.text();
              const rows = parseImportText(text, importFile.name);
              const created = await importsApi.createBatch({
                source_name: String(values.source_name),
                source_kind: String(values.source_kind),
                rows,
                note: values.note ? String(values.note) : undefined,
              });
              setImportOpen(false);
              setImportFile(null);
              importForm.resetFields();
              await loadBatches();
              setBatchId(created.id);
              appMessage.success(`已导入 ${rows.length} 行数据`);
            } catch (err) {
              setError(normalizeError(err));
            } finally {
              setImporting(false);
            }
          }).catch(() => undefined);
        }}
      >
        <InlineError error={error} />
        <Form form={importForm} layout="vertical">
          <Form.Item name="source_name" label="数据名称" rules={[{ required: true, message: "请输入数据名称" }]}>
            <Input placeholder="例如：2026年10月订单导入" />
          </Form.Item>
          <Form.Item name="source_kind" label="数据类型" initialValue="STANDARD_ORDER" rules={[{ required: true }]}>
            <Select options={sourceKindOptions} />
          </Form.Item>
          <PermissionButton
            permission="import.manage"
            type="link"
            className="ui-drawer-hint"
            onClick={() => downloadImportTemplate(String(importForm.getFieldValue("source_kind") ?? "STANDARD_ORDER"))}
          >
            下载当前类型导入模板
          </PermissionButton>
          <Form.Item label="数据文件" required>
            <Upload
              accept=".json,.csv"
              maxCount={1}
              beforeUpload={() => false}
              fileList={importFile ? [importFile] : []}
              onChange={({ fileList }) => setImportFile(fileList[0] ?? null)}
              onRemove={() => { setImportFile(null); return true; }}
            >
              <PermissionButton permission="import.manage">选择 JSON / CSV 文件</PermissionButton>
            </Upload>
            <Typography.Paragraph type="secondary" className="ui-drawer-hint">
              文件只会作为原始行保存，不会自动匹配、覆盖业务单或生成现金流。
            </Typography.Paragraph>
          </Form.Item>
          <Form.Item name="note" label="导入说明">
            <Input.TextArea rows={3} placeholder="可填写来源、日期范围或对账依据" />
          </Form.Item>
        </Form>
      </Modal>

      <FormDrawer
        open={unlinkedTarget !== null}
        title={`标记单边划转 · 第 ${unlinkedTarget?.row_no ?? ""} 行`}
        fields={[{ name: "note", label: "说明", kind: "textarea" as const }]}
        submitText="确认标记"
        submitting={acting}
        error={error}
        onClose={() => setUnlinkedTarget(null)}
        onSubmit={(values) => {
          const target = unlinkedTarget;
          if (!target) return;
          void act(async () => {
            await importsApi.markUnlinked(target.id, values.note ? String(values.note) : undefined);
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
        submitting={acting}
        error={error}
        onClose={() => setSkipTarget(null)}
        onSubmit={(values) => {
          const target = skipTarget;
          if (!target) return;
          void act(async () => {
            await importsApi.skip(target.id, String(values.reason ?? ""));
            setSkipTarget(null);
          });
        }}
      />

      <FormDrawer
        open={rollbackTarget !== null}
        title={`回滚批次 · ${rollbackTarget?.batch_no ?? ""}`}
        fields={[{ name: "reason", label: "回滚理由", required: true, kind: "textarea" as const }]}
        submitText="确认回滚"
        submitting={acting}
        error={error}
        onClose={() => setRollbackTarget(null)}
        onSubmit={(values) => {
          const target = rollbackTarget;
          if (!target) return;
          void act(async () => {
            await importsApi.rollback(target.id, String(values.reason ?? ""));
            setRollbackTarget(null);
          });
        }}
        extra={
          <p className="ui-drawer-hint">
            回滚是逻辑操作：原始行与审计日志全部保留，不删除任何数据。
          </p>
        }
      />

      <FormDrawer
        open={rejectTarget !== null}
        title={`驳回批次 · ${rejectTarget?.batch_no ?? ""}`}
        fields={[{ name: "reason", label: "驳回理由", required: true, kind: "textarea" as const }]}
        submitText="确认驳回"
        submitting={acting}
        error={error}
        onClose={() => setRejectTarget(null)}
        onSubmit={(values) => {
          const target = rejectTarget;
          if (!target) return;
          void act(async () => {
            await importsApi.reject(target.id, String(values.reason ?? ""));
            setRejectTarget(null);
          });
        }}
        extra={
          <p className="ui-drawer-hint">
            驳回是终态：批次不再提交，原始行与审计日志全部保留、状态不变；如需再导入请新建批次。
          </p>
        }
      />

      <FormDrawer
        open={correctionTarget !== null}
        title={`更正批次 · ${correctionTarget?.batch_no ?? ""}`}
        fields={[
          {
            name: "rows",
            label: "更正内容（JSON 行数组）",
            required: true,
            kind: "textarea" as const,
            placeholder: '[{"row_no": 3, "amount": "123.45"}, {"row_no": 7, "note": "补充说明"}]',
          },
          { name: "reason", label: "更正理由", required: true, kind: "textarea" as const },
        ]}
        submitText="提交更正批次"
        submitting={acting}
        error={error}
        onClose={() => setCorrectionTarget(null)}
        onSubmit={(values) => {
          const target = correctionTarget;
          if (!target) return;
          let rows: Record<string, unknown>[];
          try {
            rows = JSON.parse(String(values.rows ?? "[]"));
            if (!Array.isArray(rows) || rows.length === 0) {
              appMessage.error("更正内容必须是非空 JSON 数组");
              return;
            }
          } catch {
            appMessage.error("更正内容不是合法 JSON，请检查格式");
            return;
          }
          void act(async () => {
            await importsApi.createCorrection(target.id, {
              rows: rows as Record<string, unknown>[],
              reason: String(values.reason ?? ""),
            });
            setCorrectionTarget(null);
          });
        }}
        extra={
          <p className="ui-drawer-hint">
            已确认批次的原批次与原始行一律只读；更正以新批次分层保存，通过 corrects_batch_no 指回原批次，形成可追溯更正链。
          </p>
        }
      />
    </section>
  );
}

