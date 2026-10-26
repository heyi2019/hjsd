import { Card, Form, Input, Modal, Select, Space, Typography, message, InputNumber } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { orderTypesApi, type OrderType, type OrderTypeRoute } from "../../shared/api/catalog";
import { poolsApi, type Pool, type RouteImpactPreview } from "../../shared/api/catalog";
import { normalizeError } from "../../shared/api/client";
import { CAPITAL_TYPE_LABEL } from "../../shared/lib/labels";
import { configurableLabel, useOptionSet } from "../../shared/lib/optionSets";
import { ConfirmButton, DataTable, ErrorBanner, PermissionButton, PermissionGate, StatusTag } from "../../shared/ui";

const FUND_NATURE_LABEL: Record<string, string> = {
  BUSINESS: "本方经营",
  EXTERNAL: "外部/受托",
  INTERNAL: "内部调拨",
};

const PORTION_LABEL: Record<string, string> = {
  PRINCIPAL: "本金",
  PROFIT: "利润",
  GROSS: "总额",
};

/** 词典未加载/未打桩时的回落值，与改造前硬编码完全一致，保证零行为变化。 */
const CAPITAL_TYPE_FALLBACK = [
  { value: "STOCK", label: CAPITAL_TYPE_LABEL.STOCK },
  { value: "ZERO", label: CAPITAL_TYPE_LABEL.ZERO },
  { value: "CREDIT", label: CAPITAL_TYPE_LABEL.CREDIT },
];
const PORTION_FALLBACK = [
  { value: "PRINCIPAL", label: "本金" },
  { value: "PROFIT", label: "利润" },
  { value: "GROSS", label: "总额" },
];
const FUND_NATURE_FALLBACK = [
  { value: "BUSINESS", label: FUND_NATURE_LABEL.BUSINESS },
  { value: "EXTERNAL", label: FUND_NATURE_LABEL.EXTERNAL },
  { value: "INTERNAL", label: FUND_NATURE_LABEL.INTERNAL },
];

