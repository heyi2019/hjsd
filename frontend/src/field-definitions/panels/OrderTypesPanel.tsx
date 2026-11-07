import { appMessage } from "../../shared/ui/appFeedback";
import { Form, Input, Space, Typography, InputNumber } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { orderTypesApi, type OrderType, type OrderTypeRoute } from "../../shared/api/catalog";
import { poolsApi, type Pool, type RouteImpactPreview } from "../../shared/api/catalog";
import { normalizeError } from "../../shared/api/client";
import { configurableLabel, useOptionSet } from "../../shared/lib/optionSets";
import { filterRetiredOrderTypes } from "../../shared/lib/retiredProducts";
import { BusinessActionModal, CompactActions, BusinessRegistrationForm, ConfirmButton, DataTable, ErrorBanner, PermissionButton, PermissionGate, Select, StatusTag } from "../../shared/ui";

const PORTION_LABEL: Record<string, string> = {
  PRINCIPAL: "本金",
  PROFIT: "利润",
  GROSS: "总额",
};

const PORTION_FALLBACK = [
  { value: "PRINCIPAL", label: "本金" },
  { value: "PROFIT", label: "利润" },
  { value: "GROSS", label: "总额" },
];

export function OrderTypesPanel() {
  const portionOptions = useOptionSet("ROUTE_PORTION") ?? PORTION_FALLBACK;
  const [rows, setRows] = useState<OrderType[]>([]);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [pools, setPools] = useState<Pool[]>([]);
  const [previewTarget, setPreviewTarget] = useState<OrderType | null>(null);
  const [editTarget, setEditTarget] = useState<OrderType | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [routeTarget, setRouteTarget] = useState<OrderType | null>(null);
  const [routes, setRoutes] = useState<OrderTypeRoute[]>([]);
  const [preview, setPreview] = useState<RouteImpactPreview | null>(null);
  const [previewForm] = Form.useForm();
  const [editForm] = Form.useForm();
  const [createForm] = Form.useForm();
  const [routeForm] = Form.useForm();
  const load = useCallback(async () => {
    try {
      setRows(filterRetiredOrderTypes(await orderTypesApi.list()));
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => { poolsApi.list().then(setPools).catch(() => setPools([])); }, []);

  const toggleActive = async (row: OrderType) => {
    try { await orderTypesApi.setActive(row.id, !row.is_active); await load(); }
    catch (err) { setError(normalizeError(err)); }
  };

  const runPreview = async (values: Record<string, unknown>) => {
    if (!previewTarget) return;
    try { setPreview(await orderTypesApi.impactPreview(previewTarget.code, values.portion as string, values.pool_code as string)); appMessage.success("已生成路由影响预览"); }
    catch (err) { setError(normalizeError(err)); }
  };

  const create = async (values: Record<string, unknown>) => {
    try {
      await orderTypesApi.create({
        code: String(values.code).trim().toUpperCase(),
        name: String(values.name).trim(),
        sequence_prefix: values.sequence_prefix ? String(values.sequence_prefix).trim().toUpperCase() : undefined,
        sort_order: Number(values.sort_order ?? 0),
        description: values.description ? String(values.description) : null,
      });
      appMessage.success("业务类型已创建");
      setCreateOpen(false);
      createForm.resetFields();
      await load();
    } catch (err) { appMessage.error(normalizeError(err).message); }
  };

  const openRoutes = async (row: OrderType) => {
    setRouteTarget(row);
    routeForm.resetFields();
    try {
      const list = await orderTypesApi.routes(row.id);
      setRoutes(list ?? []);
    } catch (err) {
      appMessage.error(normalizeError(err).message);
      setRoutes([]);
    }
  };

  const submitRoute = async (values: Record<string, unknown>) => {
    if (!routeTarget) return;
    try {
      await orderTypesApi.setRoute(routeTarget.code, {
        portion: String(values.portion),
        pool_code: String(values.pool_code),
        priority: Number(values.priority ?? 0),
      });
      appMessage.success("资金路由已保存");
      routeForm.resetFields();
      setRoutes(await orderTypesApi.routes(routeTarget.id));
    } catch (err) { appMessage.error(normalizeError(err).message); }
  };

  const update = async (values: Record<string, unknown>) => {
    if (!editTarget) return;
    try {
      await orderTypesApi.update(editTarget.id, {
        name: values.name as string,
        description: (values.description as string) || null,
        sort_order: values.sort_order as number,
      });
      appMessage.success("业务类型已更新");
      setEditTarget(null);
      editForm.resetFields();
      await load();
    } catch (err) { setError(normalizeError(err)); }
  };

  const columns: ColumnsType<OrderType> = [
    { title: "代码", dataIndex: "code" },
    { title: "名称", dataIndex: "name" },
    {
      title: "启用",
      dataIndex: "is_active",
      render: (value: boolean) => (
        <StatusTag status={value ? "ACTIVE" : "DISABLED"} label={value ? "是" : "否"} />
      ),
    },
    { title: "操作", render: (_v, row) => <PermissionGate permission="order-type.manage"><Space size={2}><PermissionButton permission="order-type.manage" size="small" onClick={() => { setEditTarget(row); editForm.setFieldsValue(row); }}>编辑</PermissionButton><PermissionButton permission="order-type.manage" size="small" onClick={() => void openRoutes(row)}>路由</PermissionButton><ConfirmButton
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
            </ConfirmButton><PermissionButton permission="order-type.manage" size="small" onClick={() => { setPreviewTarget(row); setPreview(null); }}>影响预览</PermissionButton></Space></PermissionGate> },
  ];

  return (
    <section className="order-types-panel">
      <div className="order-types-panel__actions">
        <PermissionButton permission="order-type.manage" type="primary" disabled={Boolean(error)} onClick={() => { createForm.resetFields(); setCreateOpen(true); }}>
          新建类型
        </PermissionButton>
      </div>
      <ErrorBanner error={error} onRetry={() => void load()} />
      <DataTable<OrderType>
        columns={columns}
        rows={rows}
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
          业务类型与资金路由由后端主数据接口控制；代码创建后不可修改，路由按「份额 → 资金池」配置。
        </Typography.Paragraph>
      </PermissionGate>
      <BusinessActionModal
        title="新建业务类型"
        fieldCount={5}
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        okText="创建"
        onOk={() => void createForm.submit()}
      >
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} form={createForm} onFinish={create} initialValues={{ sort_order: 0 }}>
          <Form.Item name="code" label="代码" rules={[
            { required: true, message: "请输入类型代码" },
            { pattern: /^[A-Z0-9]{2,10}$/, message: "2-10 位大写字母或数字，创建后不可修改" },
          ]}>
            <Input placeholder="例如 XY" maxLength={10} />
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入类型名称" }]}>
            <Input placeholder="例如 新业务" maxLength={64} />
          </Form.Item>
          <Form.Item name="sequence_prefix" label="编号前缀" extra="选填，默认等于代码；订单编号 = 前缀 + 日期 + 序号">
            <Input placeholder="默认同代码" maxLength={16} />
          </Form.Item>
          <Form.Item name="sort_order" label="排序">
            <InputNumber min={0} precision={0} className="ui-control-full" />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <Input.TextArea rows={3} placeholder="选填" />
          </Form.Item>
        </BusinessRegistrationForm>
      </BusinessActionModal>
      <BusinessActionModal size="compact" title={previewTarget ? `${previewTarget.code} 路由影响预览` : "路由影响预览"} open={Boolean(previewTarget)} onCancel={() => setPreviewTarget(null)} footer={null}>
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} form={previewForm} onFinish={runPreview}>
          <Form.Item name="portion" label="资金份额" rules={[{ required: true }]}><Select options={portionOptions} /></Form.Item>
          <Form.Item name="pool_code" label="目标资金池" rules={[{ required: true }]}><Select options={pools.map((pool) => ({ value: pool.code, label: `${pool.name}（${pool.code}）` }))} /></Form.Item>
          <CompactActions>
            <PermissionButton permission="order-type.manage" type="primary" htmlType="submit">生成预览</PermissionButton>
          </CompactActions>
        </BusinessRegistrationForm>
        {preview ? <Typography.Paragraph><strong>影响结果：</strong>{preview.changed ? "将发生变化" : "无变化"}<br />历史影响：{JSON.stringify(preview.historical_impact)}<br />未来影响：{preview.future_effect}</Typography.Paragraph> : null}
      </BusinessActionModal>
      <BusinessActionModal title={editTarget ? `编辑业务类型 · ${editTarget.code}` : "编辑业务类型"} fieldCount={4} open={Boolean(editTarget)} onCancel={() => { setEditTarget(null); editForm.resetFields(); }} onOk={() => void editForm.submit()} okText="保存">
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} form={editForm} onFinish={update}>
          <Form.Item label="代码"><Input value={editTarget?.code} disabled /></Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="sort_order" label="排序"><InputNumber min={0} precision={0} className="ui-control-full" /></Form.Item>
          <Form.Item name="description" label="说明"><Input.TextArea rows={3} /></Form.Item>
        </BusinessRegistrationForm>
      </BusinessActionModal>
      <BusinessActionModal
        title={routeTarget ? `资金路由 · ${routeTarget.code}` : "资金路由"}
        open={Boolean(routeTarget)}
        onCancel={() => { setRouteTarget(null); routeForm.resetFields(); }}
        footer={null}
        width={640}
      >
        <Typography.Paragraph type="secondary">
          路由决定该类型订单的过账去向：按资金份额（本金/利润/总额）匹配目标资金池，优先级大者优先。
        </Typography.Paragraph>
        <DataTable<OrderTypeRoute>
          columns={[
            { title: "份额", dataIndex: "portion", render: (v: string) => configurableLabel("ROUTE_PORTION", v, PORTION_LABEL) },
            { title: "目标资金池", render: (_v, row) => `${row.pool_name}（${row.pool_code}）` },
            { title: "优先级", dataIndex: "priority" },
            { title: "启用", dataIndex: "is_active", render: (v: boolean) => <StatusTag status={v ? "ACTIVE" : "DISABLED"} label={v ? "是" : "否"} /> },
          ]}
          rows={routes}
          page={1}
          pageSize={Math.max(routes.length, 5)}
          total={routes.length}
          emptyText="暂无路由配置"
          onPageChange={() => undefined}
       />
        <Typography.Paragraph strong className="ui-form-spaced">新增 / 覆盖路由</Typography.Paragraph>
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} form={routeForm} onFinish={submitRoute} initialValues={{ portion: "PRINCIPAL", priority: 0 }}>
          <Form.Item name="portion" label="资金份额" rules={[{ required: true }]}>
            <Select options={portionOptions} />
          </Form.Item>
          <Form.Item name="pool_code" label="目标资金池" rules={[{ required: true, message: "请选择目标资金池" }]}>
            <Select placeholder="请选择资金池" options={pools.map((pool) => ({ value: pool.code, label: `${pool.name}（${pool.code}）` }))} />
          </Form.Item>
          <Form.Item name="priority" label="优先级" extra="大者优先；同份额只取最高优先级">
            <InputNumber min={0} precision={0} className="ui-control-full" />
          </Form.Item>
          <PermissionButton permission="order-type.manage" type="primary" htmlType="submit">保存路由</PermissionButton>
        </BusinessRegistrationForm>
      </BusinessActionModal>
    </section>
  );
}
