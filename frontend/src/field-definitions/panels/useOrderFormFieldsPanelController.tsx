import { appMessage } from "../../shared/ui/appFeedback";
import { Form, Input, InputNumber, Space, Switch, Tooltip, Typography } from "antd";
import type { InputRef } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { gameTypesApi, optionSetsApi, orderFormFieldsApi, type OrderFormField } from "../../shared/api/catalog";
import { normalizeError } from "../../shared/api/client";
import { FIELD_TYPE_LABEL } from "../../shared/lib/labels";
import { configurableLabel, useOptionSet } from "../../shared/lib/optionSets";
import { buildGroupedScopeOptions, useFormScopes } from "../formScopes";
import { BusinessRegistrationForm, ConfirmButton, PermissionButton, PermissionGate, Select, StatusTag } from "../../shared/ui";
import "./OrderFormFieldsPanel.css";
import {
  CONDITION_OP_OPTIONS,
  DEFAULT_SECTION_ORDER,
  FIELD_SECTION_OPTIONS,
  FLOW_DIRECTION_OPTIONS,
  MANAGED_OPTION_FIELD_KEYS,
  OPTION_FIELD_TYPES,
  SECTION_ORDER_STORAGE_KEY,
  describeCondition,
  normalizeOptionItems,
  type OrderFormFieldsPanelProps,
} from "./OrderFormFieldsPanel.fragments";

