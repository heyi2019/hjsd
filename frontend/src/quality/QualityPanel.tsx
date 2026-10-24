/** 质量中心：异常摘要、工单处理与关闭（QLT-01）。 */
import { Card, Form, Input, Modal, Select, Space, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { qualityApi, type QualityIssue, type QualitySummary } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { DataTable, ErrorBanner, InlineError, PermissionButton, StatRow, StatusTag } from "../shared/ui";

export function QualityPanel() {
  const [summary, setSummary] = useState<QualitySummary | null>(null);
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
    try {
      const [nextSummary, nextRows] = await Promise.all([qualityApi.summary(), qualityApi.list()]);
      setSummary(nextSummary);
      setRows(nextRows.items);
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

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
      message.success("质量工单已创建");
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
      message.success("质量工单已关闭");
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
    if (!ids.length) { message.info("暂无可批量关闭的工单"); return; }
    setBatchClosing(true);
    try {
      await qualityApi.batchClose({ issue_ids: ids, resolution: values.resolution as string, evidence: values.evidence as string });
      message.success(`已批量关闭 ${ids.length} 个未关闭工单${capped ? "（仅处理前 50 条，剩余请再次操作）" : ""}`);
      setBatchCloseOpen(false);
      batchCloseForm.resetFields();
      await load();
    } catch (err) {
      const normalized = normalizeError(err);
      setError(normalized);
      message.error(`批量关闭失败：${normalized.message}`);
    }
    finally { setBatchClosing(false); }
  };

  const updateIssueStatus = async (row: QualityIssue, status: "IN_PROGRESS") => {
    setUpdating(true);
    try {
      await qualityApi.update(row.id, { status });
      message.success("工单已进入处理中");
      await load();
    } catch (err) { setError(normalizeError(err)); }
    finally { setUpdating(false); }
  };

  const scanIssues = async () => {
    setScanning(true);
    try {
      const created = await qualityApi.scan();
      message.success(created.length > 0 ? `扫描发现 ${created.length} 个新异常，已生成工单` : "扫描完成，未发现新异常");
      await load();
    } catch (err) { setError(normalizeError(err)); }
    finally { setScanning(false); }
  };

  const columns: ColumnsType<QualityIssue> = [
    { title: "工单号", dataIndex: "issue_no" },
    { title: "级别", dataIndex: "severity", render: (v: string) => <StatusTag status={v} /> },
    { title: "标题", dataIndex: "title" },
    { title: "对象", render: (_v, row) => `${row.entity_type}:${row.entity_id}` },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} label={({ OPEN: "待处理", IN_PROGRESS: "处理中", CLOSED: "已关闭" } as Record<string, string>)[v]} /> },
    { title: "问题", dataIndex: "message" },
    {
      title: "操作",
      render: (_v, row) => row.status === "OPEN" ? (
        <Space>
          <PermissionButton permission="order.exception.approve" size="small" loading={updating} onClick={() => void updateIssueStatus(row, "IN_PROGRESS")}>开始处理</PermissionButton>
          <PermissionButton permission="order.exception.approve" size="small" onClick={() => setCloseTarget(row)}>关闭</PermissionButton>
        </Space>
      ) : row.status === "IN_PROGRESS" ? (
        <PermissionButton permission="order.exception.approve" size="small" onClick={() => setCloseTarget(row)}>关闭</PermissionButton>
      ) : null,
    },
  ];

  return (
    <section className="ui-stack">
      <ErrorBanner error={error} onRetry={() => void load()} />
      <StatRow items={[{ label: "异常总数", kind: "count", amount: String(summary?.total ?? 0) }, { label: "高严重度", kind: "count", amount: String(summary?.by_severity?.HIGH ?? 0), tone: "warn" }]} />
      <Card className="glass" title="质量异常工单" extra={<Space><PermissionButton permission="order.exception.approve" loading={scanning} onClick={() => void scanIssues()}>主动扫描</PermissionButton><PermissionButton permission="order.exception.approve" type="primary" onClick={() => setCreateOpen(true)}>新建工单</PermissionButton></Space>}>
        <DataTable<QualityIssue> columns={columns} rows={rows} page={1} pageSize={10} total={rows.length} scroll={{ x: "max-content" }} emptyText="暂无质量异常" onPageChange={() => undefined} />
        <PermissionButton permission="order.exception.approve" onClick={() => setBatchCloseOpen(true)}>批量关闭未关闭工单</PermissionButton>
      </Card>
      <Modal title="新建质量工单" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null}>
        <InlineError error={createOpen ? error : null} />
        <Form form={createForm} layout="vertical" onFinish={createIssue}>
          <Form.Item name="code" label="异常编码" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="severity" label="严重程度" rules={[{ required: true }]}><Select options={[{ value: "LOW", label: "低" }, { value: "MEDIUM", label: "中" }, { value: "HIGH", label: "高" }, { value: "CRITICAL", label: "严重" }]} /></Form.Item>
          <Form.Item name="title" label="标题" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="entity_type" label="对象类型" rules={[{ required: true }]}><Input placeholder="order / account / customer" /></Form.Item>
          <Form.Item name="entity_id" label="对象编号" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="message" label="问题描述" rules={[{ required: true }]}><Input.TextArea rows={3} /></Form.Item>
          <PermissionButton permission="order.exception.approve" type="primary" htmlType="submit" loading={creating}>创建工单</PermissionButton>
        </Form>
      </Modal>
      <Modal title="关闭质量工单" open={Boolean(closeTarget)} onCancel={() => setCloseTarget(null)} footer={null}>
        <InlineError error={closeTarget ? error : null} />
        <Form form={closeForm} layout="vertical" onFinish={closeIssue}>
          <Form.Item name="resolution" label="处理结果" rules={[{ required: true }]}><Input.TextArea rows={3} /></Form.Item>
          <Form.Item name="evidence" label="依据"><Input.TextArea rows={2} /></Form.Item>
          <PermissionButton permission="order.exception.approve" type="primary" htmlType="submit" loading={closing}>确认关闭</PermissionButton>
        </Form>
      </Modal>
      <Modal title="批量关闭质量工单" open={batchCloseOpen} onCancel={() => setBatchCloseOpen(false)} footer={null}>
        <InlineError error={batchCloseOpen ? error : null} />
        <Form form={batchCloseForm} layout="vertical" onFinish={batchCloseIssues}>
          <Form.Item name="resolution" label="批量处理结果" rules={[{ required: true }]}><Input.TextArea rows={3} placeholder="将应用到当前列表中最多 50 条未关闭工单" /></Form.Item>
          <Form.Item name="evidence" label="依据"><Input.TextArea rows={2} /></Form.Item>
          <PermissionButton permission="order.exception.approve" type="primary" htmlType="submit" loading={batchClosing}>确认批量关闭</PermissionButton>
        </Form>
      </Modal>
    </section>
  );
}
