/** 设置：主数据（业务类型 / 资金池）/ 活字段（页面原型 §7）。 */
import { Card, Descriptions, Form, Input, InputNumber, Popconfirm, Select, Switch, Tabs, Typography, message } from "antd";
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
import { errorMessage, normalizeError } from "../shared/api/client";
import {
  DataTable,
  ErrorBanner,
  PermissionButton,
  PermissionGate,
  StatusTag,
} from "../shared/ui";
import { PolicySettingsPanel } from "../policy/PolicySettingsPanel";
import { AppearancePanel } from "../app/AppearancePanel";
import { HistoryWorkbench } from "../history/HistoryWorkbench";
import { UsersPanel } from "../users/UsersPanel";
import { TeamsPanel } from "../users/TeamsPanel";
import { useSession } from "../shared/state/session";
import { CAPITAL_TYPE_LABEL, ENTITY_TYPE_LABEL, FIELD_TYPE_LABEL, POOL_OWNERSHIP_LABEL, POOL_TYPE_LABEL } from "../shared/lib/labels";

export function SettingsPage() {
  const { can } = useSession();
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 960px)");
    if (!media) return undefined;
    const sync = () => setCompact(media.matches);
    sync();
    media.addEventListener?.("change", sync);
    return () => media.removeEventListener?.("change", sync);
  }, []);
  const items = [
    { key: "business-dictionary", label: "业务字典", children: <BusinessDictionaryPanel /> },
    { key: "order-types", label: "业务类型", children: <OrderTypesPanel /> },
    { key: "pools", label: "资金池", children: <PoolsPanel /> },
    { key: "fields", label: "活字段", children: <FieldsPanel /> },
    { key: "policies", label: "经营规则", children: <PolicySettingsPanel /> },
    ...(can("import.manage") ? [{ key: "imports", label: "标准导入", children: <HistoryWorkbench embedded /> }] : []),
    ...(can("user.manage") ? [{ key: "users", label: "人员与权限", children: <UsersPanel /> }, { key: "teams", label: "团队管理", children: <TeamsPanel /> }] : []),
    { key: "appearance", label: "外观", children: <AppearancePanel /> },
  ];
  return (
    <section className="ui-stack">
      <Tabs
        className="settings-tabs"
        tabPosition={compact ? "top" : "left"}
        defaultActiveKey="business-dictionary"
        items={items}
      />
    </section>
  );
}

function BusinessDictionaryPanel() {
  return (
    <Card className="glass" title="业务分类口径">
      <Typography.Paragraph type="secondary">
          活字段只承载客户辅助信息；库存和订单字段由固定业务模型管理，不允许通过活字段覆盖。
      </Typography.Paragraph>
      <Descriptions bordered size="small" column={1}>
        <Descriptions.Item label="业务">
          自营：本方承担资金、库存和利润；分销：向供货方拿货或提号后销售，也可使用本方资金。
        </Descriptions.Item>
        <Descriptions.Item label="类型">
          回收：自营买入账号；提号：分销取得账号；代挂：受委托挂售账号，是否产生资金占用取决于是否垫付。
        </Descriptions.Item>
        <Descriptions.Item label="产品类型">
          游戏类型，是产品的分类，例如王者荣耀、原神。新建订单或账号中的“游戏类型”字段保存此信息；它不是某一个具体账号。
        </Descriptions.Item>
        <Descriptions.Item label="产品">
          具体的游戏账号，是可以进入库存、售卖或交付的产品实例，包含游戏账号、账号密码、渠道/区服等信息。
        </Descriptions.Item>
        <Descriptions.Item label="库存账号">
          产品进入库存后的管理对象；库存中心展示其业务归属、入库类型、产品类型和账号状态，并承接全款或分期付款售卖。
        </Descriptions.Item>
        <Descriptions.Item label="增值服务">
          分期：本方账号售出，买家分期支付售卖款，归自营售出，不单独产生业务编号。代分期：他人账号售出，本方提供代付或分期服务并收取服务收益，归分销业务，生成 DFQ 业务订单号。
        </Descriptions.Item>
        <Descriptions.Item label="分期（自营售出）">
          售出方是本方，账号归本方库存；售出金额属于本方销售收入。买家按期回款，收齐后完成交付；每笔回款都归集到原售出订单及其分期合约。
        </Descriptions.Item>
        <Descriptions.Item label="代分期（分销服务）">
          售出方和账号所有权属于客户/合作方，本方不把账号计入库存或销售收入；创建时生成 DFQ 业务订单号。本方仅代付剩余款项、跟进分期回收，并以服务费、佣金或约定返点确认收益。代付本金与回收款须分别记录，不能混作本方售出收入。
        </Descriptions.Item>
      </Descriptions>
    </Card>
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
    { title: "资金性质", dataIndex: "capital_type", render: (v: string) => CAPITAL_TYPE_LABEL[v] ?? v },
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
    { title: "类型", dataIndex: "pool_type", render: (v: string) => POOL_TYPE_LABEL[v] ?? v },
    { title: "归属", dataIndex: "ownership", render: (v: string) => POOL_OWNERSHIP_LABEL[v] ?? v },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} /> },
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
      <PermissionGate permission="pool.manage">
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
    </Card>
  );
}

