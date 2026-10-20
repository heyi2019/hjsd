/** 客户中心：客户档案与订单参与关系；合作方单独 Tab，不与客户混用（CUS-01 / A11）。
 *  活字段（BAS-04）：字段定义来自设置页，建档/编辑表单与详情抽屉按定义动态渲染。 */
import { Card, DatePicker, Descriptions, Drawer, Form, Input, InputNumber, Modal, Select, Space, Spin, Switch, Tabs, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import {
  counterpartiesApi,
  customersApi,
  fieldsApi,
  type Counterparty,
  type Customer,
  type CustomerBusiness,
  type CustomerDetail,
  type CustomerInstallment,
  type FieldDefinition,
} from "../shared/api/catalog";
import { errorMessage, normalizeError } from "../shared/api/client";
import { money, today } from "../shared/lib/format";
import { COUNTERPARTY_TYPE_LABEL, orderTypeLabel } from "../shared/lib/labels";
import { CustomerLeadPanel } from "./CustomerLeadPanel";
import "./CustomersPage.css";
import {
  DataTable,
  ErrorBanner,
  ConfirmButton,
  PermissionButton,
  PermissionGate,
  StatRow,
  StatusTag,
} from "../shared/ui";

/** 活字段值展示：数组用「、」连接，布尔转是/否，空值回落占位。 */
function formatExtraValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (Array.isArray(value)) return value.map((item) => String(item)).join("、");
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value);
}

function customerDateKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function customerStatusLabel(status: string): string | undefined {
  return status === "DISABLED" ? "已拉黑" : undefined;
}

function MobileCustomerList(props: {
  rows: Customer[];
  onDetail: (row: Customer) => void;
  onMerge: (row: Customer) => void;
  onDisable: (row: Customer) => void;
}) {
  if (!props.rows.length) return <div className="customers-mobile-empty muted">暂无客户档案</div>;
  return (
    <div className="customers-mobile-list" aria-label="客户列表">
      {props.rows.map((row) => (
        <article className="customers-mobile-card" key={row.id}>
          <div className="customers-mobile-card__topline"><strong>{row.customer_no} · {row.display_name}</strong><StatusTag status={row.status} label={customerStatusLabel(row.status)} /></div>
          <dl><div><dt>联系人</dt><dd>{row.contact_name || "-"}</dd></div><div><dt>手机</dt><dd>{row.phone || "-"}</dd></div></dl>
          <Space size="small">
            <PermissionButton permission="customer.read" size="small" onClick={() => props.onDetail(row)}>详情</PermissionButton>
            <PermissionButton permission="customer.merge" size="small" disabled={row.status !== "ACTIVE"} onClick={() => props.onMerge(row)}>合并</PermissionButton>
            <PermissionButton permission="customer.update" size="small" onClick={() => props.onDisable(row)}>{row.status === "ACTIVE" ? "拉黑" : "解除拉黑"}</PermissionButton>
          </Space>
        </article>
      ))}
    </div>
  );
}

function MobileCounterpartyList(props: {
  rows: Counterparty[];
  onDetail: (row: Counterparty) => void;
  onEdit: (row: Counterparty) => void;
  onToggle: (row: Counterparty) => void;
}) {
  if (!props.rows.length) return <div className="customers-mobile-empty muted">暂无合作方</div>;
  return (
    <div className="customers-mobile-list" aria-label="合作方列表">
      {props.rows.map((row) => (
        <article className="customers-mobile-card" key={row.id}>
          <div className="customers-mobile-card__topline"><strong>{row.counterparty_no} · {row.display_name}</strong><StatusTag status={row.status} label={row.status === "DISABLED" ? "已拉黑" : undefined} /></div>
          <dl><div><dt>类型</dt><dd>{COUNTERPARTY_TYPE_LABEL[row.type] ?? row.type}</dd></div><div><dt>联系人</dt><dd>{row.contact_name || "-"}</dd></div></dl>
          <Space size="small">
            <PermissionButton permission="counterparty.read" size="small" onClick={() => props.onDetail(row)}>详情</PermissionButton>
            <PermissionButton permission="counterparty.manage" size="small" disabled={row.status !== "ACTIVE"} onClick={() => props.onEdit(row)}>编辑</PermissionButton>
            <PermissionButton permission="counterparty.manage" size="small" onClick={() => props.onToggle(row)}>{row.status === "ACTIVE" ? "拉黑" : "解除拉黑"}</PermissionButton>
          </Space>
        </article>
      ))}
    </div>
  );
}

