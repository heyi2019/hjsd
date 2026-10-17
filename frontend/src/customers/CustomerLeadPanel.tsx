/** 客户需求池：记录需求事实，支持转单或关闭，不自动生成订单（CUS-02）。 */
import { Card, Form, Input, Modal, Select, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { customersApi, leadsApi, type Customer, type Lead } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { DataTable, ErrorBanner, MoneyText, PermissionButton, StatRow, StatusTag } from "../shared/ui";

const REQUEST_TYPE_LABEL: Record<string, string> = { FIND_ACCOUNT: "找号", SELL_ACCOUNT: "卖号", SPECIFIC_SEARCH: "指定搜索" };

export function CustomerLeadPanel() {
  const [rows, setRows] = useState<Lead[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [closeTarget, setCloseTarget] = useState<Lead | null>(null);
  const [convertTarget, setConvertTarget] = useState<Lead | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [createForm] = Form.useForm();
  const [closeForm] = Form.useForm();
  const [convertForm] = Form.useForm();

  const load = useCallback(async () => {
    try {
      const [leadList, customerList] = await Promise.all([leadsApi.list(), customersApi.list({ status: "ACTIVE" })]);
      setRows(leadList);
      setCustomers(customerList);
      setError(null);
    } catch (err) { setError(normalizeError(err)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const createLead = async (values: Record<string, unknown>) => {
    try {
      await leadsApi.create({ customer_id: Number(values.customer_id), request_type: values.request_type as string, budget: values.budget as string, target: values.target as string, note: values.note as string });
      message.success("客户需求已创建"); setCreateOpen(false); createForm.resetFields(); await load();
    } catch (err) { setError(normalizeError(err)); }
  };
  const closeLead = async (values: Record<string, unknown>) => {
    if (!closeTarget) return;
    try { await leadsApi.close(closeTarget.id, values.reason as string); message.success("需求已关闭"); setCloseTarget(null); closeForm.resetFields(); await load(); }
    catch (err) { setError(normalizeError(err)); }
  };
  const convertLead = async (values: Record<string, unknown>) => {
    if (!convertTarget) return;
    try { await leadsApi.convert(convertTarget.id, Number(values.order_id)); message.success("需求已转单"); setConvertTarget(null); convertForm.resetFields(); await load(); }
    catch (err) { setError(normalizeError(err)); }
  };

  const columns: ColumnsType<Lead> = [
    { title: "需求编号", dataIndex: "lead_no" },
    { title: "客户", render: (_v, row) => customers.find((customer) => customer.id === row.customer_id)?.display_name ?? row.customer_id },
    { title: "需求类型", dataIndex: "request_type", render: (v: string) => REQUEST_TYPE_LABEL[v] ?? v },
    { title: "预算", dataIndex: "budget", align: "right", render: (v: string | null) => v ? <MoneyText value={v} /> : "-" },
    { title: "目标", dataIndex: "target" },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} /> },
    { title: "操作", render: (_v, row) => row.status === "OPEN" ? <><PermissionButton permission="customer.create" size="small" onClick={() => setConvertTarget(row)}>转单</PermissionButton><PermissionButton permission="customer.update" size="small" onClick={() => setCloseTarget(row)}>关闭</PermissionButton></> : null },
  ];

  return <section className="ui-stack">
    <ErrorBanner error={error} onRetry={() => void load()} />
    <StatRow items={[{ label: "需求总数", kind: "count", amount: String(rows.length) }, { label: "待跟进", kind: "count", amount: String(rows.filter((row) => row.status === "OPEN").length), tone: "warn" }]} />
    <Card className="glass" title="客户需求池" extra={<PermissionButton permission="customer.create" type="primary" onClick={() => setCreateOpen(true)}>新增需求</PermissionButton>}>
      <DataTable<Lead> columns={columns} rows={rows} page={1} pageSize={10} total={rows.length} emptyText="暂无客户需求" onPageChange={() => undefined} />
    </Card>
    <Modal title="新增客户需求" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null}>
      <Form form={createForm} layout="vertical" onFinish={createLead}>
        <Form.Item name="customer_id" label="客户" rules={[{ required: true }]}><Select options={customers.map((customer) => ({ value: customer.id, label: `${customer.customer_no} · ${customer.display_name}` }))} /></Form.Item>
        <Form.Item name="request_type" label="需求类型" rules={[{ required: true }]}><Select options={Object.entries(REQUEST_TYPE_LABEL).map(([value, label]) => ({ value, label }))} /></Form.Item>
        <Form.Item name="budget" label="预算"><Input /></Form.Item>
        <Form.Item name="target" label="需求目标" rules={[{ required: true }]}><Input.TextArea rows={3} /></Form.Item>
        <Form.Item name="note" label="备注"><Input.TextArea rows={2} /></Form.Item>
        <PermissionButton permission="customer.create" type="primary" htmlType="submit">创建需求</PermissionButton>
      </Form>
    </Modal>
    <Modal title="关闭客户需求" open={Boolean(closeTarget)} onCancel={() => setCloseTarget(null)} footer={null}>
      <Form form={closeForm} layout="vertical" onFinish={closeLead}><Form.Item name="reason" label="关闭原因" rules={[{ required: true }]}><Input.TextArea rows={3} /></Form.Item><PermissionButton permission="customer.update" type="primary" htmlType="submit">确认关闭</PermissionButton></Form>
    </Modal>
    <Modal title="需求转单" open={Boolean(convertTarget)} onCancel={() => setConvertTarget(null)} footer={null}>
      <Form form={convertForm} layout="vertical" onFinish={convertLead}><Form.Item name="order_id" label="订单 ID" rules={[{ required: true }]}><Input /></Form.Item><PermissionButton permission="customer.create" type="primary" htmlType="submit">确认转单</PermissionButton></Form>
    </Modal>
  </section>;
}