const FIELD_TYPE_OPTIONS = Object.entries(FIELD_TYPE_LABEL).map(([value, label]) => ({ value, label }));
const ENTITY_TYPE_OPTIONS = Object.entries(ENTITY_TYPE_LABEL).map(([value, label]) => ({ value, label }));
const OPTION_FIELD_TYPES = ["SELECT", "MULTI_SELECT"];

const parseOptions = (raw: unknown): string[] | undefined => {
  const text = typeof raw === "string" ? raw : "";
  const items = text
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
};

function FieldsPanel() {
  const [rows, setRows] = useState<FieldDefinition[]>([]);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [form] = Form.useForm();
  const fieldType = Form.useWatch("field_type", form);
  const needsOptions = OPTION_FIELD_TYPES.includes(fieldType as string);
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
        options: needsOptions ? parseOptions(values.options) : undefined,
        required: Boolean(values.required),
        sort_order: Number(values.sort_order ?? 0),
      });
      message.success("活字段已创建");
      form.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const columns: ColumnsType<FieldDefinition> = [
    { title: "实体", dataIndex: "entity_type", render: (v: string) => ENTITY_TYPE_LABEL[v] ?? v },
    { title: "字段键", dataIndex: "field_key" },
    { title: "标签", dataIndex: "label" },
    { title: "类型", dataIndex: "field_type", render: (v: string) => FIELD_TYPE_LABEL[v] ?? v },
    {
      title: "必填",
      dataIndex: "required",
      render: (value: boolean) => (value ? "是" : "否"),
    },
    {
      title: "选项",
      dataIndex: "options",
      render: (value: string[] | null | undefined) => (value?.length ? value.join("、") : "-"),
    },
    {
      title: "启用",
      dataIndex: "is_active",
      render: (value: boolean) => (
        <StatusTag status={value ? "ACTIVE" : "DISABLED"} label={value ? "是" : "否"} />
      ),
    },
    {
      title: "操作",
      render: (_v, row) => (
        <PermissionGate permission="field-definition.manage">
          <PermissionButton
            permission="field-definition.manage"
            size="small"
            onClick={async () => {
              await fieldsApi.setActive(row.id, !row.is_active);
              await load();
            }}
          >
            {row.is_active ? "停用" : "启用"}
          </PermissionButton>
          <Popconfirm
            title={`删除字段「${row.label}」`}
            description="无历史值才可删除；已有历史值只能停用（历史值保留）"
            onConfirm={async () => {
              try {
                await fieldsApi.remove(row.id);
                message.success("字段已删除");
                await load();
              } catch (err) {
                setError(normalizeError(err));
              }
            }}
          >
            <PermissionButton permission="field-definition.manage" size="small" danger>
              删除
            </PermissionButton>
          </Popconfirm>
        </PermissionGate>
      ),
    },
  ];

  return (
    <Card className="glass" title="活字段">
      <ErrorBanner error={error} onRetry={() => void load()} />
      <Typography.Paragraph type="secondary">
        活字段仅承载辅助信息，不得覆盖核算字段；有历史值只能停用，无历史值可删除（BAS-04）。
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
          className="ui-form-spaced"
          initialValues={{ entity_type: "customer", field_type: "TEXT", sort_order: 0 }}
        >
          <Form.Item name="entity_type" label="实体">
            <Select options={ENTITY_TYPE_OPTIONS} className="ui-control-width-120" disabled />
          </Form.Item>
          <Form.Item name="field_key" label="字段键" rules={[{ required: true }]}>
            <Input placeholder="小写下划线，如 credit_level" />
          </Form.Item>
          <Form.Item name="label" label="标签" rules={[{ required: true }]}>
            <Input placeholder="页面显示名" />
          </Form.Item>
          <Form.Item name="field_type" label="类型">
            <Select options={FIELD_TYPE_OPTIONS} className="ui-control-width-110" />
          </Form.Item>
          {needsOptions && (
            <Form.Item name="options" label="选项">
              <Input placeholder="逗号分隔，如 优质,观察,黑名单" className="ui-control-width-200" />
            </Form.Item>
          )}
          <Form.Item name="required" label="必填" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="sort_order" label="排序">
            <InputNumber min={0} className="ui-control-width-90" />
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