export function OrderTypesPanel() {
  const capitalTypeOptions = useOptionSet("CAPITAL_TYPE") ?? CAPITAL_TYPE_FALLBACK;
  const portionOptions = useOptionSet("ROUTE_PORTION") ?? PORTION_FALLBACK;
  const fundNatureOptions = useOptionSet("ROUTE_FUND_NATURE") ?? FUND_NATURE_FALLBACK;
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
      setRows(await orderTypesApi.list());
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
    try { setPreview(await orderTypesApi.impactPreview(previewTarget.code, values.portion as string, values.pool_code as string, values.fund_nature ? String(values.fund_nature) : undefined)); message.success("已生成路由影响预览"); }
    catch (err) { setError(normalizeError(err)); }
  };

  const create = async (values: Record<string, unknown>) => {
    try {
      await orderTypesApi.create({
        code: String(values.code).trim().toUpperCase(),
        name: String(values.name).trim(),
        capital_type: values.capital_type as string,
        sequence_prefix: values.sequence_prefix ? String(values.sequence_prefix).trim().toUpperCase() : undefined,
        sort_order: Number(values.sort_order ?? 0),
        description: values.description ? String(values.description) : null,
      });
      message.success("业务类型已创建");
      setCreateOpen(false);
      createForm.resetFields();
      await load();
    } catch (err) { message.error(normalizeError(err).message); }
  };

  const openRoutes = async (row: OrderType) => {
    setRouteTarget(row);
    routeForm.resetFields();
    try {
      const list = await orderTypesApi.routes(row.id);
      setRoutes(list ?? []);
    } catch (err) {
      message.error(normalizeError(err).message);
      setRoutes([]);
    }
  };

  const submitRoute = async (values: Record<string, unknown>) => {
    if (!routeTarget) return;
    try {
      await orderTypesApi.setRoute(routeTarget.code, {
        portion: String(values.portion),
        pool_code: String(values.pool_code),
        fund_nature: values.fund_nature ? String(values.fund_nature) : null,
        priority: Number(values.priority ?? 0),
      });
      message.success("资金路由已保存");
      routeForm.resetFields();
      setRoutes(await orderTypesApi.routes(routeTarget.id));
    } catch (err) { message.error(normalizeError(err).message); }
  };

  const update = async (values: Record<string, unknown>) => {
    if (!editTarget) return;
    try {
      await orderTypesApi.update(editTarget.id, {
        name: values.name as string,
        description: (values.description as string) || null,
        sort_order: values.sort_order as number,
      });
      message.success("业务类型已更新");
      setEditTarget(null);
      editForm.resetFields();
      await load();
    } catch (err) { setError(normalizeError(err)); }
  };

  const columns: ColumnsType<OrderType> = [
    { title: "代码", dataIndex: "code" },
    { title: "名称", dataIndex: "name" },
    { title: "资金性质", dataIndex: "capital_type", render: (v: string) => configurableLabel("CAPITAL_TYPE", v, CAPITAL_TYPE_LABEL) },
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
    <Card
      className="glass"
      title="业务类型主数据"
      extra={
        <PermissionButton permission="order-type.manage" type="primary" onClick={() => { createForm.resetFields(); setCreateOpen(true); }}>
          新建类型
        </PermissionButton>
      }
    >
      <ErrorBanner error={error} onRetry={() => void load()} />
      <Typography.Paragraph type="secondary">
        新增业务无需改代码：配置编号前缀与资金路由后即可开单（BAS-02）。
      </Typography.Paragraph>
      <DataTable<OrderType>
        columns={columns}
        rows={rows}
        page={1}
        pageSize={Math.max(rows.length, 10)}
        total={rows.length}
        emptyText="暂无业务类型"
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
      <Modal
        title="新建业务类型"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        okText="创建"
        onOk={() => void createForm.submit()}
      >
        <Form form={createForm} layout="vertical" onFinish={create} initialValues={{ capital_type: "STOCK", sort_order: 0 }}>
          <Form.Item name="code" label="代码" rules={[
            { required: true, message: "请输入类型代码" },
            { pattern: /^[A-Z0-9]{2,10}$/, message: "2-10 位大写字母或数字，创建后不可修改" },
          ]}>
            <Input placeholder="例如 XY" maxLength={10} />
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入类型名称" }]}>
            <Input placeholder="例如 新业务" maxLength={64} />
          </Form.Item>
          <Form.Item name="capital_type" label="资金性质" rules={[{ required: true }]}>
            <Select options={capitalTypeOptions} />
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
        </Form>
      </Modal>
      <Modal title={previewTarget ? `${previewTarget.code} 路由影响预览` : "路由影响预览"} open={Boolean(previewTarget)} onCancel={() => setPreviewTarget(null)} footer={null}>
        <Form form={previewForm} layout="vertical" onFinish={runPreview}>
          <Form.Item name="portion" label="资金份额" rules={[{ required: true }]}><Select options={portionOptions} /></Form.Item>
          <Form.Item name="pool_code" label="目标资金池" rules={[{ required: true }]}><Select options={pools.map((pool) => ({ value: pool.code, label: `${pool.name}（${pool.code}）` }))} /></Form.Item>
          <PermissionButton permission="order-type.manage" type="primary" htmlType="submit">生成预览</PermissionButton>
        </Form>
        {preview ? <Typography.Paragraph><strong>影响结果：</strong>{preview.changed ? "将发生变化" : "无变化"}<br />历史影响：{JSON.stringify(preview.historical_impact)}<br />未来影响：{preview.future_effect}</Typography.Paragraph> : null}
      </Modal>
      <Modal title={editTarget ? `编辑业务类型 · ${editTarget.code}` : "编辑业务类型"} open={Boolean(editTarget)} onCancel={() => { setEditTarget(null); editForm.resetFields(); }} onOk={() => void editForm.submit()} okText="保存">
        <Form form={editForm} layout="vertical" onFinish={update}>
          <Form.Item label="代码"><Input value={editTarget?.code} disabled /></Form.Item>
          <Form.Item label="资金性质"><Input value={editTarget?.capital_type} disabled /></Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="sort_order" label="排序"><InputNumber min={0} precision={0} className="ui-control-full" /></Form.Item>
          <Form.Item name="description" label="说明"><Input.TextArea rows={3} /></Form.Item>
        </Form>
      </Modal>
      <Modal
        title={routeTarget ? `资金路由 · ${routeTarget.code}` : "资金路由"}
        open={Boolean(routeTarget)}
        onCancel={() => { setRouteTarget(null); routeForm.resetFields(); }}
        footer={null}
        width={640}
      >
        <Typography.Paragraph type="secondary">
          路由决定该类型订单的过账去向：按资金份额（本金/利润/总额）与资金性质匹配目标资金池，优先级大者优先。
        </Typography.Paragraph>
        <DataTable<OrderTypeRoute>
          columns={[
            { title: "份额", dataIndex: "portion", render: (v: string) => configurableLabel("ROUTE_PORTION", v, PORTION_LABEL) },
            { title: "资金性质", dataIndex: "fund_nature", render: (v: string | null) => (v ? configurableLabel("ROUTE_FUND_NATURE", v, FUND_NATURE_LABEL) : "不限") },
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
        <Form form={routeForm} layout="vertical" onFinish={submitRoute} initialValues={{ portion: "PRINCIPAL", priority: 0 }}>
          <Form.Item name="portion" label="资金份额" rules={[{ required: true }]}>
            <Select options={portionOptions} />
          </Form.Item>
          <Form.Item name="fund_nature" label="资金性质" extra="选填；不填表示不限性质">
            <Select allowClear placeholder="不限" options={fundNatureOptions} />
          </Form.Item>
          <Form.Item name="pool_code" label="目标资金池" rules={[{ required: true, message: "请选择目标资金池" }]}>
            <Select placeholder="请选择资金池" options={pools.map((pool) => ({ value: pool.code, label: `${pool.name}（${pool.code}）` }))} />
          </Form.Item>
          <Form.Item name="priority" label="优先级" extra="大者优先；同份额同性质只取最高优先级">
            <InputNumber min={0} precision={0} className="ui-control-full" />
          </Form.Item>
          <PermissionButton permission="order-type.manage" type="primary" htmlType="submit">保存路由</PermissionButton>
        </Form>
      </Modal>
    </Card>
  );
}
