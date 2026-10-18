import { Card, Form, Input, Modal, Select, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { poolAccountsApi, poolsApi, type Pool, type PoolAccount } from "../../shared/api/catalog";
import { normalizeError } from "../../shared/api/client";
import { POOL_OWNERSHIP_LABEL, POOL_TYPE_LABEL } from "../../shared/lib/labels";
import { DataTable, ErrorBanner, PermissionButton, PermissionGate, StatusTag } from "../../shared/ui";

export function PoolsPanel() {
  const [rows, setRows] = useState<Pool[]>([]);
  const [accounts, setAccounts] = useState<PoolAccount[]>([]);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const [accountEditForm] = Form.useForm();
  const [editing, setEditing] = useState<Pool | null>(null);
  const [editingAccount, setEditingAccount] = useState<PoolAccount | null>(null);
  const load = useCallback(async () => {
    try {
      setRows(await poolsApi.list());
      setAccounts(await poolAccountsApi.list());
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

  const updateAccount = async (values: Record<string, unknown>) => {
    if (!editingAccount) return;
    try {
      await poolAccountsApi.update(editingAccount.id, {
        account_name: String(values.account_name),
        account_type: String(values.account_type),
        ownership: String(values.ownership),
        opening_balance: String(values.opening_balance ?? "0.00"),
      });
      message.success("资金池账户已更新");
      setEditingAccount(null);
      accountEditForm.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const columns: ColumnsType<Pool> = [
    { title: "代码", dataIndex: "code" },
    { title: "名称", dataIndex: "name" },
    { title: "类型", dataIndex: "pool_type", render: (v: string) => POOL_TYPE_LABEL[v] ?? v },
    { title: "归属", dataIndex: "ownership", render: (v: string) => POOL_OWNERSHIP_LABEL[v] ?? v },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} /> },
    { title: "操作", render: (_v, row) => <><PermissionButton permission="pool.manage" size="small" onClick={() => { setEditing(row); editForm.setFieldsValue(row); }}>{"编辑"}</PermissionButton><PermissionButton permission="pool.manage" size="small" onClick={() => void toggleStatus(row)}>{row.status === "ACTIVE" ? "停用" : "启用"}</PermissionButton></> },
  ];
  const accountColumns: ColumnsType<PoolAccount> = [
    { title: "账户编号", dataIndex: "account_no" },
    { title: "账户名称", dataIndex: "account_name" },
    { title: "资金池", render: (_v, row) => rows.find((pool) => pool.id === row.pool_id)?.name ?? row.pool_id },
    { title: "类型", dataIndex: "account_type" },
    { title: "归属", dataIndex: "ownership", render: (v: string) => POOL_OWNERSHIP_LABEL[v] ?? v },
    { title: "期初余额", dataIndex: "opening_balance" },
    { title: "当前余额", dataIndex: "current_balance" },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} /> },
    {
      title: "操作",
      render: (_v, row) => (
        <>
          <PermissionButton
            permission="pool.manage"
            size="small"
            aria-label={`编辑${row.account_no}`}
            onClick={() => {
              setEditingAccount(row);
              accountEditForm.setFieldsValue(row);
            }}
          >
            编辑
          </PermissionButton>
          <PermissionButton permission="pool.manage" size="small" onClick={async () => { try { await poolAccountsApi.setStatus(row.id, row.status === "ACTIVE" ? "DISABLED" : "ACTIVE"); await load(); } catch (err) { setError(normalizeError(err)); } }}>{row.status === "ACTIVE" ? "停用" : "启用"}</PermissionButton>
        </>
      ),
    },
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
          <Form.Item name="pool_type" label="用途类型" rules={[{ required: true }]}><Select options={[{ value: "INVEST", label: "投资款" }, { value: "PROFIT", label: "利润" }, { value: "OTHER", label: "其他" }]} /></Form.Item>
          <Form.Item name="ownership" label="资金归属" rules={[{ required: true }]}><Select options={[{ value: "OWNED", label: "自有" }, { value: "CUSTODY", label: "代管" }, { value: "THIRD_PART", label: "第三方" }]} /></Form.Item>
          <Form.Item name="note" label="备注"><Input.TextArea rows={3} /></Form.Item>
        </Form>
      </Modal>
      <Card className="glass" title="资金池账户">
        <DataTable<PoolAccount> columns={accountColumns} rows={accounts} page={1} pageSize={10} total={accounts.length} emptyText="暂无资金池账户" onPageChange={() => undefined} />
        <PermissionGate permission="pool.manage">
          <Form layout="inline" className="ui-form-spaced" onFinish={async (values) => { try { const ids = String(values.account_ids).split(",").map((value) => Number(value.trim())).filter(Boolean); await poolAccountsApi.batchStatus({ account_ids: ids, status: String(values.status) as "ACTIVE" | "DISABLED", reason: String(values.reason) }); message.success("资金池账户已批量更新"); await load(); } catch (err) { setError(normalizeError(err)); } }}>
            <Form.Item name="account_ids" rules={[{ required: true }]}><Input placeholder="账户 ID，逗号分隔" /></Form.Item>
            <Form.Item name="status" initialValue="DISABLED"><Select options={[{ value: "ACTIVE", label: "批量启用" }, { value: "DISABLED", label: "批量停用" }]} /></Form.Item>
            <Form.Item name="reason" rules={[{ required: true }]}><Input placeholder="变更原因" /></Form.Item>
            <PermissionButton permission="pool.manage" type="primary" htmlType="submit">批量更新状态</PermissionButton>
          </Form>
          <Form layout="inline" className="ui-form-spaced" onFinish={async (values) => { try { await poolAccountsApi.create({ pool_id: Number(values.pool_id), account_no: String(values.account_no), account_name: String(values.account_name), account_type: String(values.account_type), ownership: String(values.ownership), opening_balance: String(values.opening_balance ?? "0.00") }); message.success("资金池账户已创建"); await load(); } catch (err) { setError(normalizeError(err)); } }}>
            <Form.Item name="pool_id" rules={[{ required: true }]}><Select placeholder="选择资金池" options={rows.map((pool) => ({ value: pool.id, label: pool.name }))} /></Form.Item>
            <Form.Item name="account_no" rules={[{ required: true }]}><Input placeholder="账户编号" /></Form.Item>
            <Form.Item name="account_name" rules={[{ required: true }]}><Input placeholder="账户名称" /></Form.Item>
            <Form.Item name="account_type" initialValue="BANK"><Select options={[{ value: "BANK", label: "银行" }, { value: "CASH", label: "现金" }, { value: "THIRD_PARTY", label: "第三方" }]} /></Form.Item>
            <Form.Item name="ownership" initialValue="OWNED"><Select options={[{ value: "OWNED", label: "自有" }, { value: "CUSTODY", label: "代管" }, { value: "THIRD_PART", label: "第三方" }]} /></Form.Item>
            <Form.Item name="opening_balance" initialValue="0.00"><Input placeholder="期初余额" /></Form.Item>
            <PermissionButton permission="pool.manage" type="primary" htmlType="submit">新增账户</PermissionButton>
          </Form>
        </PermissionGate>
      </Card>
      <Modal
        title={editingAccount ? `编辑资金账户 · ${editingAccount.account_no}` : "编辑资金账户"}
        open={Boolean(editingAccount)}
        onCancel={() => { setEditingAccount(null); accountEditForm.resetFields(); }}
        onOk={() => void accountEditForm.submit()}
        okText="保存"
      >
        <Form layout="vertical" form={accountEditForm} onFinish={updateAccount}>
          <Form.Item label="账户编号"><Input value={editingAccount?.account_no} disabled /></Form.Item>
          <Form.Item label="资金池"><Input value={editingAccount ? rows.find((pool) => pool.id === editingAccount.pool_id)?.name : undefined} disabled /></Form.Item>
          <Form.Item name="account_name" label="账户名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="account_type" label="类型" rules={[{ required: true }]}><Select options={[{ value: "BANK", label: "银行" }, { value: "CASH", label: "现金" }, { value: "THIRD_PARTY", label: "第三方" }]} /></Form.Item>
          <Form.Item name="ownership" label="归属" rules={[{ required: true }]}><Select options={[{ value: "OWNED", label: "自有" }, { value: "CUSTODY", label: "代管" }, { value: "THIRD_PART", label: "第三方" }]} /></Form.Item>
          <Form.Item name="opening_balance" label="期初余额" rules={[{ required: true }]}><Input /></Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
