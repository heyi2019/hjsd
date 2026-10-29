import { appMessage, appModal } from "../../shared/ui/appFeedback";
/** 资金路由页：跨业务类型一览「订单过账往哪个资金池走」。
 *
 * 存在理由：路由（order_type_pools）此前只嵌在「业务类型」页里，必须逐个类型点「路由」
 * 才能看到去向，无法回答「总额部分现在落到哪个池」这类横向问题。本页把所有类型的路由
 * 摊平到一张表，并提供统一的覆盖入口与影响预览。
 *
 * 口径：路由按（业务类型 + 份额 + 资金性质）唯一，优先级大者优先；资金性质不填表示不限。
 * 份额与资金性质的选项来自选项词典（ROUTE_PORTION / ROUTE_FUND_NATURE），设置页改文案后
 * 本页同步变化。
 */
import { Card, Form, InputNumber, Space, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  orderTypesApi,
  poolsApi,
  type OrderType,
  type OrderTypeRoute,
  type Pool,
  type RouteImpactPreview,
} from "../../shared/api/catalog";
import { normalizeError } from "../../shared/api/client";
import { CAPITAL_TYPE_LABEL } from "../../shared/lib/labels";
import { configurableLabel, useOptionSet } from "../../shared/lib/optionSets";
import { useSession } from "../../shared/state/session";
import { BusinessForm, DataTable, ErrorBanner, PermissionButton, PermissionGate, Select, StatusTag } from "../../shared/ui";

const PORTION_LABEL: Record<string, string> = {
  PRINCIPAL: "本金",
  PROFIT: "利润",
  GROSS: "总额",
};
const FUND_NATURE_LABEL: Record<string, string> = {
  BUSINESS: "本方经营",
  EXTERNAL: "外部/受托",
  INTERNAL: "内部调拨",
};
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

interface RouteRow extends OrderTypeRoute {
  /** 冗余所属类型的展示信息，避免表格里再回查。 */
  typeName: string;
  capitalType: string;
}

