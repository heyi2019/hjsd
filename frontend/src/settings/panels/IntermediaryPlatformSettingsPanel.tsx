import { CfgItem, FieldConfigScope } from "../../business/ConfigurableField";
import { appMessage } from "../../shared/ui/appFeedback";
import { Card, Form, Input, Space, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useState } from "react";
import { optionSetsApi } from "../../shared/api/options.api";
import type { OptionItem } from "../../shared/api/types/common";
import { clearOptionSetsCache } from "../../shared/lib/optionSets";
import { normalizeError, type NormalizedError } from "../../shared/api/client";
import { useSettingsResource } from "../../shared/state/useSettingsResource";
import { BusinessRegistrationForm, ConfirmButton, DataTable, ErrorBanner, PermissionButton, PermissionGate } from "../../shared/ui";

export function OptionDictionarySection({ code, title, description }: { code: string; title: string; description: string }) {
  const [editingValue, setEditingValue] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<NormalizedError | null>(null);
  const [form] = Form.useForm<{ option: string }>();
  const load = useCallback(async () => {
    const set = await optionSetsApi.get(code);
    return set.options ?? [];
  }, [code]);
  const { data: loadedRows, loading, error: loadError, reload } = useSettingsResource(load);
  const rows = loadedRows ?? [];
  const error = mutationError ?? loadError;
  const canEdit = !loading && !error && loadedRows !== null;
  const reloadSection = useCallback(async () => {
    setMutationError(null);
    await reload();
  }, [reload]);
  const save = async ({ option }: { option: string }) => {
    if (!canEdit) return;
    const value = option.trim(); if (!value) return;
    const next = editingValue ? rows.map((item) => item.value === editingValue ? { value, label: value } : item) : [...rows, { value, label: value }];
    if (next.some((item, index) => next.findIndex((candidate) => candidate.value === item.value) !== index)) { form.setFields([{ name: "option", errors: [`${title}不能重复`] }]); return; }
    try { await optionSetsApi.update(code, { options: next }); clearOptionSetsCache(); appMessage.success(editingValue ? `${title}已更新` : `${title}已新增`); setEditingValue(null); form.resetFields(); setMutationError(null); await reload(); } catch (err) { setMutationError(normalizeError(err)); }
  };
  const move = async (value: string, offset: -1 | 1) => { if (!canEdit) return; const index = rows.findIndex((item) => item.value === value); const nextIndex = index + offset; if (index < 0 || nextIndex < 0 || nextIndex >= rows.length) return; const next = [...rows]; [next[index], next[nextIndex]] = [next[nextIndex], next[index]]; try { await optionSetsApi.update(code, { options: next }); clearOptionSetsCache(); setMutationError(null); await reload(); } catch (err) { setMutationError(normalizeError(err)); } };
  const columns: ColumnsType<OptionItem> = [
    { title, dataIndex: "label" },
    { title: "排序", render: (_value, _row, index) => index + 1, width: 80 },
    { title: "操作", render: (_value, row) => <PermissionGate permission="option-set.manage"><Space size={4}>
      <PermissionButton permission="option-set.manage" size="small" disabled={!canEdit} onClick={() => { setEditingValue(row.value); form.setFieldsValue({ option: row.label }); }}>编辑</PermissionButton>
      <PermissionButton permission="option-set.manage" size="small" disabled={!canEdit} onClick={() => void move(row.value, -1)}>上移</PermissionButton>
      <PermissionButton permission="option-set.manage" size="small" disabled={!canEdit} onClick={() => void move(row.value, 1)}>下移</PermissionButton>
      <ConfirmButton
        permission="option-set.manage"
        size="small"
        danger
        disabled={!canEdit}
        title={`删除${title}「${row.label}」？`}
        description="删除后不可恢复。"
        okText="删除"
        onConfirm={async () => {
          if (!canEdit) return;
          try {
            await optionSetsApi.update(code, { options: rows.filter((item) => item.value !== row.value) });
            clearOptionSetsCache();
            appMessage.success(`${title}已删除`);
            setMutationError(null);
            await reload();
          } catch (err) {
            setMutationError(normalizeError(err));
          }
        }}
      >
        删除
      </ConfirmButton>
    </Space></PermissionGate> },
  ];
  return <Card size="small" title={title}>
    <ErrorBanner error={error} onRetry={() => void reloadSection()} /><Typography.Paragraph type="secondary">{description}</Typography.Paragraph>
    <DataTable<OptionItem> columns={columns} rows={rows} page={1} pageSize={Math.max(rows.length, 10)} total={rows.length} emptyText={`暂无${title}`} onPageChange={() => undefined} pagination={false} rowKey="value" />
    <PermissionGate permission="option-set.manage"><FieldConfigScope scope="SYSDICT" active={true}><BusinessRegistrationForm form={form} layout="inline" onFinish={save} disabled={!canEdit}>
      <CfgItem name="option" label={title} rules={[{ required: true, message: `请输入${title}` }]}><Input placeholder={`请输入${title}`} /></CfgItem>
      <Form.Item><PermissionButton permission="option-set.manage" type="primary" htmlType="submit">{editingValue ? `保存${title}` : `新增${title}`}</PermissionButton></Form.Item>
      {editingValue ? <Form.Item><PermissionButton permission="option-set.manage" onClick={() => { setEditingValue(null); form.resetFields(); }}>取消编辑</PermissionButton></Form.Item> : null}
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
