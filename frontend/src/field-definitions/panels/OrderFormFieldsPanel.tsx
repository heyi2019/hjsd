import { appMessage, appModal } from "../../shared/ui/appFeedback";
/** 表单字段配置面板：按表单作用域（33 个业务表单）配置字段的
 *  新增、删除、必填态（必填/条件必填/选填）、停用/启用。字段可配置必填态与启用态；
 *  仅自定义字段可删除（预置字段受保护）。 */
import { Card, Form, Input, InputNumber, Popconfirm, Segmented, Select, Space, Switch, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useMemo, useState } from "react";
import { gameTypesApi, optionSetsApi, orderFormFieldsApi, type OrderFormField } from "../../shared/api/catalog";
import { normalizeError } from "../../shared/api/client";
import { FIELD_TYPE_LABEL } from "../../shared/lib/labels";
import { configurableLabel, useOptionSet } from "../../shared/lib/optionSets";
import { FORM_SCOPE_LABEL, buildGroupedScopeOptions, useFormScopes } from "../formScopes";
import { ConfirmButton, DataTable, ErrorBanner, PermissionButton, PermissionGate, StatusTag } from "../../shared/ui";
import "./OrderFormFieldsPanel.css";

const FIELD_TYPE_OPTIONS = Object.entries(FIELD_TYPE_LABEL).map(([value, label]) => ({ value, label }));
const OPTION_FIELD_TYPES = ["SELECT", "MULTI_SELECT"];
const MANAGED_OPTION_FIELD_KEYS = ["game_type", "channel_region", "intermediary_platform", "intermediary_type", "compensation_type"];
const CONDITION_OP_OPTIONS = [
  { value: "eq", label: "等于" },
  { value: "ne", label: "不等于" },
  { value: "filled", label: "有值" },
];
const OP_TEXT: Record<string, string> = { eq: "等于", ne: "不等于", filled: "有值" };
const FIELD_SECTION_OPTIONS = [
  { value: "ACCOUNT_PRODUCT", label: "账号 / 产品信息" },
  { value: "BUSINESS", label: "业务方案信息" },
  { value: "DELIVER", label: "交付信息" },
  { value: "FINANCE", label: "费用与资金" },
  { value: "EXTRA", label: "其他补充信息" },
  { value: "PARTICIPANT", label: "参与方信息" },
];
const ORDER_SCOPE_OPTIONS = [
  { value: "HS", label: "回收" },
  { value: "TH", label: "提号" },
  { value: "DG", label: "代挂" },
  { value: "DFQ", label: "代分期" },
];
const ORDER_SCOPE_CODES = new Set(ORDER_SCOPE_OPTIONS.map((item) => item.value));

/** 条件描述文案：如「客户来源 等于 其他」。 */
const describeCondition = (fieldLabel: string, cond: { op: string; values?: string[] | null }): string => {
  const opText = OP_TEXT[cond.op] ?? cond.op;
  if (cond.op === "filled") return `${fieldLabel} ${opText}即可`;
  return `${fieldLabel} ${opText} ${(cond.values ?? []).join(" / ")}`;
};

/** 规范化表单里的 options 字段：过滤空 value，label 缺省取 value。 */
const normalizeOptionItems = (raw: unknown): Array<{ value: string; label: string }> => {
  if (!Array.isArray(raw)) return [];
  return (raw as Array<{ value?: string; label?: string }>)
    .map((o) => ({ value: (o?.value ?? "").trim(), label: (o?.label ?? "").trim() || (o?.value ?? "").trim() }))
    .filter((o) => o.value);
};

export interface OrderFormFieldsPanelProps {
  /** 初始选中的表单作用域；缺省为 HS。 */
  initialScope?: string;
  onConfigureGameTypes?: () => void;
  onConfigureIntermediaryPlatforms?: () => void;
}

