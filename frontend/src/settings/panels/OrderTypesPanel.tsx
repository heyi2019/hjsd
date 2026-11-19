import { CfgItem, FieldConfigScope } from "../../business/ConfigurableField";
import { appMessage } from "../../shared/ui/appFeedback";
import { Form, Input, Space, Switch, Typography, InputNumber } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useState } from "react";
import { orderTypesApi } from "../../shared/api/orders.api";
import type { OrderType } from "../../shared/api/types/orders";
import { normalizeError, type NormalizedError } from "../../shared/api/client";
import { filterRetiredOrderTypes } from "../../shared/lib/retiredProducts";
import { useSettingsResource } from "../../shared/state/useSettingsResource";
import { BusinessActionModal, CompactActions, BusinessRegistrationForm, ConfirmButton, DataTable, ErrorBanner, PermissionButton, PermissionGate, Select, StatusTag } from "../../shared/ui";

export function OrderTypesPanel() {
  const [mutationError, setMutationError] = useState<NormalizedError | null>(null);
  const [editTarget, setEditTarget] = useState<OrderType | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editForm] = Form.useForm();
  const [createForm] = Form.useForm();
  const load = useCallback(async () => filterRetiredOrderTypes(await orderTypesApi.list()), []);
  const { data: loadedRows, loading, error: loadError, reload } = useSettingsResource(load);
  const rows = loadedRows ?? [];
  const error = mutationError ?? loadError;
  const reloadPanel = useCallback(async () => {
    setMutationError(null);
    await reload();
  }, [reload]);

  const toggleActive = async (row: OrderType) => {
    try { await orderTypesApi.setActive(row.id, !row.is_active); setMutationError(null); await reload(); }
    catch (err) { setMutationError(normalizeError(err)); }
  };

  const create = async (values: Record<string, unknown>) => {
    try {
      await orderTypesApi.create({
        code: String(values.code).trim().toUpperCase(),
        name: String(values.name).trim(),
        is_zero_principal: Boolean(values.is_zero_principal),
        sequence_prefix: values.sequence_prefix ? String(values.sequence_prefix).trim().toUpperCase() : undefined,
        sort_order: Number(values.sort_order ?? 0),
        description: values.description ? String(values.description) : null,
      });
      appMessage.success("业务类型已创建");
      setCreateOpen(false);
      createForm.resetFields();
      setMutationError(null);
      await reload();
    } catch (err) { appMessage.error(normalizeError(err).message); }
  };

  const update = async (values: Record<string, unknown>) => {
    if (!editTarget) return;
    try {
      await orderTypesApi.update(editTarget.id, {
        name: values.name as string,
        is_zero_principal: values.is_zero_principal === undefined ? editTarget.is_zero_principal : Boolean(values.is_zero_principal),
        description: values.description === undefined ? editTarget.description : (values.description as string) || null,
        sort_order: (values.sort_order as number | undefined) ?? editTarget.sort_order,
      });
      appMessage.success("业务类型已更新");
      setEditTarget(null);
      editForm.resetFields();
      setMutationError(null);
      await reload();
    } catch (err) { setMutationError(normalizeError(err)); }
  };

  const columns: ColumnsType<OrderType> = [
    { title: "代码", dataIndex: "code" },
    { title: "名称", dataIndex: "name" },
    {
      title: "零本金",
      dataIndex: "is_zero_principal",
      render: (value: boolean) => (
        <StatusTag status={value ? "ACTIVE" : "DISABLED"} label={value ? "是" : "否"} />
      ),
    },
    {
      title: "启用",
      dataIndex: "is_active",
      render: (value: boolean) => (
        <StatusTag status={value ? "ACTIVE" : "DISABLED"} label={value ? "是" : "否"} />
      ),
    },
    { title: "操作", render: (_v, row) => <PermissionGate permission="order-type.manage"><Space size={2}><PermissionButton permission="order-type.manage" size="small" onClick={() => { setEditTarget(row); editForm.setFieldsValue(row); }}>编辑</PermissionButton><ConfirmButton
              permission="order-type.manage"
              size="small"
              title={row.is_active ? `停用业务类型「${row.name}」` : `启用业务类型「${row.name}」`}
              description={row.is_active
                ? "停用后无法新建该类型订单；已有订单与历史数据不受影响。"
                : "启用后可重新新建该类型订单。"}
              danger={row.is_active}
              onConfirm={() => toggleActive(row)}
            >
              {row.is_active ? "停用" : "启用"}
            </ConfirmButton></Space></PermissionGate> },
  ];

  return (
    <section className="order-types-panel">
      <div className="order-types-panel__actions">
        <PermissionButton permission="order-type.manage" type="primary" disabled={Boolean(error)} onClick={() => { createForm.resetFields(); setCreateOpen(true); }}>
          新建类型
        </PermissionButton>
      </div>
      <ErrorBanner error={error} onRetry={() => void reloadPanel()} retrying={loading} />
      <DataTable<OrderType>
        columns={columns}
        rows={rows}
        loading={loading}
        page={1}
        pageSize={Math.max(rows.length, 10)}
        total={rows.length}
        emptyText={error ? "业务类型数据不可用，请点击重新加载" : "暂无业务类型"}
        onPageChange={() => undefined}
     />
      <PermissionGate
        permission="order-type.manage"
        fallback={<Typography.Paragraph type="secondary">当前角色无主数据维护权限，仅可查看。</Typography.Paragraph>}
      >
        <Typography.Paragraph type="secondary">
          业务类型由后端主数据接口控制；代码创建后不可修改。「零本金」表示该业务不垫付本金（如 DG 代挂），登记本金支出会被拒绝。
        </Typography.Paragraph>
      </PermissionGate>
      <BusinessActionModal
        title="新建业务类型"
        fieldCount={6}
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        okText="创建"
        onOk={() => void createForm.submit()}
      >
        <FieldConfigScope scope="SYSORDER" active={true}><BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} form={createForm} onFinish={create} initialValues={{ sort_order: 0 }}>
          <CfgItem name="code" label="代码" rules={[
            { required: true, message: "请输入类型代码" },
            { pattern: /^[A-Z0-9]{2,10}$/, message: "2-10 位大写字母或数字，创建后不可修改" },
          ]}>
            <Input placeholder="请输入类型代码" maxLength={10} />
          </CfgItem>
          <CfgItem name="name" label="名称" rules={[{ required: true, message: "请输入类型名称" }]}>
            <Input placeholder="例如 新业务" maxLength={64} />
          </CfgItem>
          <CfgItem name="is_zero_principal" label="零本金" valuePropName="checked" extra="勾选后该业务不垫付本金，登记本金支出会被拒绝">
            <Switch checkedChildren="是" unCheckedChildren="否" />
          </CfgItem>
          <CfgItem name="sequence_prefix" label="编号前缀" extra="选填，默认等于代码；订单编号 = 前缀 + 日期 + 序号">
            <Input placeholder="默认同代码" maxLength={16} />
          </CfgItem>
          <CfgItem name="sort_order" label="排序">
            <InputNumber min={0} precision={0} className="ui-control-full" />
          </CfgItem>
          <CfgItem name="description" label="说明">
            <Input.TextArea rows={3} placeholder="选填" />
          </CfgItem>
        </BusinessRegistrationForm></FieldConfigScope>
      </BusinessActionModal>
      <BusinessActionModal title={editTarget ? `编辑业务类型 · ${editTarget.code}` : "编辑业务类型"} fieldCount={5} open={Boolean(editTarget)} onCancel={() => { setEditTarget(null); editForm.resetFields(); }} onOk={() => void editForm.submit()} okText="保存">
        <FieldConfigScope scope="SYSORDER" active={true}><BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} form={editForm} onFinish={update}>
          <Form.Item label="代码"><Input value={editTarget?.code} disabled /></Form.Item>
          <CfgItem name="name" label="名称" rules={[{ required: true }]}><Input /></CfgItem>
          <CfgItem name="is_zero_principal" label="零本金" valuePropName="checked"><Switch checkedChildren="是" unCheckedChildren="否" /></CfgItem>
          <CfgItem name="sort_order" label="排序"><InputNumber min={0} precision={0} className="ui-control-full" /></CfgItem>
          <CfgItem name="description" label="说明"><Input.TextArea rows={3} /></CfgItem>
        </BusinessRegistrationForm></FieldConfigScope>
      </BusinessActionModal>
    </section>
  );
}