function useCompactLayout() {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 640px)");
    if (!media) return undefined;
    const sync = () => setCompact(media.matches);
    sync();
    media.addEventListener?.("change", sync);
    return () => media.removeEventListener?.("change", sync);
  }, []);
  return compact;
}

/** DatePicker 值是 dayjs 对象；不引入 dayjs 依赖，按鸭子类型取 format。 */
function toDateText(value: unknown): string | null {
  const candidate = value as { format?: (pattern: string) => string } | null;
  if (candidate && typeof candidate.format === "function") {
    return candidate.format("YYYY-MM-DD");
  }
  return typeof value === "string" ? value : null;
}

/** 从表单值里收集活字段：跳过空值，日期统一转 YYYY-MM-DD 字符串。 */
function collectExtras(
  values: Record<string, unknown>,
  defs: FieldDefinition[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const def of defs) {
    const raw = values[def.field_key];
    if (raw === undefined || raw === null || raw === "") continue;
    if (Array.isArray(raw) && raw.length === 0) continue;
    out[def.field_key] = def.field_type === "DATE" ? toDateText(raw) : raw;
  }
  return out;
}

/** 按字段类型渲染表单控件（BAS-04：类型由字段定义决定）。
 *  必须透传 Form.Item 注入的 id / value / onChange：包装组件若吞掉这些 props，
 *  标签的 htmlFor 会指向不存在的 id（a11y 断链），且表单值收集为空。 */
function ExtraFieldControl({ def, ...controlProps }: { def: FieldDefinition; [key: string]: unknown }) {
  const options = (def.options ?? []).map((option) => ({ value: option, label: option }));
  switch (def.field_type) {
    case "NUMBER":
      return <InputNumber {...controlProps} className="ui-control-full" />;
    case "DATE":
      return <DatePicker {...controlProps} className="ui-control-full" />;
    case "BOOLEAN":
      return <Switch {...controlProps} />;
    case "SELECT":
      return <Select {...controlProps} allowClear options={options} />;
    case "MULTI_SELECT":
      return <Select {...controlProps} mode="multiple" options={options} />;
    default:
      return <Input {...controlProps} />;
  }
}

export function CustomersPage() {
  return (
    <section className="ui-stack">
      <Tabs
        defaultActiveKey="customers"
        items={[
          { key: "customers", label: "客户档案", children: <CustomerPanel /> },
          { key: "counterparties", label: "合作方（同行/供货方/平台）", children: <CounterpartyPanel /> },
          { key: "leads", label: "客户需求池", children: <CustomerLeadPanel /> },
        ]}
      />
    </section>
  );
}

