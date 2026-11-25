import { CfgItem, FieldConfigScope } from "../../shared/forms/ConfigurableField";
import { appMessage } from "../../shared/ui/appFeedback";
import { Card, Form, Input, Space, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useRef, useState } from "react";
import { optionSetsApi } from "../../shared/api/options.api";
import { orderFormFieldsApi } from "../../shared/api/orders.api";
import type { CustomDictionaryField, OptionItem } from "../../shared/api/types/common";
import { normalizeError, type NormalizedError } from "../../shared/api/client";
import { useSettingsResource } from "../../shared/state/useSettingsResource";
import { useReferenceRefresh } from "../../shared/hooks/useReferenceRefresh";
import { BusinessRegistrationForm, ConfirmButton, DataTable, ErrorBanner, PermissionButton, PermissionGate } from "../../shared/ui";

export function OptionDictionarySection({ code, title, description, linkedField }: {
  code: string; title: string; description: string; linkedField?: CustomDictionaryField;
}) {
  const [editingValue, setEditingValue] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<NormalizedError | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [form] = Form.useForm<{ option: string }>();
  const linkedFieldId = linkedField?.field_id;
  const linkedScope = linkedField?.order_type_code;
  const permission = linkedField ? "field-definition.manage" : "option-set.manage";
  const load = useCallback(async () => {
    if (linkedFieldId !== undefined) {
      if (!linkedScope) throw new Error("关联的自定义字段不可用");
      const fields = await orderFormFieldsApi.list(linkedScope, true);
      const field = fields.find((item) => item.id === linkedFieldId);
      if (!field) throw new Error("关联的自定义字段不存在");
      return field.options ?? [];
    }
    const set = await optionSetsApi.get(code);
    return set.options ?? [];
  }, [code, linkedFieldId, linkedScope]);
  const { data: loadedRows, loading, error: loadError, reload } = useSettingsResource(load);
  useReferenceRefresh("optionSets", reload, true);
  useReferenceRefresh("formFields", reload, true);
  const rows = loadedRows ?? [];
  const error = mutationError ?? loadError;
  const canEdit = !loading && !saving && !error && loadedRows !== null;
  const reloadSection = useCallback(async () => {
    setMutationError(null);
    await reload();
  }, [reload]);
  const runMutation = async (mutate: () => Promise<unknown>, onSuccess?: () => void) => {
    if (!canEdit || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await mutate();
      onSuccess?.();
      setMutationError(null);
      await reload();
    } catch (err) {
      setMutationError(normalizeError(err));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const updateOptions = (options: OptionItem[], onSuccess?: () => void) =>
    runMutation(() => linkedFieldId !== undefined
      ? orderFormFieldsApi.update(linkedFieldId, { options, expected_options: rows })
      : optionSetsApi.update(code, { options }), onSuccess);
  const save = async ({ option }: { option: string }) => {
    if (!canEdit) return;
    const label = option.trim(); if (!label) return;
    if (rows.some((item) => item.value !== editingValue && item.label === label)) { form.setFields([{ name: "option", errors: [`${title}不能重复`] }]); return; }
    const onSuccess = () => {
      appMessage.success(editingValue ? `${title}已更新` : `${title}已新增`);
      setEditingValue(null);
      form.resetFields();
    };
    if (editingValue !== null) {
      await updateOptions(rows.map((item) => item.value === editingValue ? { ...item, label } : item), onSuccess);
    } else if (linkedFieldId !== undefined) {
      await updateOptions([...rows, { value: "", label }], onSuccess);
    } else {
      await runMutation(() => optionSetsApi.addItem(code, label), onSuccess);
    }
  };
  const move = async (value: string, offset: -1 | 1) => {
    if (!canEdit) return;
    const index = rows.findIndex((item) => item.value === value);
    const nextIndex = index + offset;
    if (index < 0 || nextIndex < 0 || nextIndex >= rows.length) return;
    const next = [...rows];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    await updateOptions(next);
  };
  const columns: ColumnsType<OptionItem> = [
    { title, dataIndex: "label" },
    { title: "排序", render: (_value, _row, index) => index + 1, width: 80 },
    { title: "操作", render: (_value, row) => <PermissionGate permission={permission}><Space size={4}>
      <PermissionButton permission={permission} size="small" disabled={!canEdit} onClick={() => { setEditingValue(row.value); form.setFieldsValue({ option: row.label }); }}>编辑</PermissionButton>
      <PermissionButton permission={permission} size="small" disabled={!canEdit} onClick={() => void move(row.value, -1)}>上移</PermissionButton>
      <PermissionButton permission={permission} size="small" disabled={!canEdit} onClick={() => void move(row.value, 1)}>下移</PermissionButton>
      <ConfirmButton
        permission={permission}
        size="small"
        danger
        disabled={!canEdit}
        title={`删除${title}「${row.label}」？`}
        description="删除后不可恢复。"
        okText="删除"
        onConfirm={async () => {
          await updateOptions(rows.filter((item) => item.value !== row.value), () => appMessage.success(`${title}已删除`));
        }}
      >
        删除
      </ConfirmButton>
    </Space></PermissionGate> },
  ];
  return <Card size="small" title={title}>
    <ErrorBanner error={error} onRetry={() => void reloadSection()} /><Typography.Paragraph type="secondary">{description}</Typography.Paragraph>
    <DataTable<OptionItem> columns={columns} rows={rows} page={1} pageSize={Math.max(rows.length, 10)} total={rows.length} emptyText={`暂无${title}`} onPageChange={() => undefined} pagination={false} rowKey="value" />
    <PermissionGate permission={permission}><FieldConfigScope scope="SYSDICT" active={true}><BusinessRegistrationForm form={form} layout="inline" onFinish={save} disabled={!canEdit}>
      <CfgItem name="option" label={title} rules={[{ required: true, message: `请输入${title}` }]}><Input placeholder={`请输入${title}`} /></CfgItem>
      <Form.Item><PermissionButton permission={permission} type="primary" htmlType="submit">{editingValue ? `保存${title}` : `新增${title}`}</PermissionButton></Form.Item>
      {editingValue ? <Form.Item><PermissionButton permission={permission} onClick={() => { setEditingValue(null); form.resetFields(); }}>取消编辑</PermissionButton></Form.Item> : null}
    </BusinessRegistrationForm></FieldConfigScope></PermissionGate>
  </Card>;
}

export function IntermediaryPlatformSettingsPanel() {
  return <Card className="glass" title="中介业务配置">
    <Typography.Paragraph type="secondary">统一维护资金明细相关业务字典；修改后会同步到回收、提号等建单表单。</Typography.Paragraph>
    <div className="ui-stack">
      <OptionDictionarySection code="INTERMEDIARY_PLATFORM" title="经手平台" description="维护回收、提号等业务使用的经手平台。" />
      <OptionDictionarySection code="INTERMEDIARY_TYPE" title="中介类型" description="维护中介费的业务类型选项。" />
      <OptionDictionarySection code="COMPENSATION_TYPE" title="包赔类型" description="维护包赔相关的保障类型选项。" />
    </div>
  </Card>;
}
