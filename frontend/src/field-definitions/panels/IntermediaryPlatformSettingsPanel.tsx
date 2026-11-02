import { appMessage } from "../../shared/ui/appFeedback";
import { Card, Form, Input, Space, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { optionSetsApi, type OptionItem } from "../../shared/api/catalog";
import { normalizeError } from "../../shared/api/client";
import { BusinessForm, ConfirmButton, DataTable, ErrorBanner, PermissionButton, PermissionGate } from "../../shared/ui";

export function OptionDictionarySection({ code, title, description }: { code: string; title: string; description: string }) {
  const [rows, setRows] = useState<OptionItem[]>([]);
  const [editingValue, setEditingValue] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [form] = Form.useForm<{ option: string }>();
  const load = useCallback(async () => { try { const set = await optionSetsApi.get(code); setRows(set.options ?? []); setError(null); } catch (err) { setError(normalizeError(err)); } }, [code]);
  useEffect(() => { void load(); }, [load]);
  const save = async ({ option }: { option: string }) => {
    const value = option.trim(); if (!value) return;
    const next = editingValue ? rows.map((item) => item.value === editingValue ? { value, label: value } : item) : [...rows, { value, label: value }];
    if (next.some((item, index) => next.findIndex((candidate) => candidate.value === item.value) !== index)) { form.setFields([{ name: "option", errors: [`${title}不能重复`] }]); return; }
    try { await optionSetsApi.update(code, { options: next }); appMessage.success(editingValue ? `${title}已更新` : `${title}已新增`); setEditingValue(null); form.resetFields(); await load(); } catch (err) { setError(normalizeError(err)); }
  };
  const move = async (value: string, offset: -1 | 1) => { const index = rows.findIndex((item) => item.value === value); const nextIndex = index + offset; if (index < 0 || nextIndex < 0 || nextIndex >= rows.length) return; const next = [...rows]; [next[index], next[nextIndex]] = [next[nextIndex], next[index]]; try { await optionSetsApi.update(code, { options: next }); await load(); } catch (err) { setError(normalizeError(err)); } };
  const columns: ColumnsType<OptionItem> = [
    { title, dataIndex: "label" },
    { title: "排序", render: (_value, _row, index) => index + 1, width: 80 },
    { title: "操作", render: (_value, row) => <PermissionGate permission="option-set.manage"><Space size={4}>
      <PermissionButton permission="option-set.manage" size="small" onClick={() => { setEditingValue(row.value); form.setFieldsValue({ option: row.label }); }}>编辑</PermissionButton>
      <PermissionButton permission="option-set.manage" size="small" onClick={() => void move(row.value, -1)}>上移</PermissionButton>
      <PermissionButton permission="option-set.manage" size="small" onClick={() => void move(row.value, 1)}>下移</PermissionButton>
      <ConfirmButton
        permission="option-set.manage"
        size="small"
        danger
        title={`删除${title}「${row.label}」？`}
        description="删除后不可恢复。"
        okText="删除"
        onConfirm={async () => {
          await optionSetsApi.update(code, { options: rows.filter((item) => item.value !== row.value) });
          appMessage.success(`${title}已删除`);
          await load();
        }}
      >
        删除
      </ConfirmButton>
    </Space></PermissionGate> },
  ];
  return <Card size="small" title={title}>
    <ErrorBanner error={error} onRetry={() => void load()} /><Typography.Paragraph type="secondary">{description}</Typography.Paragraph>
    <DataTable<OptionItem> columns={columns} rows={rows} page={1} pageSize={Math.max(rows.length, 10)} total={rows.length} emptyText={`暂无${title}`} onPageChange={() => undefined} pagination={false} rowKey="value" />
    <PermissionGate permission="option-set.manage"><BusinessForm form={form} layout="inline" onFinish={save}>
      <Form.Item name="option" label={title} rules={[{ required: true, message: `请输入${title}` }]}><Input placeholder={`请输入${title}`} /></Form.Item>
      <Form.Item><PermissionButton permission="option-set.manage" type="primary" htmlType="submit">{editingValue ? `保存${title}` : `新增${title}`}</PermissionButton></Form.Item>
      {editingValue ? <Form.Item><PermissionButton permission="option-set.manage" onClick={() => { setEditingValue(null); form.resetFields(); }}>取消编辑</PermissionButton></Form.Item> : null}
    </BusinessForm></PermissionGate>
  </Card>;
}

export function IntermediaryPlatformSettingsPanel() {
  return <Card className="glass" title="中介业务配置">
    <Typography.Paragraph type="secondary">统一维护附加费用相关业务字典；修改后会同步到回收、提号等建单表单。</Typography.Paragraph>
    <div className="ui-stack">
      <OptionDictionarySection code="INTERMEDIARY_PLATFORM" title="经手平台" description="维护回收、提号等业务使用的经手平台。" />
      <OptionDictionarySection code="INTERMEDIARY_TYPE" title="中介类型" description="维护中介费的业务类型选项。" />
      <OptionDictionarySection code="COMPENSATION_TYPE" title="包赔类型" description="维护包赔相关的保障类型选项。" />
    </div>
  </Card>;
}