/** 字段配置面板的全部 state / 派生 / 处理器（含表格列与编辑表单 JSX）。 */
export function useOrderFormFieldsPanelController({
  initialScope,
  onConfigureGameTypes,
  onConfigureIntermediaryPlatforms,
  onConfigurePools,
  onConfigurePartySources,
}: OrderFormFieldsPanelProps = {}) {
  const editorFormId = "order-form-field-editor";
  // 字段类型必须来自后端词典。
  const fieldTypeOptions = useOptionSet("FIELD_TYPE") ?? [];
  // 作用域清单以后端注册表为唯一事实源。
  const { scopes } = useFormScopes();
  const groupedScopeOptions = useMemo(() => buildGroupedScopeOptions(scopes), [scopes]);
  const [activeType, setActiveType] = useState<string>(
    initialScope ?? "HS",
  );
  const [rows, setRows] = useState<OrderFormField[]>([]);
  const [gameTypeNames, setGameTypeNames] = useState<string[]>([]);
  const [intermediaryPlatformNames, setIntermediaryPlatformNames] = useState<string[]>([]);
  const [intermediaryTypeNames, setIntermediaryTypeNames] = useState<string[]>([]);
  const [compensationTypeNames, setCompensationTypeNames] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [sectionFilter, setSectionFilter] = useState<string>("ALL");
  const [activeFilter, setActiveFilter] = useState<string>("ALL");
  const [sectionOrder, setSectionOrder] = useState<string[]>(DEFAULT_SECTION_ORDER);
  const [sectionLabels, setSectionLabels] = useState<Record<string, string>>({});
  const [editingSectionValue, setEditingSectionValue] = useState<string | null>(null);
  const [addingSection, setAddingSection] = useState(false);
  const editingField = rows.find((row) => row.id === editingId) ?? null;
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [form] = Form.useForm();
  const [sectionDraft, setSectionDraft] = useState({ value: "", label: "" });
  const sectionKeyInputRef = useRef<InputRef>(null);
  const sectionLabelInputRef = useRef<InputRef>(null);
  const fieldType = Form.useWatch("field_type", form);
  const editorSection = Form.useWatch("section", form);
  const needsOptions = OPTION_FIELD_TYPES.includes(fieldType as string);
  const managedOptionField = MANAGED_OPTION_FIELD_KEYS.includes(editingField?.field_key ?? "");
  const orderedSectionOptions = useMemo(() => {
    const ordered = [...sectionOrder];
    return ordered.map((value) => {
      const option = FIELD_SECTION_OPTIONS.find((item) => item.value === value);
      return { value, label: sectionLabels[value] ?? option?.label ?? value };
    });
  }, [sectionLabels, sectionOrder]);
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
  const sectionManagementRows = orderedSectionOptions.map((section, index) => ({
    ...section,
    count: rows.filter((row) => (row.section ?? "EXTRA") === section.value).length,
    index,
  }));

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SECTION_ORDER_STORAGE_KEY) ?? "null");
      if (Array.isArray(saved)) setSectionOrder(saved.filter((value): value is string => typeof value === "string"));
    } catch {
      // 本地排序配置损坏时回退默认顺序，不影响字段配置。
    }
  }, []);

  const editSection = (value: string) => {
    const option = orderedSectionOptions.find((item) => item.value === value);
    if (!option) return;
    setAddingSection(false);
    setEditingSectionValue(value);
    setSectionDraft({ value, label: sectionLabels[value] ?? option.label });
  };

  const beginAddSection = () => {
    setEditingSectionValue(null);
    setAddingSection(true);
    setSectionDraft({ value: "", label: "" });
  };

  const saveSection = async () => {
    const rawValue = sectionKeyInputRef.current?.input?.value ?? sectionDraft.value;
    const label = sectionLabelInputRef.current?.input?.value ?? sectionDraft.label;
    const value = label.trim();
    if (!value) return;
    const key = (rawValue ?? editingSectionValue ?? "").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(key)) {
      appMessage.error("板块键需为大写字母、数字或下划线，且以字母开头");
      return;
    }
    if (sectionOrder.includes(key) && key !== editingSectionValue) {
      appMessage.error("板块键已存在");
      return;
    }
    if (addingSection) {
      const nextOrder = [...sectionOrder, key];
      const nextLabels = { ...sectionLabels, [key]: value };
      try {
        await orderFormFieldsApi.saveSectionLabels({ order_type_code: activeType, labels: nextLabels });
      } catch (err) {
        setError(normalizeError(err));
        return;
      }
      setSectionOrder(nextOrder);
      setSectionLabels(nextLabels);
      localStorage.setItem(SECTION_ORDER_STORAGE_KEY, JSON.stringify(nextOrder));
      setAddingSection(false);
      setSectionDraft({ value: "", label: "" });
      return;
    }
    if (!editingSectionValue) return;
    if (key !== editingSectionValue) {
      try {
        const affectedRows = rows.filter((row) => (row.section ?? "EXTRA") === editingSectionValue);
        await Promise.all(affectedRows.map((row) => orderFormFieldsApi.update(row.id, { section: key })));
        setRows((current) => current.map((row) => (
          (row.section ?? "EXTRA") === editingSectionValue ? { ...row, section: key } : row
        )));
      } catch (err) {
        setError(normalizeError(err));
        return;
      }
    }
    const nextOrder = sectionOrder.map((item) => item === editingSectionValue ? key : item);
    const nextLabels = { ...sectionLabels };
    delete nextLabels[editingSectionValue];
    nextLabels[key] = value;
    try {
      await orderFormFieldsApi.saveSectionLabels({ order_type_code: activeType, labels: nextLabels });
    } catch (err) {
      setError(normalizeError(err));
      return;
    }
    setSectionOrder(nextOrder);
    setSectionLabels(nextLabels);
    localStorage.setItem(SECTION_ORDER_STORAGE_KEY, JSON.stringify(nextOrder));
    setEditingSectionValue(null);
    setSectionDraft({ value: "", label: "" });
  };

  const load = useCallback(async (code: string) => {
    try {
      setRows(await orderFormFieldsApi.list(code, true));
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, []);

  // 板块标题（覆盖映射）以业务类型为单位从后端读取，与建单表单共享同一份配置。
  const loadSectionLabels = useCallback(async (code: string) => {
    try {
      const labels = await orderFormFieldsApi.listSectionLabels(code);
      setSectionLabels(labels ?? {});
    } catch {
      setSectionLabels({});
    }
  }, []);

  useEffect(() => {
    void load(activeType);
    void loadSectionLabels(activeType);
  }, [activeType, load, loadSectionLabels]);
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
          flow_direction: values.flow_direction as OrderFormField["flow_direction"],
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
          flow_direction: values.flow_direction as OrderFormField["flow_direction"],
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
      flow_direction: row.flow_direction ?? undefined,
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
      render: (value: OrderFormField["section"]) => orderedSectionOptions.find((item) => item.value === value)?.label ?? "其他补充信息",
    },
    { title: "排序", dataIndex: "sort_order", width: 72 },
    { title: "类型", dataIndex: "field_type", render: (v: string, row) => MANAGED_OPTION_FIELD_KEYS.includes(row.field_key) ? "联动选择" : configurableLabel("FIELD_TYPE", v, FIELD_TYPE_LABEL) },
    { title: "资金流向性质", dataIndex: "flow_direction", render: (value: OrderFormField["flow_direction"]) => FLOW_DIRECTION_OPTIONS.find((item) => item.value === value)?.label ?? "-" },
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
      render: (value: Array<{ value: string; label: string }> | null | undefined, row) =>
        row.field_key === "game_type" ? `游戏类型主数据 · ${gameTypeNames.slice(0, 2).join("、") || "暂无"}等 ${gameTypeNames.length} 项` :
        row.field_key === "channel_region" ? "游戏类型渠道／区服主数据 · 随游戏类型联动" :
        row.field_key === "intermediary_platform" ? `经手平台主数据 · ${intermediaryPlatformNames.slice(0, 2).join("、") || "暂无"}等 ${intermediaryPlatformNames.length} 项` :
        row.field_key === "intermediary_type" ? `中介类型主数据 · ${intermediaryTypeNames.slice(0, 2).join("、") || "暂无"}等 ${intermediaryTypeNames.length} 项` :
        row.field_key === "compensation_type" ? `包赔类型主数据 · ${compensationTypeNames.slice(0, 2).join("、") || "暂无"}等 ${compensationTypeNames.length} 项` :
        row.field_key === "payment_pool_id" ? "资金账户主数据 · 随资金账户配置联动" :
        ["customer_source", "dg_customer_source"].includes(row.field_key) ? "客户来源主数据 · 回收/代挂共用" :
        row.field_key === "supplier_source" ? "供货方来源主数据 · 随供货方来源配置联动" :
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
                  <ConfirmButton
                    permission="field-definition.manage"
                    size="small"
                    danger
                    disabled={!row.is_custom}
                    title={`删除字段「${row.label}」`}
                    description="删除后不可恢复；自定义字段的历史值仍保留在订单 form_extra 中。"
                    okText="确认删除"
                    onConfirm={async () => {
                      await orderFormFieldsApi.remove(row.id);
                      appMessage.success("字段已删除");
                      await load(activeType);
                    }}
                  >
                    删除
                  </ConfirmButton>
                </span>
              </Tooltip>
          </Space>
        </PermissionGate>
      ),
    },
  ];

  const editorForm = (
    <PermissionGate permission="field-definition.manage">
      <BusinessRegistrationForm
        form={form}
        id={editorFormId}
        layout="inline"
        onFinish={submit}
        className="ui-form-spaced"
        initialValues={{ field_type: "TEXT", sort_order: 0, section: "EXTRA" }}
      >
        <Form.Item name="field_key" label="字段键" rules={[{ required: true }, { pattern: /^[a-z][a-z0-9_]*$/, message: "仅支持小写字母与下划线，且以小写字母开头" }]}>
          <Input placeholder="小写下划线，如 vip_tag" disabled={editingId !== null} />
        </Form.Item>
        <Form.Item name="label" label="标签" rules={[{ required: true }]}>
          <Input placeholder="页面显示名" />
        </Form.Item>
        <Form.Item name="field_type" label="类型">
          <Select options={editorFieldTypeOptions} className="ui-control-width-180" disabled={editingId !== null} />
        </Form.Item>
        <Form.Item name="section" label="归属板块">
          <Select
            options={orderedSectionOptions}
            className="ui-control-width-160"
            popupClassName="order-form-section-filter-pop"
          />
        </Form.Item>
        {editorSection === "FINANCE" ? (
          <Form.Item name="flow_direction" label="资金流向性质">
            <Select allowClear placeholder="请选择资金流向性质" options={[...FLOW_DIRECTION_OPTIONS]} className="ui-control-width-160" popupClassName="order-form-field-option-pop" />
          </Form.Item>
        ) : null}
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
        {editingField?.field_key === "payment_pool_id" && onConfigurePools ? (
          <Form.Item>
            <PermissionButton permission="field-definition.manage" onClick={onConfigurePools}>配置资金账户</PermissionButton>
          </Form.Item>
        ) : null}
        {editingField && ["customer_source", "dg_customer_source", "supplier_source"].includes(editingField.field_key) && onConfigurePartySources ? (
          <Form.Item>
            <PermissionButton permission="field-definition.manage" onClick={onConfigurePartySources}>
              {editingField.field_key === "supplier_source" ? "配置供货方来源" : "配置客户来源"}
            </PermissionButton>
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
            popupClassName="order-form-field-option-pop"
            onChange={(value: string | undefined) => {
              if (value) form.setFieldsValue({ required: false, cond_op: form.getFieldValue("cond_op") ?? "eq" });
            }}
          />
        </Form.Item>
        {condFieldKey ? (
          <Form.Item name="cond_op" label="条件" initialValue="eq">
            <Select options={CONDITION_OP_OPTIONS} className="ui-control-width-110" popupClassName="order-form-field-option-pop" />
          </Form.Item>
        ) : null}
        {condFieldKey && condOp !== "filled" ? (
          <Form.Item name="cond_values" label="触发值">
            <Select
              mode="tags"
              options={triggerOptions}
              placeholder="选值或输入后回车"
              className="ui-control-width-200"
              popupClassName="order-form-field-option-pop"
            />
          </Form.Item>
        ) : null}
        <Form.Item name="sort_order" label="排序"><InputNumber min={0} className="ui-control-width-90" /></Form.Item>
        <Form.Item>
          <PermissionButton permission="field-definition.manage" type="primary" htmlType="submit" form={editorFormId}>
            {editingId === null ? "新增字段" : "保存字段"}
          </PermissionButton>
        </Form.Item>
        {editingId !== null && (
          <Form.Item>
            <PermissionButton permission="field-definition.manage" onClick={cancelEditing}>取消编辑</PermissionButton>
          </Form.Item>
        )}
      </BusinessRegistrationForm>
    </PermissionGate>
  );

  return {
    editorFormId,
    fieldTypeOptions,
    scopes,
    groupedScopeOptions,
    activeType,
    setActiveType,
    rows,
    setRows,
    gameTypeNames,
    setGameTypeNames,
    intermediaryPlatformNames,
    setIntermediaryPlatformNames,
    intermediaryTypeNames,
    setIntermediaryTypeNames,
    compensationTypeNames,
    setCompensationTypeNames,
    editingId,
    setEditingId,
    sectionFilter,
    setSectionFilter,
    activeFilter,
    setActiveFilter,
    sectionOrder,
    setSectionOrder,
    sectionLabels,
    setSectionLabels,
    editingSectionValue,
    setEditingSectionValue,
    addingSection,
    setAddingSection,
    editingField,
    error,
    setError,
    togglingId,
    setTogglingId,
    form,
    sectionDraft,
    setSectionDraft,
    sectionKeyInputRef,
    sectionLabelInputRef,
    fieldType,
    editorSection,
    needsOptions,
    managedOptionField,
    orderedSectionOptions,
    editorFieldTypeOptions,
    condFieldKey,
    condOp,
    dependencyOptions,
    dependencyRow,
    triggerOptions,
    visibleRows,
    sectionManagementRows,
    editSection,
    beginAddSection,
    saveSection,
    load,
    loadSectionLabels,
    submit,
    startEditing,
    cancelEditing,
    columns,
    editorForm,
  };
}

export type OrderFormFieldsPanelController = ReturnType<typeof useOrderFormFieldsPanelController>;
