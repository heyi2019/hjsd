import { appMessage } from "../shared/ui/appFeedback";
/** 质量中心：异常摘要、工单处理与关闭（QLT-01）。 */
import { Card, Form, Input, Space, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { qualityApi, type QualityIssue, type QualityMetricRow, type QualityMetricValue, type QualityMetrics, type QualitySummary } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { BusinessActionModal, CompactActions, BusinessForm, DataTable, ErrorBanner, InlineError, PermissionButton, Select, StatRow, StatusTag } from "../shared/ui";
import { configurableLabel, useOptionSet } from "../shared/lib/optionSets";
import { useListViewColumns } from "../shared/lib/listColumns";

const QUALITY_STATUS_LABEL: Record<string, string> = { OPEN: "待处理", IN_PROGRESS: "处理中", CLOSED: "已关闭" };

/** 指标窗口：只向后端要区间，月份分组与分子分母一律由后端给口径。 */
const METRIC_WINDOWS = [
  { value: 3, label: "近 3 个月" },
  { value: 6, label: "近 6 个月" },
  { value: 12, label: "近 12 个月" },
];

function monthRange(months: number): { from: string; to: string } {
  const now = new Date();
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return {
    from: fmt(new Date(now.getFullYear(), now.getMonth() - (months - 1), 1)),
    to: fmt(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
  };
}

/** rate 为 null = 分母为 0，显示占位而不是 0%（0% 会被误读成「做得很差」）。 */
function metricText(value: QualityMetricValue | undefined): string {
  if (!value || value.rate === null || value.rate === undefined) return "—";
  return `${value.rate.toFixed(2)}%`;
}

function metricHint(value: QualityMetricValue | undefined, formula?: string): string {
  const parts: string[] = [];
  if (formula) parts.push(`口径：${formula}`);
  if (value && value.denominator !== null) parts.push(`样本：${value.numerator ?? 0}/${value.denominator}`);
  return parts.join("；") || "无口径说明";
}

function renderMetric(value: QualityMetricValue | undefined, formula?: string) {
  return <Tooltip title={metricHint(value, formula)}><span>{metricText(value)}</span></Tooltip>;
}

export function QualityPanel() {
  const severityOptions = useOptionSet("QUALITY_SEVERITY") ?? [];
  const [summary, setSummary] = useState<QualitySummary | null>(null);
  const [summaryReady, setSummaryReady] = useState(false);
  const [metrics, setMetrics] = useState<QualityMetrics | null>(null);
  const [metricWindow, setMetricWindow] = useState(6);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [rows, setRows] = useState<QualityIssue[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [closeTarget, setCloseTarget] = useState<QualityIssue | null>(null);
  const [batchCloseOpen, setBatchCloseOpen] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [createForm] = Form.useForm();
  const [closeForm] = Form.useForm();
  const [batchCloseForm] = Form.useForm();
  const [creating, setCreating] = useState(false);
  const [closing, setClosing] = useState(false);
  const [batchClosing, setBatchClosing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [updating, setUpdating] = useState(false);

  const load = useCallback(async () => {
    setSummaryReady(false);
    try {
      const [nextSummary, nextRows] = await Promise.all([qualityApi.summary(), qualityApi.list()]);
      setSummary(nextSummary);
      setRows(nextRows.items);
      setError(null);
      setSummaryReady(true);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** 指标独立取数：失败只让本卡片留空，不拖垮工单列表（两者口径与权限门槛不同）。 */
  const loadMetrics = useCallback(async () => {
    setMetricsLoading(true);
    try {
      setMetrics(await qualityApi.metrics(monthRange(metricWindow)));
    } catch {
      setMetrics(null);
    } finally {
      setMetricsLoading(false);
    }
  }, [metricWindow]);

  useEffect(() => { void loadMetrics(); }, [loadMetrics]);

  const createIssue = async (values: Record<string, unknown>) => {
    setCreating(true);
    try {
      await qualityApi.create({
        code: values.code as string,
        severity: values.severity as string,
        title: values.title as string,
        entity_type: values.entity_type as string,
        entity_id: values.entity_id as string,
        message: values.message as string,
      });
      appMessage.success("质量工单已创建");
      setCreateOpen(false);
      createForm.resetFields();
      await load();
    } catch (err) { setError(normalizeError(err)); }
    finally { setCreating(false); }
  };

  const closeIssue = async (values: Record<string, unknown>) => {
    if (!closeTarget) return;
    setClosing(true);
    try {
      await qualityApi.close(closeTarget.id, { resolution: values.resolution as string, evidence: values.evidence as string });
      appMessage.success("质量工单已关闭");
      setCloseTarget(null);
      closeForm.resetFields();
      await load();
    } catch (err) { setError(normalizeError(err)); }
    finally { setClosing(false); }
  };

  const batchCloseIssues = async (values: Record<string, unknown>) => {
    const openIds = rows.filter((row) => row.status !== "CLOSED").map((row) => row.id);
    const ids = openIds.slice(0, 50);
    const capped = openIds.length > ids.length;
    if (!ids.length) { appMessage.info("暂无可批量关闭的工单"); return; }
    setBatchClosing(true);
    try {
      await qualityApi.batchClose({ issue_ids: ids, resolution: values.resolution as string, evidence: values.evidence as string });
      appMessage.success(`已批量关闭 ${ids.length} 个未关闭工单${capped ? "（仅处理前 50 条，剩余请再次操作）" : ""}`);
      setBatchCloseOpen(false);
      batchCloseForm.resetFields();
      await load();
    } catch (err) {
      const normalized = normalizeError(err);
      setError(normalized);
      appMessage.error(`批量关闭失败：${normalized.message}`);
    }
    finally { setBatchClosing(false); }
  };

  const updateIssueStatus = async (row: QualityIssue, status: "IN_PROGRESS") => {
    setUpdating(true);
    try {
      await qualityApi.update(row.id, { status });
      appMessage.success("工单已进入处理中");
      await load();
    } catch (err) { setError(normalizeError(err)); }
    finally { setUpdating(false); }
  };

  const scanIssues = async () => {
    setScanning(true);
    try {
      const created = await qualityApi.scan();
      appMessage.success(created.length > 0 ? `扫描发现 ${created.length} 个新异常，已生成工单` : "扫描完成，未发现新异常");
      await load();
    } catch (err) { setError(normalizeError(err)); }
    finally { setScanning(false); }
  };

  const metricDefinitions = metrics?.definitions ?? {};
  const { arrange: arrangeMetricColumns } = useListViewColumns("QUALITY_METRIC");
  const metricColumns: ColumnsType<QualityMetricRow> = [
    { title: "月份", dataIndex: "month" },
    {
      title: metricDefinitions.reconciliation_completion_rate?.label ?? "对账完成率",
      key: "reconciliation_completion_rate",
      render: (_v, row) =>
        renderMetric(row.reconciliation_completion_rate, metricDefinitions.reconciliation_completion_rate?.formula),
    },
    {
      title: metricDefinitions.overdue_rate?.label ?? "分期逾期率",
      key: "overdue_rate",
      render: (_v, row) => renderMetric(row.overdue_rate, metricDefinitions.overdue_rate?.formula),
    },
    {
      title: metricDefinitions.missing_attachment_rate?.label ?? "缺附件率",
      key: "missing_attachment_rate",
      render: (_v, row) =>
        renderMetric(row.missing_attachment_rate, metricDefinitions.missing_attachment_rate?.formula),
    },
  ];

  const { arrange: arrangeColumns } = useListViewColumns("QUALITY_ISSUE");
  const columns: ColumnsType<QualityIssue> = [
    { title: "工单号", dataIndex: "issue_no" },
    { title: "级别", dataIndex: "severity", render: (v: string) => <StatusTag status={v} optionSet="QUALITY_SEVERITY" /> },
    { title: "标题", dataIndex: "title" },
    { title: "对象", key: "target", render: (_v, row) => `${row.entity_type}:${row.entity_id}` },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} label={configurableLabel("QUALITY_STATUS", v, QUALITY_STATUS_LABEL)} /> },
    { title: "问题", dataIndex: "message" },
    {
      title: "操作",
      key: "actions",
      render: (_v, row) => row.status === "OPEN" ? (
        <Space size={2}>
          <PermissionButton permission="order.update" size="small" loading={updating} onClick={() => void updateIssueStatus(row, "IN_PROGRESS")}>开始处理</PermissionButton>
          <PermissionButton permission="order.update" size="small" onClick={() => setCloseTarget(row)}>关闭</PermissionButton>
        </Space>
      ) : row.status === "IN_PROGRESS" ? (
        <PermissionButton permission="order.update" size="small" onClick={() => setCloseTarget(row)}>关闭</PermissionButton>
      ) : null,
    },
  ];

  return (
    <section className="ui-stack">
      <ErrorBanner error={error} onRetry={() => void load()} />
      <StatRow items={[{ label: "异常总数", kind: "count", amount: summaryReady ? String(summary?.total ?? 0) : "不可用" }, { label: "高严重度", kind: "count", amount: summaryReady ? String(summary?.by_severity?.HIGH ?? 0) : "不可用", tone: "warn" }]} />
      <Card
        className="glass"
        title="月度质量指标"
        extra={
          <Select
            aria-label="指标统计区间"
            value={metricWindow}
            options={METRIC_WINDOWS}
            onChange={setMetricWindow}
            popupMatchSelectWidth={false}
          />
        }
      >
        <DataTable<QualityMetricRow>
          columns={arrangeMetricColumns(metricColumns)}
          rows={metrics?.items ?? []}
          loading={metricsLoading}
          page={1}
          pageSize={12}
          total={metrics?.items.length ?? 0}
          emptyText="暂无指标数据"
          onPageChange={() => undefined}
        />
      </Card>
      <Card className="glass" title="质量异常工单" extra={<Space><PermissionButton permission="order.update" loading={scanning} onClick={() => void scanIssues()}>主动扫描</PermissionButton><PermissionButton permission="order.update" type="primary" onClick={() => setCreateOpen(true)}>新建工单</PermissionButton></Space>}>
        <DataTable<QualityIssue> columns={arrangeColumns(columns)} rows={rows} page={1} pageSize={10} total={rows.length} emptyText="暂无质量异常" onPageChange={() => undefined} />
        <PermissionButton permission="order.update" disabled={!summaryReady || rows.every((row) => row.status === "CLOSED")} onClick={() => setBatchCloseOpen(true)}>批量关闭未关闭工单</PermissionButton>
      </Card>
      <BusinessActionModal title="新建质量工单" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null}>
        <InlineError error={createOpen ? error : null} />
        <BusinessForm form={createForm} onFinish={createIssue}>
          <Form.Item name="code" label="异常编码" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="severity" label="严重程度" rules={[{ required: true }]}><Select options={severityOptions} /></Form.Item>
          <Form.Item name="title" label="标题" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="entity_type" label="对象类型" rules={[{ required: true }]}><Input placeholder="order / account / customer" /></Form.Item>
          <Form.Item name="entity_id" label="对象编号" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="message" label="问题描述" rules={[{ required: true }]}><Input.TextArea rows={3} /></Form.Item>
          <PermissionButton permission="order.update" type="primary" htmlType="submit" loading={creating}>创建工单</PermissionButton>
        </BusinessForm>
      </BusinessActionModal>
      <BusinessActionModal size="compact" title="关闭质量工单" open={Boolean(closeTarget)} onCancel={() => setCloseTarget(null)} footer={null}>
        <InlineError error={closeTarget ? error : null} />
        <BusinessForm form={closeForm} onFinish={closeIssue}>
          <Form.Item name="resolution" label="处理结果" rules={[{ required: true }]}><Input.TextArea rows={3} /></Form.Item>
          <Form.Item name="evidence" label="依据"><Input.TextArea rows={2} /></Form.Item>
          <CompactActions>
            <PermissionButton permission="order.update" type="primary" htmlType="submit" loading={closing}>确认关闭</PermissionButton>
          </CompactActions>
        </BusinessForm>
      </BusinessActionModal>
      <BusinessActionModal size="compact" title="批量关闭质量工单" open={batchCloseOpen} onCancel={() => setBatchCloseOpen(false)} footer={null}>
        <InlineError error={batchCloseOpen ? error : null} />
        <BusinessForm form={batchCloseForm} onFinish={batchCloseIssues}>
          <Form.Item name="resolution" label="批量处理结果" rules={[{ required: true }]}><Input.TextArea rows={3} placeholder="将应用到当前列表中最多 50 条未关闭工单" /></Form.Item>
          <Form.Item name="evidence" label="依据"><Input.TextArea rows={2} /></Form.Item>
          <CompactActions>
            <PermissionButton permission="order.update" type="primary" htmlType="submit" loading={batchClosing}>确认批量关闭</PermissionButton>
          </CompactActions>
        </BusinessForm>
      </BusinessActionModal>
    </section>
  );
}
