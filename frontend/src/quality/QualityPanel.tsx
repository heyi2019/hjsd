/** 质量中心：异常摘要、工单处理与关闭（QLT-01）。 */
import { Card, Form, Input, Modal, Select, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { qualityApi, type QualityIssue, type QualitySummary } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { DataTable, ErrorBanner, PermissionButton, StatRow, StatusTag } from "../shared/ui";

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
  };

  const closeIssue = async (values: Record<string, unknown>) => {
    if (!closeTarget) return;
    try {
      await qualityApi.close(closeTarget.id, { resolution: values.resolution as string, evidence: values.evidence as string });
      message.success("质量工单已关闭");
      setCloseTarget(null);
      closeForm.resetFields();
      await load();
    } catch (err) { setError(normalizeError(err)); }
  };

  const batchCloseIssues = async (values: Record<string, unknown>) => {
    const ids = rows.filter((row) => row.status !== "CLOSED").map((row) => row.id).slice(0, 50);
    if (!ids.length) { message.info("暂无可批量关闭的工单"); return; }
    try {
      await qualityApi.batchClose({ issue_ids: ids, resolution: values.resolution as string, evidence: values.evidence as string });
      message.success("质量工单已批量关闭");
      setBatchCloseOpen(false);
      batchCloseForm.resetFields();
      await load();
    } catch (err) { setError(normalizeError(err)); }
  };

  const columns: ColumnsType<QualityIssue> = [
    { title: "工单号", dataIndex: "issue_no" },
    { title: "级别", dataIndex: "severity", render: (v: string) => <StatusTag status={v} /> },
    { title: "标题", dataIndex: "title" },
    { title: "对象", render: (_v, row) => `${row.entity_type}:${row.entity_id}` },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} /> },
    { title: "问题", dataIndex: "message" },
    { title: "操作", render: (_v, row) => row.status !== "CLOSED" ? <PermissionButton permission="order.exception.approve" size="small" onClick={() => setCloseTarget(row)}>关闭</PermissionButton> : null },
  ];

  return (
    <section className="ui-stack">
      <ErrorBanner error={error} onRetry={() => void load()} />
      <StatRow items={[{ label: "异常总数", kind: "count", amount: String(summary?.total ?? 0) }, { label: "高严重度", kind: "count", amount: String(summary?.by_severity?.HIGH ?? 0), tone: "warn" }]} />
      <Card className="glass" title="质量异常工单" extra={<PermissionButton permission="order.exception.approve" type="primary" onClick={() => setCreateOpen(true)}>新建工单</PermissionButton>}>
        <DataTable<QualityIssue> columns={columns} rows={rows} page={1} pageSize={10} total={rows.length} emptyText="暂无质量异常" onPageChange={() => undefined} />
        <PermissionButton permission="order.exception.approve" onClick={() => setBatchCloseOpen(true)}>批量关闭未关闭工单</PermissionButton>
      </Card>
      <Modal title="新建质量工单" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null}>
        <Form form={createForm} layout="vertical" onFinish={createIssue}>
          <Form.Item name="code" label="异常编码" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="severity" label="严重程度" rules={[{ required: true }]}><Select options={[{ value: "LOW", label: "低" }, { value: "MEDIUM", label: "中" }, { value: "HIGH", label: "高" }, { value: "CRITICAL", label: "严重" }]} /></Form.Item>
          <Form.Item name="title" label="标题" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="entity_type" label="对象类型" rules={[{ required: true }]}><Input placeholder="order / account / customer" /></Form.Item>
          <Form.Item name="entity_id" label="对象编号" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="message" label="问题描述" rules={[{ required: true }]}><Input.TextArea rows={3} /></Form.Item>
          <PermissionButton permission="order.exception.approve" type="primary" htmlType="submit">创建工单</PermissionButton>
        </Form>
      </Modal>
      <Modal title="关闭质量工单" open={Boolean(closeTarget)} onCancel={() => setCloseTarget(null)} footer={null}>
        <Form form={closeForm} layout="vertical" onFinish={closeIssue}>
          <Form.Item name="resolution" label="处理结果" rules={[{ required: true }]}><Input.TextArea rows={3} /></Form.Item>
          <Form.Item name="evidence" label="依据"><Input.TextArea rows={2} /></Form.Item>
          <PermissionButton permission="order.exception.approve" type="primary" htmlType="submit">确认关闭</PermissionButton>
        </Form>
      </Modal>
      <Modal title="批量关闭质量工单" open={batchCloseOpen} onCancel={() => setBatchCloseOpen(false)} footer={null}>
        <Form form={batchCloseForm} layout="vertical" onFinish={batchCloseIssues}>
          <Form.Item name="resolution" label="批量处理结果" rules={[{ required: true }]}><Input.TextArea rows={3} placeholder="将应用到当前列表中最多 50 条未关闭工单" /></Form.Item>
          <Form.Item name="evidence" label="依据"><Input.TextArea rows={2} /></Form.Item>
          <PermissionButton permission="order.exception.approve" type="primary" htmlType="submit">确认批量关闭</PermissionButton>
        </Form>
      </Modal>
    </section>
  );
}