export function OrderFormFieldsPanel({ initialScope, onConfigureGameTypes, onConfigureIntermediaryPlatforms }: OrderFormFieldsPanelProps = {}) {
  // 词典未加载时回落模块常量，保证与改造前完全一致。
  const fieldTypeOptions = useOptionSet("FIELD_TYPE") ?? FIELD_TYPE_OPTIONS;
  // 作用域清单以后端注册表为单一事实源；接口不可用时回落本地兜底。
  const { scopes } = useFormScopes();
  const groupedScopeOptions = useMemo(() => buildGroupedScopeOptions(scopes), [scopes]);
  const [activeType, setActiveType] = useState<string>(
    initialScope && FORM_SCOPE_LABEL[initialScope] ? initialScope : "HS",
  );
  const [rows, setRows] = useState<OrderFormField[]>([]);
  const [gameTypeNames, setGameTypeNames] = useState<string[]>([]);
  const [intermediaryPlatformNames, setIntermediaryPlatformNames] = useState<string[]>([]);
  const [intermediaryTypeNames, setIntermediaryTypeNames] = useState<string[]>([]);
  const [compensationTypeNames, setCompensationTypeNames] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [sectionFilter, setSectionFilter] = useState<string>("ALL");
  const [activeFilter, setActiveFilter] = useState<string>("ALL");
  const editingField = rows.find((row) => row.id === editingId) ?? null;
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [form] = Form.useForm();
  const fieldType = Form.useWatch("field_type", form);
  const needsOptions = OPTION_FIELD_TYPES.includes(fieldType as string);
  const managedOptionField = MANAGED_OPTION_FIELD_KEYS.includes(editingField?.field_key ?? "");
  const editorFieldTypeOptions = editingField && MANAGED_OPTION_FIELD_KEYS.includes(editingField.field_key)
    ? [{ value: editingField.field_type, label: "联动选择（库内主数据）" }]
    : fieldTypeOptions;
  const condFieldKey = Form.useWatch("cond_field", form) as string | undefined;
  const condOp = (Form.useWatch("cond_op", form) as string | undefined) ?? "eq";
  // 依赖字段候选：同作用域内、启用中、且不是自身。
  const dependencyOptions = rows
    .filter((row) => row.is_active && row.field_key !== editingField?.field_key)
    .map((row) => ({ value: row.field_key, label: `${row.label}（${row.field_key}）` }));
  // 触发值候选取自依赖字段自身的选项；无选项时允许手输（tags 模式）。
  const dependencyRow = rows.find((row) => row.field_key === condFieldKey);
  const triggerOptions = normalizeOptionItems(dependencyRow?.options).map((item) => ({
    value: item.value,
    label: item.label,
  }));
  const visibleRows = rows.filter((row) => (
    (sectionFilter === "ALL" || (row.section ?? "EXTRA") === sectionFilter) &&
    (activeFilter === "ALL" || (activeFilter === "ACTIVE" ? row.is_active : !row.is_active))
  ));

  const load = useCallback(async (code: string) => {
    try {
      setRows(await orderFormFieldsApi.list(code, true));
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, []);

  useEffect(() => {
    void load(activeType);
  }, [activeType, load]);
  useEffect(() => {
    void gameTypesApi.list({ include_inactive: false }).then((items) => setGameTypeNames(items.map((item) => item.name))).catch(() => undefined);
    void optionSetsApi.get("INTERMEDIARY_PLATFORM").then((item) => setIntermediaryPlatformNames((item.options ?? []).map((option) => option.label))).catch(() => undefined);
    void optionSetsApi.get("INTERMEDIARY_TYPE").then((item) => setIntermediaryTypeNames((item.options ?? []).map((option) => option.label))).catch(() => undefined);
    void optionSetsApi.get("COMPENSATION_TYPE").then((item) => setCompensationTypeNames((item.options ?? []).map((option) => option.label))).catch(() => undefined);
  }, []);

  const submit = async (values: Record<string, unknown>) => {
    try {
      const sortOrder = Number(values.sort_order ?? 0);
      const condField = (values.cond_field as string | undefined) ?? undefined;
      const op = ((values.cond_op as string | undefined) ?? "eq") as "eq" | "ne" | "filled";
      const requiredWhen = condField
        ? { field: condField, op, values: op === "filled" ? null : ((values.cond_values as string[] | undefined) ?? []) }
        : null;
      // 必填与条件必填互斥：配置了条件即按条件必填处理（基础态为选填）。
      const required = condField ? false : Boolean(values.required);
      const rawOptions = needsOptions ? normalizeOptionItems(values.options) : [];
      // 动态字典字段（游戏类型/资金池/客户等）库内 options 为空，编辑改名时
      // 空选项数组按「未变更」处理（不传），否则后端会以「选择型字段至少需要一个选项」拒绝更新。
      const options = needsOptions && rawOptions.length ? rawOptions : undefined;
      if (editingId === null) {
        await orderFormFieldsApi.create({
          order_type_code: activeType,
          field_key: values.field_key as string,
          label: values.label as string,
          field_type: (values.field_type as string) ?? "TEXT",
          options,
          required,
          required_when: requiredWhen,
          sort_order: sortOrder,
          section: values.section as OrderFormField["section"],
        });
        appMessage.success("字段已创建");
      } else {
        await orderFormFieldsApi.update(editingId, {
          label: values.label as string,
          options,
          required,
          required_when: requiredWhen,
          sort_order: sortOrder,
          section: values.section as OrderFormField["section"],
        });
        appMessage.success("字段已更新");
      }
      setEditingId(null);
      form.resetFields();
      await load(activeType);
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const startEditing = (row: OrderFormField) => {
    setEditingId(row.id);
    form.setFieldsValue({
      field_key: row.field_key,
      label: row.label,
      field_type: row.field_type,
      options: (row.options ?? []).map((o) => (typeof o === "string" ? { value: o, label: o } : o)),
      required: Boolean(row.required),
      cond_field: row.required_when?.field,
      cond_op: row.required_when?.op ?? "eq",
      cond_values: row.required_when?.values ?? [],
      sort_order: row.sort_order,
      section: row.section ?? "EXTRA",
    });
  };

  const cancelEditing = () => {
    setEditingId(null);
    form.resetFields();
  };

  const columns: ColumnsType<OrderFormField> = [
    { title: "字段键", dataIndex: "field_key" },
    { title: "标签", dataIndex: "label" },
    {
      title: "归属板块",
      dataIndex: "section",
      render: (value: OrderFormField["section"]) => FIELD_SECTION_OPTIONS.find((item) => item.value === value)?.label ?? "其他补充信息",
    },
    { title: "排序", dataIndex: "sort_order", width: 72 },
    { title: "类型", dataIndex: "field_type", render: (v: string, row) => MANAGED_OPTION_FIELD_KEYS.includes(row.field_key) ? "联动选择" : configurableLabel("FIELD_TYPE", v, FIELD_TYPE_LABEL) },
    {
      title: "必填",
      dataIndex: "required",
      render: (value: boolean, row: OrderFormField) => (
        <Space direction="vertical" size={0}>
          <PermissionGate
            permission="field-definition.manage"
            fallback={<Typography.Text type="secondary">{value ? "必填" : row.required_when ? "条件必填" : "选填"}</Typography.Text>}
          >
            <Switch
              checked={value}
              loading={togglingId === row.id}
              aria-label={`必填_${row.field_key}`}
              onChange={async (checked: boolean) => {
                try {
                  setTogglingId(row.id);
                  await orderFormFieldsApi.update(row.id, { required: checked });
                  appMessage.success(checked ? "已设为必填" : row.required_when ? "已设为条件必填" : "已设为选填");
                  await load(activeType);
                } catch (err) {
                  setError(normalizeError(err));
                } finally {
                  setTogglingId(null);
                }
              }}
            />
          </PermissionGate>
          {row.required_when ? (
            <Typography.Text type="secondary" aria-label={`条件_${row.field_key}`}>
              条件必填：{describeCondition(
                rows.find((item) => item.field_key === row.required_when?.field)?.label ?? row.required_when.field,
                row.required_when,
              )}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: "选项",
      dataIndex: "options",
      render: (value: Array<string | { value: string; label: string }> | null | undefined, row) =>
        row.field_key === "game_type" ? `游戏类型主数据 · ${gameTypeNames.slice(0, 2).join("、") || "暂无"}等 ${gameTypeNames.length} 项` :
        row.field_key === "channel_region" ? "游戏类型渠道／区服主数据 · 随游戏类型联动" :
        row.field_key === "intermediary_platform" ? `经手平台主数据 · ${intermediaryPlatformNames.slice(0, 2).join("、") || "暂无"}等 ${intermediaryPlatformNames.length} 项` :
        row.field_key === "intermediary_type" ? `中介类型主数据 · ${intermediaryTypeNames.slice(0, 2).join("、") || "暂无"}等 ${intermediaryTypeNames.length} 项` :
        row.field_key === "compensation_type" ? `包赔类型主数据 · ${compensationTypeNames.slice(0, 2).join("、") || "暂无"}等 ${compensationTypeNames.length} 项` :
        value && value.length
          ? value.map((o) => (typeof o === "string" ? o : o.label)).join("、")
          : "-",
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
          <Space size={2}>
            <PermissionButton
              permission="field-definition.manage"
              size="small"
              aria-label={`编辑${row.label}`}
              onClick={() => startEditing(row)}
            >
              编辑
            </PermissionButton>
            <ConfirmButton
              permission="field-definition.manage"
              size="small"
              title={row.is_active ? `停用字段「${row.label}」` : `启用字段「${row.label}」`}
              description={row.is_active
                ? "停用后该字段从建单表单消失（自定义字段值保留在订单数据中）。若被其它字段的条件必填引用，需先解除条件。"
                : "启用后该字段重新出现在建单表单中。"}
              danger={row.is_active}
              onConfirm={async () => {
                await orderFormFieldsApi.setActive(row.id, !row.is_active);
                await load(activeType);
              }}
            >
              {row.is_active ? "停用" : "启用"}
            </ConfirmButton>
            <Tooltip title={!row.is_custom ? "预置字段不可删除（仅自定义字段可删）" : undefined}>
              <span>
                <Popconfirm
                  title={`删除字段「${row.label}」`}
                  description="删除后不可恢复；自定义字段的历史值仍保留在订单 form_extra 中。"
                  onConfirm={async () => {
                    try {
                      await orderFormFieldsApi.remove(row.id);
                      appMessage.success("字段已删除");
                      await load(activeType);
                    } catch (err) {
                      // 顶部 ErrorBanner 语义是「加载失败」，操作失败需即时可见
                      appMessage.error(normalizeError(err).message);
                    }
                  }}
                >
                  <PermissionButton permission="field-definition.manage" size="small" danger disabled={!row.is_custom}>
                    删除
                  </PermissionButton>
                </Popconfirm>
              </span>
            </Tooltip>
          </Space>
        </PermissionGate>
      ),
    },
  ];

  const editorForm = (
    <PermissionGate permission="field-definition.manage">
      <Form
        form={form}
        layout="inline"
        onFinish={submit}
        className="ui-form-spaced"
        initialValues={{ field_type: "TEXT", sort_order: 0, section: "EXTRA" }}
      >
        <Form.Item name="field_key" label="字段键" rules={[{ required: true }]}>
          <Input placeholder="小写下划线，如 vip_tag" disabled={editingId !== null} />
        </Form.Item>
        <Form.Item name="label" label="标签" rules={[{ required: true }]}>
          <Input placeholder="页面显示名" />
        </Form.Item>
        <Form.Item name="field_type" label="类型">
          <Select options={editorFieldTypeOptions} className="ui-control-width-180" disabled={editingId !== null} />
        </Form.Item>
        <Form.Item name="section" label="归属板块">
          <Select options={FIELD_SECTION_OPTIONS} className="ui-control-width-160" />
        </Form.Item>
        {needsOptions && !managedOptionField && (
          <Form.Item label="选项（值 / 展示名）">
            <Form.List name="options">
              {(fields, { add, remove }) => (
                <Space direction="vertical" className="ui-control-full">
                  {fields.map(({ key, name, ...restField }) => (
                    <Space key={key} align="baseline">
                      <Form.Item {...restField} name={[name, "value"]} rules={[{ required: true, message: "值必填" }]} noStyle>
                        <Input placeholder="value（后端枚举码/字典键）" className="ui-control-width-200" />
                      </Form.Item>
                      <Form.Item {...restField} name={[name, "label"]} noStyle>
                        <Input placeholder="展示名（可空，默认同值）" className="ui-control-width-200" />
                      </Form.Item>
                      <PermissionButton permission="field-definition.manage" danger size="small" onClick={() => remove(name)}>
                        删
                      </PermissionButton>
                    </Space>
                  ))}
                  <PermissionButton permission="field-definition.manage" onClick={() => add({ value: "", label: "" })}>
                    添加选项
                  </PermissionButton>
                </Space>
              )}
            </Form.List>
          </Form.Item>
        )}
        {editingField?.field_key === "game_type" && onConfigureGameTypes ? (
          <Form.Item>
            <PermissionButton permission="field-definition.manage" onClick={onConfigureGameTypes}>配置游戏类型</PermissionButton>
          </Form.Item>
        ) : null}
        {editingField?.field_key === "channel_region" && onConfigureGameTypes ? (
          <Form.Item>
            <PermissionButton permission="field-definition.manage" onClick={onConfigureGameTypes}>配置游戏类型渠道／区服</PermissionButton>
          </Form.Item>
        ) : null}
        {editingField?.field_key === "intermediary_platform" && onConfigureIntermediaryPlatforms ? (
          <Form.Item>
            <PermissionButton permission="field-definition.manage" onClick={onConfigureIntermediaryPlatforms}>配置经手平台</PermissionButton>
          </Form.Item>
        ) : null}
        {editingField && ["intermediary_type", "compensation_type"].includes(editingField.field_key) && onConfigureIntermediaryPlatforms ? (
          <Form.Item>
            <PermissionButton permission="field-definition.manage" onClick={onConfigureIntermediaryPlatforms}>配置中介业务</PermissionButton>
          </Form.Item>
        ) : null}
        <Form.Item
          name="required"
          label="必填"
          valuePropName="checked"
          tooltip={condFieldKey ? "已配置条件必填，二者互斥；清空依赖字段即可改回必填" : undefined}
        >
          <Switch disabled={Boolean(condFieldKey)} />
        </Form.Item>
        <Form.Item name="cond_field" label="条件必填·依赖字段">
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="不启用"
            options={dependencyOptions}
            className="ui-control-width-180"
            onChange={(value: string | undefined) => {
              if (value) form.setFieldsValue({ required: false, cond_op: form.getFieldValue("cond_op") ?? "eq" });
            }}
          />
        </Form.Item>
        {condFieldKey ? (
          <Form.Item name="cond_op" label="条件" initialValue="eq">
            <Select options={CONDITION_OP_OPTIONS} className="ui-control-width-110" />
          </Form.Item>
        ) : null}
        {condFieldKey && condOp !== "filled" ? (
          <Form.Item name="cond_values" label="触发值">
            <Select
              mode="tags"
              options={triggerOptions}
              placeholder="选值或输入后回车"
              className="ui-control-width-200"
            />
          </Form.Item>
        ) : null}
        <Form.Item name="sort_order" label="排序"><InputNumber min={0} className="ui-control-width-90" /></Form.Item>
        <Form.Item>
          <PermissionButton permission="field-definition.manage" type="primary" htmlType="submit">
            {editingId === null ? "新增字段" : "保存字段"}
          </PermissionButton>
        </Form.Item>
        {editingId !== null && (
          <Form.Item>
            <PermissionButton permission="field-definition.manage" onClick={cancelEditing}>取消编辑</PermissionButton>
          </Form.Item>
        )}
      </Form>
    </PermissionGate>
  );

  return (
    <Card className="glass" title="表单字段配置">
      <ErrorBanner error={error} onRetry={() => void load(activeType)} />
      <Typography.Paragraph type="secondary">
        选择上方「表单」可配置任意业务表单的字段：建单（回收/提号/代挂/代分期）、库存（售出/寄售/返点）、
        客户需求池、分期（收款/回收/出售/换绑/取消/结清/违约/减免/展期）、返点（新建/结算/冲销）、
        资金（占用/流水/划转/对账/核销/拒绝/冲销/释放/损失/修复/月结）。
        可新增自定义字段、删除自定义字段（仅自定义字段可删）、停用/启用；
        「必填」列提供行内开关（必填/选填），需要「仅在某字段取某值时必填」时在编辑区设置
        「条件必填」（如客户来源等于「其他」时其他来源必填）。改动即时反映到对应表单。
        当前：{FORM_SCOPE_LABEL[activeType] ?? activeType}
      </Typography.Paragraph>
      <div className="order-form-fields__container">
        <Space className="ui-toolbar-spaced" align="center">
          <Typography.Text strong>表单</Typography.Text>
          <Select
            className="ui-control-width-260"
            value={activeType}
            onChange={(value: string) => {
              setActiveType(value);
              setEditingId(null);
              setSectionFilter("ALL");
              setActiveFilter("ALL");
              form.resetFields();
            }}
            options={groupedScopeOptions}
            optionFilterProp="label"
            showSearch
          />
          <Typography.Text strong>建单快捷入口</Typography.Text>
          <Segmented
            aria-label="建单表快捷入口"
            options={ORDER_SCOPE_OPTIONS}
            value={ORDER_SCOPE_CODES.has(activeType) ? activeType : undefined}
            onChange={(value) => {
              const next = String(value);
              setActiveType(next);
              setEditingId(null);
              setSectionFilter("ALL");
              setActiveFilter("ALL");
              form.resetFields();
            }}
          />
          <Typography.Text strong>板块筛选</Typography.Text>
          <Select
            aria-label="字段板块筛选"
            value={sectionFilter}
            onChange={setSectionFilter}
            className="ui-control-width-180"
            options={[{ value: "ALL", label: "全部板块" }, ...FIELD_SECTION_OPTIONS]}
          />
          <Typography.Text strong>状态筛选</Typography.Text>
          <Select
            aria-label="字段启用状态筛选"
            value={activeFilter}
            onChange={setActiveFilter}
            className="ui-control-width-140"
            options={[
              { value: "ALL", label: "全部状态" },
              { value: "ACTIVE", label: "已启用" },
              { value: "INACTIVE", label: "已停用" },
            ]}
          />
        </Space>
        <DataTable<OrderFormField>
          columns={columns}
          rows={visibleRows}
          page={1}
          pageSize={Math.max(visibleRows.length, 10)}
          total={visibleRows.length}
          emptyText="该表单暂无字段配置"
          onPageChange={() => undefined}
          // 7 列（字段键/标签/类型/必填/选项/启用/操作）在窄容器内会被压到换行，
          // 统一按内容宽度渲染，由 .ui-table-wrap 的 overflow:auto 承担左右滑动。
          expandable={{
            expandedRowKeys: editingId === null ? [] : [String(editingId)],
            showExpandColumn: false,
            expandedRowRender: (row) => <div aria-label={`编辑区${row.label}`} className="order-form-fields__edit-container">{editorForm}</div>,
          }}
        />
      </div>
      {editingId === null ? (
        <div className="order-form-fields__container order-form-fields__create-container">
          <Typography.Title level={5}>新增自定义字段</Typography.Title>
          {editorForm}
        </div>
      ) : null}
    </Card>
  );
}
