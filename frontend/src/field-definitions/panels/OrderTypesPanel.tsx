import { Card, Form, Input, Modal, Select, Typography, message, InputNumber } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { orderTypesApi, type OrderType } from "../../shared/api/catalog";
import { poolsApi, type Pool, type RouteImpactPreview } from "../../shared/api/catalog";
import { normalizeError } from "../../shared/api/client";
import { CAPITAL_TYPE_LABEL } from "../../shared/lib/labels";
import { DataTable, ErrorBanner, PermissionButton, PermissionGate, StatusTag } from "../../shared/ui";

export function OrderTypesPanel() {
  const [rows, setRows] = useState<OrderType[]>([]);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [pools, setPools] = useState<Pool[]>([]);
  const [previewTarget, setPreviewTarget] = useState<OrderType | null>(null);
  const [editTarget, setEditTarget] = useState<OrderType | null>(null);
  const [preview, setPreview] = useState<RouteImpactPreview | null>(null);
  const [previewForm] = Form.useForm();
  const [editForm] = Form.useForm();
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
    try { setPreview(await orderTypesApi.impactPreview(previewTarget.code, values.portion as string, values.pool_code as string)); message.success("已生成路由影响预览"); }
    catch (err) { setError(normalizeError(err)); }
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
    { title: "资金性质", dataIndex: "capital_type", render: (v: string) => CAPITAL_TYPE_LABEL[v] ?? v },
    {
      title: "启用",
      dataIndex: "is_active",
      render: (value: boolean) => (
        <StatusTag status={value ? "ACTIVE" : "DISABLED"} label={value ? "是" : "否"} />
      ),
    },
    { title: "操作", render: (_v, row) => <PermissionGate permission="order-type.manage"><button type="button" className="ui-button ui-button--small" onClick={() => { setEditTarget(row); editForm.setFieldsValue(row); }}>编辑</button><button type="button" className="ui-button ui-button--small" onClick={() => void toggleActive(row)}>{row.is_active ? "停用" : "启用"}</button><button type="button" className="ui-button ui-button--small" onClick={() => { setPreviewTarget(row); setPreview(null); }}>影响预览</button></PermissionGate> },
  ];

  return (
    <Card className="glass" title="业务类型主数据">
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
        fallback={<Typography.Paragraph type="secondary">当前角色无主数据维护权限。</Typography.Paragraph>}
      >
        <Typography.Paragraph type="secondary">
          业务类型的启停由后端主数据接口控制，本页只读展示。
        </Typography.Paragraph>
      </PermissionGate>
      <Modal title={previewTarget ? `${previewTarget.code} 路由影响预览` : "路由影响预览"} open={Boolean(previewTarget)} onCancel={() => setPreviewTarget(null)} footer={null}>
        <Form form={previewForm} layout="vertical" onFinish={runPreview}>
          <Form.Item name="portion" label="资金份额" rules={[{ required: true }]}><Select options={[{ value: "PRINCIPAL", label: "本金" }, { value: "PROFIT", label: "利润" }, { value: "GROSS", label: "总额" }]} /></Form.Item>
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
    </Card>
  );
}
