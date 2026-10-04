/** 设置：主数据（业务类型 / 资金池）/ 活字段（页面原型 §7）。 */
import { Card, Form, Input, Tabs, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import {
  fieldsApi,
  orderTypesApi,
  poolsApi,
  type FieldDefinition,
  type OrderType,
  type Pool,
} from "../shared/api/catalog";
import { errorMessage } from "../shared/api/client";
import {
  DataTable,
  ErrorBanner,
  PageHeader,
  PermissionButton,
  PermissionGate,
  StatusTag,
} from "../shared/ui";
import { PolicySettingsPanel } from "../policy/PolicySettingsPanel";

export function SettingsPage() {
  return (
    <section className="ui-stack">
      <PageHeader
        title="设置"
        description="主数据与活字段：新增业务、账号、客户字段无需改代码（BAS-02 / BAS-04）。"
      />
      <Tabs
        defaultActiveKey="order-types"
        items={[
          { key: "order-types", label: "业务类型", children: <OrderTypesPanel /> },
          { key: "pools", label: "资金池", children: <PoolsPanel /> },
          { key: "fields", label: "活字段", children: <FieldsPanel /> },
        { key: "policies", label: "经营规则", children: <PolicySettingsPanel /> },
        ]}
      />
    </section>
  );
}

function OrderTypesPanel() {
  const [rows, setRows] = useState<OrderType[]>([]);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
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

  const columns: ColumnsType<OrderType> = [
    { title: "代码", dataIndex: "code" },
    { title: "名称", dataIndex: "name" },
    { title: "资金性质", dataIndex: "capital_type" },
    {
      title: "启用",
      dataIndex: "is_active",
      render: (value: boolean) => (
        <StatusTag status={value ? "ACTIVE" : "DISABLED"} label={value ? "是" : "否"} />
      ),
    },
  ];

  return (
    <Card className="glass" title="业务类型主数据">
      <ErrorBanner message={error?.message} code={error?.code} />
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
        fallback={
          <Typography.Paragraph type="secondary">当前角色无主数据维护权限。</Typography.Paragraph>
        }
      >
        <Typography.Paragraph type="secondary">
          业务类型的启停由后端主数据接口控制，本页只读展示。
        </Typography.Paragraph>
      </PermissionGate>
    </Card>
  );
}

function PoolsPanel() {
  const [rows, setRows] = useState<Pool[]>([]);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [form] = Form.useForm();
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

  const columns: ColumnsType<Pool> = [
    { title: "代码", dataIndex: "code" },
    { title: "名称", dataIndex: "name" },
    { title: "类型", dataIndex: "pool_type" },
    { title: "归属", dataIndex: "ownership" },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} /> },
  ];

  return (
    <Card className="glass" title="资金池主数据">
      <ErrorBanner message={error?.message} code={error?.code} />
      <DataTable<Pool>
        columns={columns}
        rows={rows}
        page={1}
        pageSize={Math.max(rows.length, 10)}
        total={rows.length}
        emptyText="暂无资金池"
        onPageChange={() => undefined}
      />
      <PermissionGate permission="pool.manage">
        <Form form={form} layout="inline" onFinish={submit} style={{ marginTop: 16 }}>
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
    </Card>
  );
}

function FieldsPanel() {
  const [rows, setRows] = useState<FieldDefinition[]>([]);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [form] = Form.useForm();
  const load = useCallback(async () => {
    try {
      setRows(await fieldsApi.list());
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
      await fieldsApi.create({
        entity_type: values.entity_type as string,
        field_key: values.field_key as string,
        label: values.label as string,
        field_type: (values.field_type as string) ?? "TEXT",
      });
      message.success("活字段已创建");
      form.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const columns: ColumnsType<FieldDefinition> = [
    { title: "实体", dataIndex: "entity_type" },
    { title: "字段键", dataIndex: "field_key" },
    { title: "标签", dataIndex: "label" },
    { title: "类型", dataIndex: "field_type" },
    {
      title: "启用",
      dataIndex: "is_active",
      render: (value: boolean, row) => (
        <PermissionButton
          permission="field-definition.manage"
          size="small"
          onClick={async () => {
            await fieldsApi.setActive(row.id, !value);
            await load();
          }}
        >
          {value ? "停用" : "启用"}
        </PermissionButton>
      ),
    },
  ];

  return (
    <Card className="glass" title="活字段">
      <ErrorBanner message={error?.message} code={error?.code} />
      <Typography.Paragraph type="secondary">
        活字段仅承载辅助信息，不得覆盖核算字段；有历史值只能停用（BAS-04）。
      </Typography.Paragraph>
      <DataTable<FieldDefinition>
        columns={columns}
        rows={rows}
        page={1}
        pageSize={Math.max(rows.length, 10)}
        total={rows.length}
        emptyText="暂无活字段"
        onPageChange={() => undefined}
      />
      <PermissionGate permission="field-definition.manage">
        <Form
          form={form}
          layout="inline"
          onFinish={submit}
          style={{ marginTop: 16 }}
          initialValues={{ entity_type: "customer", field_type: "TEXT" }}
        >
          <Form.Item name="entity_type">
            <Input placeholder="实体 customer/account/order" />
          </Form.Item>
          <Form.Item name="field_key" rules={[{ required: true }]}>
            <Input placeholder="字段键，小写下划线" />
          </Form.Item>
          <Form.Item name="label" rules={[{ required: true }]}>
            <Input placeholder="标签" />
          </Form.Item>
          <Form.Item>
            <PermissionButton permission="field-definition.manage" type="primary" htmlType="submit">
              新增字段
            </PermissionButton>
          </Form.Item>
        </Form>
      </PermissionGate>
    </Card>
  );
}

function normalizeError(err: unknown): { message: string; code?: string } {
  const detail = (err as { response?: { data?: { detail?: { message?: string; code?: string } } } })
    ?.response?.data?.detail;
  if (detail?.message) return { message: detail.message, code: detail.code };
  return { message: errorMessage(err) };
}
