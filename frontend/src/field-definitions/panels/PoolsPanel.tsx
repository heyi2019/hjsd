import { Card, Form, Input, Modal, Select, Space, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { poolsApi, type Pool } from "../../shared/api/catalog";
import { normalizeError } from "../../shared/api/client";
import { POOL_OWNERSHIP_LABEL, POOL_TYPE_LABEL } from "../../shared/lib/labels";
import { configurableLabel, useOptionSet } from "../../shared/lib/optionSets";

/** 词典未加载/未打桩时的回落值，与改造前硬编码完全一致，保证零行为变化。 */
const POOL_TYPE_FALLBACK = [
  { value: "INVEST", label: "投资款" },
  { value: "PROFIT", label: "利润" },
  { value: "OTHER", label: "其他" },
];
const POOL_OWNERSHIP_FALLBACK = [
  { value: "OWNED", label: "自有" },
  { value: "CUSTODY", label: "代管" },
  { value: "THIRD_PART", label: "第三方" },
];
import { ConfirmButton, DataTable, ErrorBanner, PermissionButton, PermissionGate, StatusTag } from "../../shared/ui";

export function PoolsPanel() {
  const poolTypeOptions = useOptionSet("POOL_TYPE") ?? POOL_TYPE_FALLBACK;
  const ownershipOptions = useOptionSet("POOL_OWNERSHIP") ?? POOL_OWNERSHIP_FALLBACK;
  const [rows, setRows] = useState<Pool[]>([]);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const [editing, setEditing] = useState<Pool | null>(null);
  const load = useCallback(async () => {
    try {
      setRows(await poolsApi.list());
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (values: Record<string, unknown>) => {
    try {
      await poolsApi.create({
        code: (values.code as string).toUpperCase(),
        name: values.name as string,
        pool_type: (values.pool_type as string) ?? "OTHER",
        ownership: (values.ownership as string) ?? "OWNED",
      });
      message.success("资金池已创建");
      form.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const toggleStatus = async (row: Pool) => {
    try { await poolsApi.setStatus(row.id, row.status === "ACTIVE" ? "DISABLED" : "ACTIVE"); message.success(row.status === "ACTIVE" ? "资金池已停用" : "资金池已启用"); await load(); }
    catch (err) { setError(normalizeError(err)); }
  };

  const update = async (values: Record<string, unknown>) => {
    if (!editing) return;
    try {
      await poolsApi.update(editing.id, {
        name: values.name as string,
        pool_type: values.pool_type as string,
        ownership: values.ownership as string,
        note: (values.note as string) || null,
      });
      message.success("资金池已更新");
      setEditing(null);
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const columns: ColumnsType<Pool> = [
    { title: "代码", dataIndex: "code", className: "ui-col-md-up", onCell: () => ({ className: "ui-col-md-up" }) },
    { title: "名称", dataIndex: "name" },
    { title: "类型", dataIndex: "pool_type", render: (v: string) => configurableLabel("POOL_TYPE", v, POOL_TYPE_LABEL) },
    { title: "归属", dataIndex: "ownership", render: (v: string) => configurableLabel("POOL_OWNERSHIP", v, POOL_OWNERSHIP_LABEL), className: "ui-col-md-up", onCell: () => ({ className: "ui-col-md-up" }) },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} optionSet="POOL_STATUS" /> },
    { title: "操作", render: (_v, row) => <Space size={2}><PermissionButton permission="pool.manage" size="small" onClick={() => { setEditing(row); editForm.setFieldsValue(row); }}>{"编辑"}</PermissionButton><ConfirmButton
              permission="pool.manage"
              size="small"
              title={row.status === "ACTIVE" ? "停用该资金池" : "启用该资金池"}
              description={row.status === "ACTIVE"
                ? "停用后该池不可入账，收款、划转与押金登记都会失败。请先确认池内余额与在途流水已处理。"
                : "启用后该池可重新入账。"}
              danger={row.status === "ACTIVE"}
              onConfirm={() => toggleStatus(row)}
            >
              {row.status === "ACTIVE" ? "停用" : "启用"}
            </ConfirmButton></Space> },
  ];
  return (
    <Card className="glass" title="资金池主数据">
      <ErrorBanner error={error} onRetry={() => void load()} />
      <DataTable<Pool>
        columns={columns}
        rows={rows}
        page={1}
        pageSize={Math.max(rows.length, 10)}
        total={rows.length}
        emptyText="暂无资金池"
        onPageChange={() => undefined}
     />
      <PermissionGate
        permission="pool.manage"
        fallback={<Typography.Paragraph type="secondary">当前角色无主数据维护权限。</Typography.Paragraph>}
      >
        <Form form={form} layout="inline" onFinish={submit} className="ui-form-spaced">
          <Form.Item name="code" rules={[{ required: true }]}>
            <Input placeholder="池代码，如 HJ_CUSTODY" />
          </Form.Item>
          <Form.Item name="name" rules={[{ required: true }]}>
            <Input placeholder="显示名" />
          </Form.Item>
          <Form.Item>
            <PermissionButton permission="pool.manage" type="primary" htmlType="submit">
              新增资金池
            </PermissionButton>
          </Form.Item>
        </Form>
      </PermissionGate>
      <Modal title={editing ? `编辑资金池 · ${editing.code}` : "编辑资金池"} open={Boolean(editing)} onCancel={() => { setEditing(null); editForm.resetFields(); }} onOk={() => void editForm.submit()} okText="保存">
        <Form layout="vertical" form={editForm} onFinish={update}>
          <Form.Item label="代码"><Input value={editing?.code} disabled /></Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="pool_type" label="用途类型" rules={[{ required: true }]}><Select options={poolTypeOptions} /></Form.Item>
          <Form.Item name="ownership" label="资金归属" rules={[{ required: true }]}><Select options={ownershipOptions} /></Form.Item>
          <Form.Item name="note" label="备注"><Input.TextArea rows={3} /></Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
