import { appMessage } from "../../shared/ui/appFeedback";
import { Form } from "antd";
import type { InputRef } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { gameTypesApi } from "../../shared/api/misc.api";
import { optionSetsApi } from "../../shared/api/options.api";
import { orderFormFieldsApi } from "../../shared/api/orders.api";
import type { OrderFormField } from "../../shared/api/types/forms";
import { normalizeError } from "../../shared/api/client";
import { useOptionSet } from "../../shared/lib/optionSets";
import { buildGroupedScopeOptions, useFormScopes } from "../formScopes";
import {
  DEFAULT_SECTION_ORDER,
  FIELD_SECTION_OPTIONS,
  FIXED_LABEL_FIELD_KEYS,
  MANAGED_OPTION_FIELD_KEYS,
  OPTION_FIELD_TYPES,
  normalizeOptionItems,
  type OrderFormFieldsPanelProps,
} from "./OrderFormFieldsPanel.fragments";
import { buildOrderFormFieldColumns } from "./OrderFormFieldsPanel.columns";
import { renderOrderFormFieldEditorForm } from "./OrderFormFieldsPanel.editorForm";

/** 字段配置面板的全部 state / 派生 / 处理器（表格列与编辑表单 JSX 已提取到独立渲染文件）。 */
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
  const [sectionConfig, setSectionConfig] = useState<{ scope: string; labels: Record<string, string> } | null>(null);
  const [sectionLoading, setSectionLoading] = useState(true);
  const [sectionSaving, setSectionSaving] = useState(false);
  const sectionSaveInFlight = useRef(false);
  const activeTypeRef = useRef(activeType);
  activeTypeRef.current = activeType;
  const [sectionError, setSectionError] = useState<{ message: string; code?: string } | null>(null);
  const sectionLabels = sectionConfig?.scope === activeType ? sectionConfig.labels : {};
  const sectionReady = sectionConfig?.scope === activeType && !sectionLoading && !sectionSaving && !sectionError;
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
  // 系统统一术语字段（如资金账户）：名称必须全站一致，配置中心只读展示、不可改名。
  const fixedLabelField = FIXED_LABEL_FIELD_KEYS.includes(editingField?.field_key ?? "");
  const orderedSectionOptions = useMemo(() => {
    const known = new Set([
      ...DEFAULT_SECTION_ORDER,
      ...Object.keys(sectionLabels),
      ...rows.map((row) => row.section ?? "EXTRA"),
    ]);
    const ordered = [...DEFAULT_SECTION_ORDER, ...[...known].filter((value) => !DEFAULT_SECTION_ORDER.includes(value)).sort()];
    return ordered.map((value) => {
      const option = FIELD_SECTION_OPTIONS.find((item) => item.value === value);
      return { value, label: sectionLabels[value] ?? option?.label ?? value };
    });
  }, [sectionLabels, rows]);
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
    if (!sectionReady || sectionSaveInFlight.current) return;
    const rawValue = sectionKeyInputRef.current?.input?.value ?? sectionDraft.value;
    const label = sectionLabelInputRef.current?.input?.value ?? sectionDraft.label;
    const value = label.trim();
    if (!value) return;
    const key = (rawValue ?? editingSectionValue ?? "").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(key)) {
      appMessage.error("板块键需为大写字母、数字或下划线，且以字母开头");
      return;
    }
    if (orderedSectionOptions.some((item) => item.value === key) && key !== editingSectionValue) {
      appMessage.error("板块键已存在");
      return;
    }
    const previousKey = editingSectionValue;
    if (!addingSection && !previousKey) return;
    const scope = activeType;
    sectionSaveInFlight.current = true;
    setSectionSaving(true);
    try {
      const labels = previousKey && key !== previousKey
        ? await orderFormFieldsApi.renameSection({ order_type_code: scope, from_key: previousKey, to_key: key, label: value })
        : await orderFormFieldsApi.saveSectionLabels({ order_type_code: scope, labels: { [key]: value } });
      if (activeTypeRef.current !== scope) return;
      if (previousKey && key !== previousKey) {
        setRows((current) => current.map((row) => (
          (row.section ?? "EXTRA") === previousKey ? { ...row, section: key } : row
        )));
      }
      setSectionConfig({ scope, labels });
      setEditingSectionValue(null);
      setAddingSection(false);
      setSectionDraft({ value: "", label: "" });
      setError(null);
    } catch (err) {
      if (activeTypeRef.current === scope) setError(normalizeError(err));
      else appMessage.error(normalizeError(err).message);
    } finally {
      sectionSaveInFlight.current = false;
      setSectionSaving(false);
    }
  };

  const changeScope = (code: string) => {
    activeTypeRef.current = code;
    setActiveType(code);
    setEditingId(null);
    setEditingSectionValue(null);
    setAddingSection(false);
    setSectionDraft({ value: "", label: "" });
    setSectionFilter("ALL");
    setActiveFilter("ALL");
    form.resetFields();
  };

  // 切换业务类型会重新触发 load / loadSectionLabels；各自用独立请求序号丢弃过期
  // 响应，避免旧类型的数据后到覆盖新类型的字段与板块标题。
  const loadSeqRef = useRef(0);
  const load = useCallback(async (code: string) => {
    const seq = ++loadSeqRef.current;
    try {
      const rows = await orderFormFieldsApi.list(code, true);
      if (seq !== loadSeqRef.current) return;
      setRows(rows);
      setError(null);
    } catch (err) {
      if (seq === loadSeqRef.current) setError(normalizeError(err));
    }
  }, []);

  // 板块标题（覆盖映射）以业务类型为单位从后端读取，与建单表单共享同一份配置。
  const sectionLabelsSeqRef = useRef(0);
  const loadSectionLabels = useCallback(async (code: string) => {
    const seq = ++sectionLabelsSeqRef.current;
    setSectionLoading(true);
    setSectionError(null);
    try {
      const labels = await orderFormFieldsApi.listSectionLabels(code);
      if (seq !== sectionLabelsSeqRef.current) return;
      setSectionConfig({ scope: code, labels: labels ?? {} });
    } catch (err) {
      if (seq === sectionLabelsSeqRef.current) {
        setSectionConfig(null);
        setSectionError(normalizeError(err));
      }
    } finally {
      if (seq === sectionLabelsSeqRef.current) setSectionLoading(false);
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
      // 系统表单允许隐藏控件；编辑时保留隐藏字段已有值，避免保存时重置配置。
      values = { ...form.getFieldsValue(true), ...values };
      const sortOrder = Number(values.sort_order ?? 0);
      const condField = (values.cond_field as string | undefined) ?? undefined;
      const op = ((values.cond_op as string | undefined) ?? "eq") as "eq" | "ne" | "filled";
      const requiredWhen = condField
        ? { field: condField, op, values: op === "filled" ? null : ((values.cond_values as string[] | undefined) ?? []) }
        : null;
      // 必填与条件必填互斥：配置了条件即按条件必填处理（基础态为选填）。
      const required = condField ? false : Boolean(values.required);
      const rawOptions = needsOptions ? normalizeOptionItems(values.options) : [];
      // 动态字典字段（游戏类型/资金账户/客户等）库内 options 为空，编辑改名时
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
      options: normalizeOptionItems(row.options),
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

  const columns = buildOrderFormFieldColumns({
    orderedSectionOptions, togglingId, activeType, rows,
    gameTypeNames, intermediaryPlatformNames, intermediaryTypeNames, compensationTypeNames,
    load, setError, startEditing, setTogglingId,
  });

  const editorForm = renderOrderFormFieldEditorForm({
    form, editorFormId, submit, editingId, fixedLabelField,
    sectionReady,
    editorFieldTypeOptions, orderedSectionOptions, editorSection,
    needsOptions, managedOptionField,
    onConfigureGameTypes, onConfigureIntermediaryPlatforms, onConfigurePools, onConfigurePartySources,
    editingField, condFieldKey, dependencyOptions, triggerOptions, condOp, cancelEditing,
  });

  return {
    editorFormId,
    fieldTypeOptions,
    scopes,
    groupedScopeOptions,
    activeType,
    setActiveType,
    changeScope,
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
    sectionLabels,
    sectionError,
    sectionLoading,
    sectionSaving,
    sectionReady,
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
