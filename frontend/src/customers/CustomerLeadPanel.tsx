/** 客户需求池：记录需求事实，支持转单或关闭，不自动生成订单（CUS-02）。 */
import { Card, Form, Input, Modal, Select, Space, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { customersApi, leadsApi, type Customer, type Lead } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { DataTable, ErrorBanner, MoneyInput, MoneyText, PermissionButton, StatRow, StatusTag } from "../shared/ui";
import { moneyRules } from "../shared/lib/validators";
import { CfgItem, FieldConfigContext, FieldConfigScope, useOrderFormConfig } from "../orders/ConfigurableField";

const REQUEST_TYPE_LABEL: Record<string, string> = { FIND_ACCOUNT: "找号", SELL_ACCOUNT: "卖号", SPECIFIC_SEARCH: "指定搜索" };

export function CustomerLeadPanel() {
  const [rows, setRows] = useState<Lead[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const { config } = useOrderFormConfig(createOpen ? "LEAD" : undefined);
  const [closeTarget, setCloseTarget] = useState<Lead | null>(null);
  const [convertTarget, setConvertTarget] = useState<Lead | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [acting, setActing] = useState(false);
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
      setError(null);
      setActing(true);
      await leadsApi.create({ customer_id: Number(values.customer_id), request_type: values.request_type as string, budget: values.budget as string, target: values.target as string, note: values.note as string });
      message.success("客户需求已创建"); setCreateOpen(false); createForm.resetFields(); await load();
    } catch (err) { setError(normalizeError(err)); }
    finally { setActing(false); }
  };
  const closeLead = async (values: Record<string, unknown>) => {
    if (!closeTarget) return;
    try {
      setError(null);
      setActing(true);
      await leadsApi.close(closeTarget.id, values.reason as string); message.success("需求已关闭"); setCloseTarget(null); closeForm.resetFields(); await load();
    }
    catch (err) { setError(normalizeError(err)); }
    finally { setActing(false); }
  };
  const convertLead = async (values: Record<string, unknown>) => {
    if (!convertTarget) return;
    try {
      setError(null);
      setActing(true);
      await leadsApi.convert(convertTarget.id, Number(values.order_id)); message.success("需求已转单"); setConvertTarget(null); convertForm.resetFields(); await load();
    }
    catch (err) { setError(normalizeError(err)); }
    finally { setActing(false); }
  };

  const columns: ColumnsType<Lead> = [
    { title: "需求编号", dataIndex: "lead_no" },
    { title: "客户", render: (_v, row) => customers.find((customer) => customer.id === row.customer_id)?.display_name ?? row.customer_id },
    { title: "需求类型", dataIndex: "request_type", render: (v: string) => REQUEST_TYPE_LABEL[v] ?? v },
    { title: "预算", dataIndex: "budget", align: "right", render: (v: string | null) => v ? <MoneyText value={v} /> : "-" },
    { title: "目标", dataIndex: "target" },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} /> },
    { title: "操作", render: (_v, row) => row.status === "OPEN" ? <Space size={2}><PermissionButton permission="customer.create" size="small" onClick={() => setConvertTarget(row)}>转单</PermissionButton><PermissionButton permission="customer.update" size="small" onClick={() => setCloseTarget(row)}>关闭</PermissionButton></Space> : null },
  ];

  return <section className="ui-stack">
    <ErrorBanner error={error} onRetry={() => void load()} />
    <StatRow items={[{ label: "需求总数", kind: "count", amount: String(rows.length) }, { label: "待跟进", kind: "count", amount: String(rows.filter((row) => row.status === "OPEN").length), tone: "warn" }]} />
    <Card className="glass" title="客户需求池" extra={<PermissionButton permission="customer.create" type="primary" onClick={() => setCreateOpen(true)}>新增需求</PermissionButton>}>
      <DataTable<Lead> columns={columns} rows={rows} page={1} pageSize={10} total={rows.length} emptyText="暂无客户需求" onPageChange={() => undefined} />
    </Card>
    <Modal title="新增客户需求" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null}>
      <FieldConfigContext.Provider value={config}>
        <Form form={createForm} layout="vertical" onFinish={createLead}>
          <CfgItem name="customer_id" label="客户" rules={[{ required: true }]}><Select options={customers.map((customer) => ({ value: customer.id, label: `${customer.customer_no} · ${customer.display_name}` }))} /></CfgItem>
          <CfgItem name="request_type" label="需求类型" rules={[{ required: true }]}><Select /></CfgItem>
          <CfgItem name="budget" label="预算" rules={moneyRules("预算")}><MoneyInput /></CfgItem>
          <CfgItem name="target" label="需求目标" rules={[{ required: true }]}><Input.TextArea rows={3} /></CfgItem>
          <CfgItem name="note" label="备注"><Input.TextArea rows={2} /></CfgItem>
          <PermissionButton permission="customer.create" type="primary" htmlType="submit" loading={acting}>创建需求</PermissionButton>
        </Form>
      </FieldConfigContext.Provider>
    </Modal>
    <Modal title="关闭客户需求" open={Boolean(closeTarget)} onCancel={() => setCloseTarget(null)} footer={null}>
      <FieldConfigScope scope="LEADCLOSE" active={Boolean(closeTarget)}>
        <Form form={closeForm} layout="vertical" onFinish={closeLead}>
          <CfgItem name="reason" label="关闭原因" rules={[{ required: true }]}><Input.TextArea rows={3} /></CfgItem>
          <PermissionButton permission="customer.update" type="primary" htmlType="submit" loading={acting}>确认关闭</PermissionButton>
        </Form>
      </FieldConfigScope>
    </Modal>
    <Modal title="需求转单" open={Boolean(convertTarget)} onCancel={() => setConvertTarget(null)} footer={null}>
      <FieldConfigScope scope="LEADCONVERT" active={Boolean(convertTarget)}>
        <Form form={convertForm} layout="vertical" onFinish={convertLead}>
          <CfgItem name="order_id" label="订单 ID" rules={[{ required: true }]}><Input /></CfgItem>
          <PermissionButton permission="customer.create" type="primary" htmlType="submit" loading={acting}>确认转单</PermissionButton>
        </Form>
      </FieldConfigScope>
    </Modal>
  </section>;
}