function CustomerPanel() {
  const compact = useCompactLayout();
  const [rows, setRows] = useState<Customer[]>([]);
  const [fieldDefs, setFieldDefs] = useState<FieldDefinition[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Customer | null>(null);
  const [detailTarget, setDetailTarget] = useState<Customer | null>(null);
  const [mergeTarget, setMergeTarget] = useState<Customer | null>(null);
  const [detailData, setDetailData] = useState<CustomerDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [searchInput, setSearchInput] = useState("");
  const [keyword, setKeyword] = useState("");
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const [mergeForm] = Form.useForm();

  const activeDefs = fieldDefs.filter((def) => def.is_active);
  const labelOfKey = useCallback(
    (key: string) => fieldDefs.find((def) => def.field_key === key)?.label ?? key,
    [fieldDefs],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await customersApi.list({
        ...(keyword.trim() ? { keyword: keyword.trim() } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
      }));
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, [keyword, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // 活字段定义加载失败不阻断客户页：字段是辅助信息，静默降级为空
    fieldsApi
      .list({ entity_type: "customer" })
      .then(setFieldDefs)
      .catch(() => setFieldDefs([]));
  }, []);

  const openDetail = async (row: Customer) => {
    setDetailTarget(row);
    setDetailData(null);
    setDetailLoading(true);
    try {
      setDetailData(await customersApi.detail(row.id));
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setDetailLoading(false);
    }
  };

  const submitCreate = async (values: Record<string, unknown>) => {
    try {
      const extraValues = collectExtras(values, activeDefs);
      const result = await customersApi.create({
        display_name: values.display_name as string,
        contact_name: values.contact_name as string,
        phone: values.phone as string,
        wechat: values.wechat as string,
        qq: values.qq as string,
        note: (values.note as string) || null,
        extra_values: Object.keys(extraValues).length > 0 ? extraValues : undefined,
      });
      if (result.duplicate_candidates.length > 0) {
        message.warning(`已建档，检测到 ${result.duplicate_candidates.length} 条重复候选（未拦截）`);
      } else {
        message.success("客户已建档");
      }
      setCreateOpen(false);
      form.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const submitEdit = async (values: Record<string, unknown>) => {
    if (!editTarget) return;
    try {
      const extraValues = collectExtras(values, activeDefs);
      await customersApi.patch(editTarget.id, {
        display_name: values.display_name as string,
        contact_name: values.contact_name as string,
        phone: values.phone as string,
        wechat: values.wechat as string,
        qq: values.qq as string,
        note: (values.note as string) || null,
        extra_values: extraValues,
      });
      message.success("客户已更新");
      setEditTarget(null);
      editForm.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const submitMerge = async (values: Record<string, unknown>) => {
    if (!mergeTarget) return;
    try {
      await customersApi.merge(
        mergeTarget.id,
        Number(values.target_customer_id),
        values.reason as string,
      );
      message.success("合并完成，来源客户已置 MERGED 并迁移关联关系");
      setMergeTarget(null);
      mergeForm.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const columns: ColumnsType<Customer> = [
    { title: "客户编号", dataIndex: "customer_no" },
    { title: "名字", dataIndex: "display_name" },
    { title: "手机", dataIndex: "phone" },
    { title: "微信", dataIndex: "wechat" },
    { title: "QQ", dataIndex: "qq" },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} label={customerStatusLabel(v)} /> },
    {
      title: "活字段",
      key: "extra_values",
      render: (_v, row) => {
        const entries = Object.entries(row.extra_values ?? {}).filter(
          ([, value]) =>
            value !== null &&
            value !== undefined &&
            value !== "" &&
            !(Array.isArray(value) && value.length === 0),
        );
        if (entries.length === 0) return "-";
        const shown = entries
          .slice(0, 2)
          .map(([key, value]) => `${labelOfKey(key)}：${formatExtraValue(value)}`);
        return entries.length > 2 ? `${shown.join("；")} 等 ${entries.length} 项` : shown.join("；");
      },
    },
    {
      title: "操作",
      render: (_v, row) => (
        <Space>
          <PermissionButton permission="customer.read" size="small" onClick={() => void openDetail(row)}>
            详情
          </PermissionButton>
          <PermissionButton
            permission="customer.merge"
            size="small"
            disabled={row.status !== "ACTIVE"}
            onClick={() => setMergeTarget(row)}
          >
            合并
          </PermissionButton>
          <ConfirmButton
            permission="customer.update"
            size="small"
            title={row.status === "ACTIVE" ? "拉黑该客户" : "解除拉黑"}
            description={row.status === "ACTIVE"
              ? "拉黑后不可作为新订单参与方；历史订单、分期与需求保留。"
              : "解除后可重新作为新订单参与方。"}
            danger={row.status === "ACTIVE"}
            onConfirm={async () => {
              await customersApi.setStatus(row.id, row.status === "ACTIVE" ? "DISABLED" : "ACTIVE");
              message.success(row.status === "ACTIVE" ? "客户已拉黑，历史关系保留" : "客户已解除拉黑");
              await load();
            }}
          >
            {row.status === "ACTIVE" ? "拉黑" : "解除拉黑"}
          </ConfirmButton>
        </Space>
      ),
    },
  ];

  const currentDate = today();
  const newThisMonthCount = rows.filter((row) => customerDateKey(row.created_at)?.startsWith(currentDate.slice(0, 7))).length;
  const newTodayCount = rows.filter((row) => customerDateKey(row.created_at) === currentDate).length;

  return (
    <Card
      className="glass"
      title="客户档案"
      extra={
        <PermissionButton permission="customer.create" type="primary" onClick={() => setCreateOpen(true)}>
          新建客户
        </PermissionButton>
      }
    >
      <ErrorBanner error={error} onRetry={() => void load()} />
      <Typography.Paragraph type="secondary">
        联系方式默认脱敏；完整联系方式按权限展示并记录读取审计。拉黑/已合并客户不可作为新订单参与方。
      </Typography.Paragraph>
      <StatRow
        items={[
          { label: "客户总数", kind: "count", amount: String(rows.length) },
          { label: "本月新增客户数", kind: "count", amount: String(newThisMonthCount) },
          { label: "今日新增客户数", kind: "count", amount: String(newTodayCount) },
        ]}
      />
      <Space wrap className="customer-list-filters customer-list-filters--separated">
        <Input.Search
          aria-label="搜索客户"
          value={searchInput}
          allowClear
          placeholder="搜索客户编号 / 名字 / 手机 / 微信 / QQ"
          onChange={(event) => {
            setSearchInput(event.target.value);
            if (!event.target.value) {
              setKeyword("");
              setPage(1);
            }
          }}
          onSearch={(value) => {
            setKeyword(value);
            setPage(1);
          }}
        />
        <Select
          aria-label="客户状态"
          allowClear
          placeholder="全部状态"
          value={statusFilter}
          options={[
            { value: "ACTIVE", label: "启用中" },
            { value: "DISABLED", label: "已拉黑" },
            { value: "MERGED", label: "已合并" },
          ]}
          onChange={(value) => {
            setStatusFilter(value);
            setPage(1);
          }}
        />
      </Space>
      {!compact ? <DataTable<Customer>
        columns={columns}
        rows={rows}
        loading={loading}
        page={page}
        pageSize={pageSize}
        total={rows.length}
        className="customer-table"
        scroll={{ x: "max-content" }}
        emptyText="暂无客户档案"
        onPageChange={(nextPage, nextSize) => {
          setPage(nextPage);
          setPageSize(nextSize);
        }}
      /> : <MobileCustomerList
        rows={rows}
        onDetail={(row) => void openDetail(row)}
        onMerge={setMergeTarget}
        onDisable={async (row) => {
          await customersApi.setStatus(row.id, row.status === "ACTIVE" ? "DISABLED" : "ACTIVE");
          message.success(row.status === "ACTIVE" ? "客户已拉黑，历史关系保留" : "客户已解除拉黑");
          await load();
        }}
      />}

      <Modal title="新建客户" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null}>
        <Form form={form} layout="vertical" colon={false} className="form-no-colon" onFinish={submitCreate}>
          <Form.Item name="display_name" label="名字" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          {/* 短字段两列一行，压弹窗高度（称呼为必填主字段保持整行） */}
          <div className="form-cols-2">
            <Form.Item name="contact_name" label="联系人姓名">
              <Input />
            </Form.Item>
            <Form.Item name="phone" label="手机号">
              <Input />
            </Form.Item>
            <Form.Item name="wechat" label="微信号">
              <Input />
            </Form.Item>
            <Form.Item name="qq" label="QQ">
              <Input />
            </Form.Item>
          </div>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={3} placeholder="选填：客户来源、偏好、注意事项等" />
          </Form.Item>
          {activeDefs.map((def) => (
            <Form.Item
              key={def.field_key}
              name={def.field_key}
              label={def.label}
              valuePropName={def.field_type === "BOOLEAN" ? "checked" : "value"}
              rules={def.required ? [{ required: true, message: `请填写${def.label}` }] : []}
            >
              <ExtraFieldControl def={def} />
            </Form.Item>
          ))}
          <Typography.Paragraph type="secondary">
            联系方式允许重复；重复只提示候选，不拦截建档。活字段在设置页维护，可随时增删。
          </Typography.Paragraph>
          <PermissionButton permission="customer.create" type="primary" htmlType="submit">
            建档
          </PermissionButton>
        </Form>
      </Modal>

      <Modal
        title={editTarget ? `编辑客户 · ${editTarget.customer_no}` : "编辑客户"}
        open={Boolean(editTarget)}
        onCancel={() => {
          setEditTarget(null);
          editForm.resetFields();
        }}
        footer={null}
        destroyOnHidden
      >
        <Form
          form={editForm}
          layout="vertical"
          colon={false}
          className="form-no-colon"
          onFinish={submitEdit}
          initialValues={
            editTarget
              ? {
                  display_name: editTarget.display_name,
                  contact_name: editTarget.contact_name ?? "",
                  phone: editTarget.phone ?? "",
                  wechat: editTarget.wechat ?? "",
                  qq: editTarget.qq ?? "",
                  note: editTarget.note ?? "",
                  ...Object.fromEntries(
                    activeDefs.map((def) => [def.field_key, editTarget.extra_values?.[def.field_key]]),
                  ),
                }
              : undefined
          }
        >
          <Form.Item name="display_name" label="名字" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <div className="form-cols-2">
            <Form.Item name="contact_name" label="联系人姓名">
              <Input />
            </Form.Item>
            <Form.Item name="phone" label="手机号">
              <Input />
            </Form.Item>
            <Form.Item name="wechat" label="微信号">
              <Input />
            </Form.Item>
            <Form.Item name="qq" label="QQ">
              <Input />
            </Form.Item>
          </div>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={3} />
          </Form.Item>
          {activeDefs.map((def) => (
            <Form.Item
              key={def.field_key}
              name={def.field_key}
              label={def.label}
              valuePropName={def.field_type === "BOOLEAN" ? "checked" : "value"}
              rules={def.required ? [{ required: true, message: `请填写${def.label}` }] : []}
            >
              <ExtraFieldControl def={def} />
            </Form.Item>
          ))}
          <PermissionButton permission="customer.update" type="primary" htmlType="submit">
            保存
          </PermissionButton>
        </Form>
      </Modal>

      <Drawer
        title={detailTarget ? `客户档案 · ${detailTarget.customer_no}` : "客户档案"}
        open={Boolean(detailTarget)}
        onClose={() => {
          setDetailTarget(null);
          setDetailData(null);
        }}
        width={720}
        destroyOnHidden
        extra={
          detailTarget && detailTarget.status === "ACTIVE" ? (
            <PermissionButton
              permission="customer.update"
              size="small"
              onClick={() => {
                setEditTarget(detailTarget);
                setDetailTarget(null);
              }}
            >
              编辑
            </PermissionButton>
          ) : null
        }
      >
        {detailLoading ? (
          <div role="status" aria-label="正在加载客户详情"><Spin /></div>
        ) : detailTarget ? (
          <>
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label="客户编号">{detailTarget.customer_no}</Descriptions.Item>
              <Descriptions.Item label="名字">{detailTarget.display_name}</Descriptions.Item>
              <Descriptions.Item label="联系人">{detailTarget.contact_name || "-"}</Descriptions.Item>
              <Descriptions.Item label="手机">{detailTarget.phone || "-"}</Descriptions.Item>
              <Descriptions.Item label="微信">{detailTarget.wechat || "-"}</Descriptions.Item>
              <Descriptions.Item label="QQ">{detailTarget.qq || "-"}</Descriptions.Item>
              <Descriptions.Item label="状态">
                <StatusTag status={detailTarget.status} />
              </Descriptions.Item>
              <Descriptions.Item label="备注">{detailTarget.note || "-"}</Descriptions.Item>
            </Descriptions>
            <Typography.Title level={5} className="ui-title-spaced">
              活字段
            </Typography.Title>
            {fieldDefs.length === 0 ? (
              <Typography.Paragraph type="secondary">
                未配置活字段；在设置页「活字段」新增后，建档与详情会自动带出。
              </Typography.Paragraph>
            ) : (
              <Descriptions column={1} bordered size="small">
                {fieldDefs.map((def) => {
                  const value = formatExtraValue(detailTarget.extra_values?.[def.field_key]);
                  return (
                    <Descriptions.Item
                      key={def.field_key}
                      label={`${def.label}${def.is_active ? "" : "（已停用）"}`}
                    >
                      {value || "未填写"}
                    </Descriptions.Item>
                  );
                })}
              </Descriptions>
            )}
            {detailData ? (
              <>
                <Typography.Title level={5} className="ui-title-spaced">经营概览</Typography.Title>
                <StatRow
                  items={[
                    { label: "关联订单", amount: detailData.overview.order_count, kind: "count" },
                    { label: "进行中订单", amount: detailData.overview.active_order_count, kind: "count" },
                    { label: "已完成订单", amount: detailData.overview.completed_order_count, kind: "count" },
                    { label: "分期已收", amount: detailData.overview.installment_paid_total, kind: "money" },
                    { label: "分期应收", amount: detailData.overview.installment_receivable_total, kind: "money" },
                    { label: "剩余应收", amount: detailData.overview.installment_remaining_total, kind: "money", tone: "warn" },
                    { label: "逾期期数", amount: detailData.overview.overdue_period_count, kind: "count", tone: detailData.overview.overdue_period_count > 0 ? "warn" : "plain" },
                  ]}
                />
                <Typography.Title level={5} className="ui-title-spaced">关联订单</Typography.Title>
                <DataTable<CustomerBusiness>
                  columns={[
                    { title: "订单", dataIndex: "order_no" },
                    { title: "业务", render: (_value, row) => orderTypeLabel(row.order_type) },
                    { title: "角色", render: (_value, row) => row.roles.join("、") || "-" },
                    { title: "状态", render: (_value, row) => <StatusTag status={row.status} /> },
                    { title: "日期", dataIndex: "trade_date" },
                  ]}
                  rows={detailData.business}
                  page={1}
                  pageSize={detailData.business.length || 1}
                  total={detailData.business.length}
                  onPageChange={() => undefined}
                  pagination={false}
                  emptyText="暂无关联订单"
                />
                <Typography.Title level={5} className="ui-title-spaced">分期收款</Typography.Title>
                <DataTable<CustomerInstallment>
                  columns={[
                    { title: "合约", dataIndex: "inst_no" },
                    { title: "订单", dataIndex: "order_no" },
                    { title: "状态", render: (_value, row) => <StatusTag status={row.status} /> },
                    { title: "已收", render: (_value, row) => `¥${money(row.paid_amount)}` },
                    { title: "剩余", render: (_value, row) => `¥${money(row.remaining_amount)}` },
                    { title: "逾期", render: (_value, row) => row.overdue_periods > 0 ? `逾期 ${row.overdue_periods} 期` : "-" },
                  ]}
                  rows={detailData.installments}
                  page={1}
                  pageSize={detailData.installments.length || 1}
                  total={detailData.installments.length}
                  onPageChange={() => undefined}
                  pagination={false}
                  emptyText="暂无分期合约"
                />
              </>
            ) : null}
          </>
        ) : null}
      </Drawer>

      <Modal
        title={mergeTarget ? `合并客户 · ${mergeTarget.customer_no}` : "合并客户"}
        open={Boolean(mergeTarget)}
        onCancel={() => setMergeTarget(null)}
        footer={null}
      >
        <Form form={mergeForm} layout="vertical" colon={false} className="form-no-colon" onFinish={submitMerge}>
          <Form.Item name="target_customer_id" label="目标客户（必须为 ACTIVE）" rules={[{ required: true }]}>
            <Select
              options={rows
                .filter((row) => row.status === "ACTIVE" && row.id !== mergeTarget?.id)
                .map((row) => ({ value: row.id, label: `${row.customer_no} ${row.display_name}` }))}
            />
          </Form.Item>
          <Form.Item name="reason" label="合并原因" rules={[{ required: true }]}>
            <Input.TextArea rows={2} />
          </Form.Item>
          <PermissionButton permission="customer.merge" type="primary" htmlType="submit">
            确认合并
          </PermissionButton>
        </Form>
      </Modal>
    </Card>
  );
}

function CounterpartyPanel() {
  const compact = useCompactLayout();
  const [rows, setRows] = useState<Counterparty[]>([]);
  const [open, setOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Counterparty | null>(null);
  const [detailTarget, setDetailTarget] = useState<Counterparty | null>(null);
  const [detailData, setDetailData] = useState<Counterparty | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();

  const load = useCallback(async () => {
    try {
      setRows(await counterpartiesApi.list());
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = async (row: Counterparty) => {
    setDetailTarget(row);
    setDetailData(null);
    setDetailLoading(true);
    try {
      setDetailData(await counterpartiesApi.get(row.id));
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setDetailLoading(false);
    }
  };

  const submit = async (values: Record<string, unknown>) => {
    try {
      await counterpartiesApi.create({
        display_name: values.display_name as string,
        type: values.type as string,
        contact_name: values.contact_name as string,
        phone: values.phone as string,
        wechat: values.wechat as string,
      });
      message.success("合作方已建档");
      setOpen(false);
      form.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const submitEdit = async (values: Record<string, unknown>) => {
    if (!editTarget) return;
    try {
      await counterpartiesApi.patch(editTarget.id, {
        display_name: values.display_name as string,
        contact_name: values.contact_name as string,
        phone: values.phone as string,
        wechat: values.wechat as string,
        qq: values.qq as string,
        note: (values.note as string) || null,
      });
      message.success("合作方已更新");
      setEditTarget(null);
      editForm.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const columns: ColumnsType<Counterparty> = [
    { title: "编号", dataIndex: "counterparty_no" },
    { title: "名称", dataIndex: "display_name" },
    { title: "类型", dataIndex: "type", render: (v: string) => COUNTERPARTY_TYPE_LABEL[v] ?? v },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} label={v === "DISABLED" ? "已拉黑" : undefined} /> },
    {
      title: "操作",
      render: (_v, row) => (
        <Space>
          <PermissionButton permission="counterparty.read" size="small" onClick={() => void openDetail(row)}>
            详情
          </PermissionButton>
          <PermissionButton permission="counterparty.manage" size="small" disabled={row.status !== "ACTIVE"} onClick={() => setEditTarget(row)}>
            编辑
          </PermissionButton>
          <ConfirmButton
            permission="counterparty.manage"
            size="small"
            title={row.status === "ACTIVE" ? "拉黑该合作方" : "解除拉黑"}
            description={row.status === "ACTIVE"
              ? "拉黑后不可作为新订单对手方；有历史参与关系的仅可拉黑，不可删除。"
              : "解除后可重新作为新订单对手方。"}
            danger={row.status === "ACTIVE"}
            onConfirm={async () => {
              await counterpartiesApi.setStatus(row.id, row.status !== "ACTIVE");
              message.success(row.status === "ACTIVE" ? "合作方已拉黑，历史关系保留" : "合作方已解除拉黑");
              await load();
            }}
          >
            {row.status === "ACTIVE" ? "拉黑" : "解除拉黑"}
          </ConfirmButton>
        </Space>
      ),
    },
  ];

  return (
    <Card
      className="glass"
      title="合作方"
      extra={
        <PermissionButton permission="counterparty.manage" type="primary" onClick={() => setOpen(true)}>
          新建合作方
        </PermissionButton>
      }
    >
      <ErrorBanner error={error} onRetry={() => void load()} />
      <Typography.Paragraph type="secondary">
        同行、供货方、平台使用 CP 编号，与客户（CUS）严格分离；有历史参与关系仅可拉黑。
      </Typography.Paragraph>
      {!compact ? <DataTable<Counterparty>
        columns={columns}
        rows={rows}
        page={1}
        pageSize={10}
        total={rows.length}
        emptyText="暂无合作方"
        onPageChange={() => undefined}
      /> : <MobileCounterpartyList
        rows={rows}
        onDetail={(row) => void openDetail(row)}
        onEdit={setEditTarget}
        onToggle={async (row) => {
          await counterpartiesApi.setStatus(row.id, row.status !== "ACTIVE");
          message.success(row.status === "ACTIVE" ? "合作方已拉黑，历史关系保留" : "合作方已解除拉黑");
          await load();
        }}
      />}
      <Modal title="新建合作方" open={open} onCancel={() => setOpen(false)} footer={null}>
        <Form form={form} layout="vertical" colon={false} className="form-no-colon" onFinish={submit} initialValues={{ type: "PEER" }}>
          <Form.Item name="display_name" label="名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="type" label="类型" rules={[{ required: true }]}>
            <Select
              options={[
                { value: "PEER", label: "同行" },
                { value: "SUPPLIER", label: "供货方" },
                { value: "PLATFORM", label: "平台" },
              ]}
            />
          </Form.Item>
          <Form.Item name="contact_name" label="联系人">
            <Input />
          </Form.Item>
          <Form.Item name="phone" label="手机号">
            <Input />
          </Form.Item>
          <Form.Item name="wechat" label="微信号">
            <Input />
          </Form.Item>
          <PermissionButton permission="counterparty.manage" type="primary" htmlType="submit">
            建档
          </PermissionButton>
        </Form>
      </Modal>

      <Modal
        title={editTarget ? `编辑合作方 · ${editTarget.counterparty_no}` : "编辑合作方"}
        open={Boolean(editTarget)}
        onCancel={() => {
          setEditTarget(null);
          editForm.resetFields();
        }}
        footer={null}
        destroyOnHidden
      >
        <Form
          form={editForm}
          layout="vertical"
          colon={false}
          className="form-no-colon"
          onFinish={submitEdit}
          initialValues={
            editTarget
              ? {
                  display_name: editTarget.display_name,
                  contact_name: editTarget.contact_name ?? "",
                  phone: editTarget.phone ?? "",
                  wechat: editTarget.wechat ?? "",
                  qq: editTarget.qq ?? "",
                  note: editTarget.note ?? "",
                }
              : undefined
          }
        >
          <Form.Item name="display_name" label="名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <div className="form-cols-2">
            <Form.Item name="contact_name" label="联系人">
              <Input />
            </Form.Item>
            <Form.Item name="phone" label="手机号">
              <Input />
            </Form.Item>
            <Form.Item name="wechat" label="微信号">
              <Input />
            </Form.Item>
            <Form.Item name="qq" label="QQ">
              <Input />
            </Form.Item>
          </div>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={3} />
          </Form.Item>
          <PermissionButton permission="counterparty.manage" type="primary" htmlType="submit">
            保存
          </PermissionButton>
        </Form>
      </Modal>

      <Drawer
        title={detailTarget ? `合作方档案 · ${detailTarget.counterparty_no}` : "合作方档案"}
        open={Boolean(detailTarget)}
        onClose={() => {
          setDetailTarget(null);
          setDetailData(null);
        }}
        width={640}
        destroyOnHidden
        extra={
          detailTarget && detailTarget.status === "ACTIVE" ? (
            <PermissionButton
              permission="counterparty.manage"
              size="small"
              onClick={() => {
                setEditTarget(detailTarget);
                setDetailTarget(null);
              }}
            >
              编辑
            </PermissionButton>
          ) : null
        }
      >
        {detailLoading ? (
          <div role="status" aria-label="正在加载合作方详情"><Spin /></div>
        ) : detailData ? (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="合作方编号">{detailData.counterparty_no}</Descriptions.Item>
            <Descriptions.Item label="名称">{detailData.display_name}</Descriptions.Item>
            <Descriptions.Item label="类型">{COUNTERPARTY_TYPE_LABEL[detailData.type] ?? detailData.type}</Descriptions.Item>
            <Descriptions.Item label="联系人">{detailData.contact_name || "-"}</Descriptions.Item>
            <Descriptions.Item label="手机">{detailData.phone || "-"}</Descriptions.Item>
            <Descriptions.Item label="微信">{detailData.wechat || "-"}</Descriptions.Item>
            <Descriptions.Item label="QQ">{detailData.qq || "-"}</Descriptions.Item>
            <Descriptions.Item label="状态"><StatusTag status={detailData.status} label={detailData.status === "DISABLED" ? "已拉黑" : undefined} /></Descriptions.Item>
            <Descriptions.Item label="备注">{detailData.note || "-"}</Descriptions.Item>
          </Descriptions>
        ) : null}
      </Drawer>
    </Card>
  );
}