export function OrderTypeRoutesPanel() {
  const { can } = useSession();
  const [types, setTypes] = useState<OrderType[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [routes, setRoutes] = useState<RouteRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [filterType, setFilterType] = useState<string>("all");
  const [preview, setPreview] = useState<RouteImpactPreview | null>(null);
  const [form] = Form.useForm();

  const portionOptions = useOptionSet("ROUTE_PORTION") ?? PORTION_FALLBACK;
  const fundNatureOptions = useOptionSet("ROUTE_FUND_NATURE") ?? FUND_NATURE_FALLBACK;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [typeRows, poolRows] = await Promise.all([orderTypesApi.list(), poolsApi.list()]);
      setTypes(typeRows);
      setPools(poolRows);
      // 业务类型是 4 个量级的小集合，逐个拉路由可换来一张横向可比的表；
      // 单个失败不拖垮整页，只丢该类型的路由。
      const perType = await Promise.all(
        typeRows.map(async (type) => {
          try {
            const rows = await orderTypesApi.routes(type.id);
            return rows.map((row) => ({
              ...row,
              typeName: type.name,
              capitalType: type.capital_type,
            }));
          } catch {
            return [] as RouteRow[];
          }
        }),
      );
      setRoutes(perType.flat());
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(
    () => (filterType === "all" ? routes : routes.filter((row) => row.order_type_code === filterType)),
    [routes, filterType],
  );

  const poolOptions = useMemo(
    () => pools.map((pool) => ({ value: pool.code, label: `${pool.name}（${pool.code}）` })),
    [pools],
  );
  const typeOptions = useMemo(
    () => types.map((type) => ({ value: type.code, label: `${type.name}（${type.code}）` })),
    [types],
  );

  const submitRoute = async (values: Record<string, unknown>) => {
    try {
      await orderTypesApi.setRoute(values.order_type_code as string, {
        portion: values.portion as string,
        pool_code: values.pool_code as string,
        fund_nature: values.fund_nature ? (values.fund_nature as string) : null,
        priority: Number(values.priority ?? 0),
      });
      appMessage.success("资金路由已保存");
      form.resetFields();
      setPreview(null);
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const runPreview = async () => {
    const values = form.getFieldsValue();
    if (!values.order_type_code || !values.portion || !values.pool_code) {
      appMessage.warning("请先选择业务类型、资金份额与目标资金池");
      return;
    }
    try {
      setPreview(
        await orderTypesApi.impactPreview(
          values.order_type_code as string,
          values.portion as string,
          values.pool_code as string,
          values.fund_nature ? String(values.fund_nature) : undefined,
        ),
      );
      appMessage.success("已生成影响预览");
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const columns: ColumnsType<RouteRow> = [
    {
      title: "业务类型",
      dataIndex: "order_type_code",
      width: 150,
      render: (code: string, row) => `${row.typeName}（${code}）`,
    },
    {
      title: "资金性质",
      dataIndex: "capitalType",
      width: 110,
      render: (v: string) => configurableLabel("CAPITAL_TYPE", v, CAPITAL_TYPE_LABEL),
    },
    {
      title: "份额",
      dataIndex: "portion",
      width: 90,
      render: (v: string) => configurableLabel("ROUTE_PORTION", v, PORTION_LABEL),
    },
    {
      title: "资金性质",
      dataIndex: "fund_nature",
      width: 120,
      render: (v: string | null) =>
        v ? configurableLabel("ROUTE_FUND_NATURE", v, FUND_NATURE_LABEL) : "不限",
    },
    {
      title: "目标资金池",
      render: (_v, row) => `${row.pool_name}（${row.pool_code}）`,
    },
    { title: "优先级", dataIndex: "priority", width: 80, align: "right" },
    {
      title: "启用",
      dataIndex: "is_active",
      width: 90,
      render: (v: boolean) => <StatusTag status={v ? "ACTIVE" : "DISABLED"} label={v ? "是" : "否"} />,
    },
  ];

  return (
    <div className="ui-stack">
      <ErrorBanner error={error} onRetry={() => void load()} />
      <Card className="glass" title="资金路由一览">
        <Typography.Paragraph type="secondary">
          路由决定各类订单的过账去向：按资金份额（本金/利润/总额）与资金性质匹配目标资金池，优先级大者优先。
          共 {routes.length} 条路由，覆盖 {new Set(routes.map((row) => row.order_type_code)).size} /{" "}
          {types.length} 个业务类型。
        </Typography.Paragraph>
        <Space className="ui-filter-bar" wrap>
          <Select
            value={filterType === "all" ? undefined : filterType}
            placeholder="全部业务类型"
            allowClear
            className="ui-control-width-200"
            onChange={(value) => setFilterType(value ?? "all")}
            options={typeOptions}
          />
        </Space>
        <DataTable<RouteRow>
          columns={columns}
          rows={visible}
          page={1}
          pageSize={Math.max(visible.length, 10)}
          total={visible.length}
          loading={loading}
          emptyText="暂无资金路由"
          onPageChange={() => undefined}
       />
      </Card>
      <PermissionGate
        permission="order-type.manage"
        fallback={
          <Card className="glass" title="覆盖资金路由">
            <Typography.Paragraph type="secondary">当前角色无业务类型维护权限，仅可查看。</Typography.Paragraph>
          </Card>
        }
      >
        <Card className="glass" title="覆盖资金路由">
          <BusinessForm
            form={form}
            layout="vertical"
            onFinish={submitRoute}
            initialValues={{ portion: "PRINCIPAL", priority: 0 }}
          >
            <Form.Item name="order_type_code" label="业务类型" rules={[{ required: true, message: "请选择业务类型" }]}>
              <Select placeholder="请选择业务类型" options={typeOptions} />
            </Form.Item>
            <Form.Item name="portion" label="资金份额" rules={[{ required: true }]}>
              <Select options={portionOptions} />
            </Form.Item>
            <Form.Item name="fund_nature" label="资金性质" extra="选填；不填表示不限性质">
              <Select allowClear placeholder="不限" options={fundNatureOptions} />
            </Form.Item>
            <Form.Item name="pool_code" label="目标资金池" rules={[{ required: true, message: "请选择目标资金池" }]}>
              <Select placeholder="请选择资金池" options={poolOptions} />
            </Form.Item>
            <Form.Item name="priority" label="优先级" extra="同一类型内数字大者优先">
              <InputNumber min={0} precision={0} />
            </Form.Item>
            <Space wrap>
              <PermissionButton permission="order-type.manage" type="primary" htmlType="submit">
                保存路由
              </PermissionButton>
              <PermissionButton permission="order-type.manage" onClick={() => void runPreview()}>
                影响预览
              </PermissionButton>
            </Space>
          </BusinessForm>
          {preview ? (
            <Typography.Paragraph className="ui-form-spaced">
              <strong>影响结果：</strong>
              {preview.changed ? "将发生变化" : "无变化"}
              <br />
              历史影响：{JSON.stringify(preview.historical_impact)}
              <br />
              未来影响：{preview.future_effect}
            </Typography.Paragraph>
          ) : null}
        </Card>
      </PermissionGate>
    </div>
  );
}
