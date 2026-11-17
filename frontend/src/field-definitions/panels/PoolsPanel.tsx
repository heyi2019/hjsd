import { appMessage } from "../../shared/ui/appFeedback";
import { Card, Form, Input, Space, Switch, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useState } from "react";
import { poolsApi } from "../../shared/api/pools.api";
import type { Pool } from "../../shared/api/types/finance";
import { normalizeError, type NormalizedError } from "../../shared/api/client";
import { POOL_OWNERSHIP_LABEL, POOL_TYPE_LABEL } from "../../shared/lib/labels";
import { configurableLabel, useOptionSet } from "../../shared/lib/optionSets";
import { useSettingsResource } from "../../shared/state/useSettingsResource";
import { BusinessActionModal, BusinessRegistrationForm, Select } from "../../shared/ui";

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
import { ConfirmButton, DataTable, ErrorBanner, InlineError, PermissionButton, PermissionGate, StatusTag } from "../../shared/ui";

export function PoolsPanel() {
  const poolTypeOptions = useOptionSet("POOL_TYPE") ?? POOL_TYPE_FALLBACK;
  const ownershipOptions = useOptionSet("POOL_OWNERSHIP") ?? POOL_OWNERSHIP_FALLBACK;
  const [mutationError, setMutationError] = useState<NormalizedError | null>(null);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const [editing, setEditing] = useState<Pool | null>(null);
  const load = useCallback(() => poolsApi.list(), []);
  const { data: loadedRows, loading, error: loadError, reload } = useSettingsResource(load);
  const rows = loadedRows ?? [];
  const error = mutationError ?? loadError;
  const reloadPanel = useCallback(async () => {
    setMutationError(null);
    await reload();
  }, [reload]);

  const submit = async (values: Record<string, unknown>) => {
    try {
      await poolsApi.create({
        code: (values.code as string).toUpperCase(),
        name: values.name as string,
        pool_type: (values.pool_type as string) ?? "OTHER",
        ownership: (values.ownership as string) ?? "OWNED",
        is_default: Boolean(values.is_default),
      });
      appMessage.success("资金账户已创建");
      form.resetFields();
      setMutationError(null);
      await reload();
    } catch (err) {
      setMutationError(normalizeError(err));
    }
  };

  const toggleStatus = async (row: Pool) => {
    try { await poolsApi.setStatus(row.id, row.status === "ACTIVE" ? "DISABLED" : "ACTIVE"); appMessage.success(row.status === "ACTIVE" ? "资金账户已停用" : "资金账户已启用"); setMutationError(null); await reload(); }
    catch (err) { setMutationError(normalizeError(err)); }
  };

  const remove = async (row: Pool) => {
    try {
      await poolsApi.remove(row.id);
      appMessage.success("资金账户已删除");
      setMutationError(null);
      await reload();
    } catch (err) {
      setMutationError(normalizeError(err));
    }
  };

  const update = async (values: Record<string, unknown>) => {
    if (!editing) return;
    try {
      await poolsApi.update(editing.id, {
        name: values.name as string,
        pool_type: values.pool_type as string,
        ownership: values.ownership as string,
        is_default: Boolean(values.is_default),
        note: (values.note as string) || null,
      });
      appMessage.success("资金账户已更新");
      setEditing(null);
      setMutationError(null);
      await reload();
    } catch (err) {
      setMutationError(normalizeError(err));
    }
  };

  const columns: ColumnsType<Pool> = [
    { title: "代码", dataIndex: "code" },
    { title: "名称", dataIndex: "name" },
    { title: "类型", dataIndex: "pool_type", render: (v: string) => configurableLabel("POOL_TYPE", v, POOL_TYPE_LABEL) },
    { title: "归属", dataIndex: "ownership", render: (v: string) => configurableLabel("POOL_OWNERSHIP", v, POOL_OWNERSHIP_LABEL) },
    { title: "默认", dataIndex: "is_default", width: 70, render: (v: boolean | undefined) => (v ? <StatusTag status="ACTIVE" label="默认" /> : null) },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} optionSet="POOL_STATUS" /> },
    { title: "操作", render: (_v, row) => <Space size={2}><PermissionButton permission="pool.manage" size="small" onClick={() => { setEditing(row); editForm.setFieldsValue(row); }}>{"编辑"}</PermissionButton><ConfirmButton
              permission="pool.manage"
              size="small"
              title={row.status === "ACTIVE" ? "停用该资金账户" : "启用该资金账户"}
              description={row.status === "ACTIVE"
                ? "停用后该池不可入账，收款、划转与押金登记都会失败。请先确认池内余额与在途流水已处理。"
                : "启用后该池可重新入账。"}
              danger={row.status === "ACTIVE"}
              onConfirm={() => toggleStatus(row)}
            >
              {row.status === "ACTIVE" ? "停用" : "启用"}
            </ConfirmButton><ConfirmButton
              permission="pool.manage"
              size="small"
              danger
              title="删除该资金账户"
              description="仅可删除从未产生流水的资金账户；已产生流水的池只能停用。删除后不可恢复，请确认。"
              okText="删除"
              onConfirm={() => remove(row)}
            >
              删除
            </ConfirmButton></Space> },
  ];
  return (
    <Card className="glass" title="资金账户主数据">
      <ErrorBanner error={error} onRetry={() => void reloadPanel()} retrying={loading} />
      <DataTable<Pool>
        columns={columns}
        rows={rows}
        loading={loading}
        page={1}
        pageSize={Math.max(rows.length, 10)}
        total={rows.length}
        emptyText={error ? "资金账户数据不可用，请点击重新加载" : "暂无资金账户"}
        onPageChange={() => undefined}
     />
      <PermissionGate
        permission="pool.manage"
        fallback={<Typography.Paragraph type="secondary">当前角色无主数据维护权限。</Typography.Paragraph>}
      >
        <BusinessRegistrationForm form={form} layout="inline" onFinish={submit}>
          <Form.Item name="code" rules={[{ required: true }]}>
            <Input placeholder="请输入资金账户编码" />
          </Form.Item>
          <Form.Item name="name" rules={[{ required: true }]}>
            <Input placeholder="显示名" />
          </Form.Item>
          <Form.Item name="is_default" valuePropName="checked">
            <Switch checkedChildren="默认" unCheckedChildren="否" />
          </Form.Item>
          <Form.Item>
            <PermissionButton permission="pool.manage" type="primary" htmlType="submit" disabled={Boolean(error)}>
              新增资金账户
            </PermissionButton>
          </Form.Item>
        </BusinessRegistrationForm>
      </PermissionGate>
      <BusinessActionModal title={editing ? `编辑资金账户 · ${editing.code}` : "编辑资金账户"} fieldCount={5} open={Boolean(editing)} onCancel={() => { setEditing(null); editForm.resetFields(); }} onOk={() => void editForm.submit()} okText="保存">
        <InlineError error={editing ? error : null} />
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} form={editForm} onFinish={update}>
          <Form.Item label="代码"><Input value={editing?.code} disabled /></Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="pool_type" label="用途类型" rules={[{ required: true }]}><Select options={poolTypeOptions} /></Form.Item>
          <Form.Item name="ownership" label="资金归属" rules={[{ required: true }]}><Select options={ownershipOptions} /></Form.Item>
          <Form.Item name="is_default" label="默认账户" valuePropName="checked" extra="未指定资金账户的流水进默认账户"><Switch checkedChildren="是" unCheckedChildren="否" /></Form.Item>
          <Form.Item name="note" label="备注"><Input.TextArea rows={3} /></Form.Item>
        </BusinessRegistrationForm>
      </BusinessActionModal>
    </Card>
  );
}
