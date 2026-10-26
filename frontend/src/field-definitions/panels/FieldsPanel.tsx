import { Card, Form, Input, InputNumber, Popconfirm, Select, Space, Switch, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { fieldsApi, optionSetsApi, type FieldDefinition, type OptionSet } from "../../shared/api/catalog";
import { normalizeError } from "../../shared/api/client";
import { ENTITY_TYPE_LABEL, FIELD_TYPE_LABEL } from "../../shared/lib/labels";
import { configurableLabel, useOptionSet } from "../../shared/lib/optionSets";
import { ConfirmButton, DataTable, ErrorBanner, PermissionButton, PermissionGate, StatusTag } from "../../shared/ui";

const FIELD_TYPE_OPTIONS = Object.entries(FIELD_TYPE_LABEL).map(([value, label]) => ({ value, label }));
const ENTITY_TYPE_OPTIONS = Object.entries(ENTITY_TYPE_LABEL).map(([value, label]) => ({ value, label }));
const OPTION_FIELD_TYPES = ["SELECT", "MULTI_SELECT"];

export interface FieldsPanelProps {
  /** 在设置页中挂载时，可跳转到字段关联的配置环节。 */
  onNavigate?: (key: string) => void;
}

const parseOptions = (raw: unknown): string[] | undefined => {
  const text = typeof raw === "string" ? raw : "";
  const items = text.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
  return items.length ? items : undefined;
};

export function FieldsPanel({ onNavigate }: FieldsPanelProps = {}) {
  // 词典未加载时回落模块常量，保证与改造前完全一致。
  const fieldTypeOptions = useOptionSet("FIELD_TYPE") ?? FIELD_TYPE_OPTIONS;
  // 活字段实体仅支持 EntityType 枚举的 8 个值，不能暴露 ENTITY_TYPE 词典的 30 种审计裸码。
  // 词典加载时只保留活字段支持的子集，未加载时回落 ENTITY_TYPE_OPTIONS（同源）。
  const entityOptionSet = useOptionSet("ENTITY_TYPE");
  const entityTypeOptions = entityOptionSet?.filter((o) => ENTITY_TYPE_LABEL[o.value]) ?? ENTITY_TYPE_OPTIONS;
  const [rows, setRows] = useState<FieldDefinition[]>([]);
  const [optionSets, setOptionSets] = useState<OptionSet[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
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
  useEffect(() => {
    void optionSetsApi.list().then((result) => setOptionSets(result.items)).catch(() => undefined);
  }, []);

  const submit = async (values: Record<string, unknown>) => {
    try {
      const sortOrder = Number(values.sort_order ?? 0);
      const required = Boolean(values.required);
      const optionSetCode = needsOptions ? (values.option_set_code as string | undefined) || undefined : undefined;
      const options = needsOptions && !optionSetCode ? (parseOptions(values.options) ?? []) : undefined;
      if (editingId === null) {
        await fieldsApi.create({
          entity_type: values.entity_type as string,
          field_key: values.field_key as string,
          label: values.label as string,
          field_type: (values.field_type as string) ?? "TEXT",
          options,
          option_set_code: optionSetCode,
          required,
          sort_order: sortOrder,
        });
        message.success("活字段已创建");
      } else {
        await fieldsApi.update(editingId, {
          label: values.label as string,
          options,
          option_set_code: optionSetCode,
          required,
          sort_order: sortOrder,
        });
        message.success("活字段已更新");
      }
      setEditingId(null);
      form.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const startEditing = (row: FieldDefinition) => {
    setEditingId(row.id);
    form.setFieldsValue({
      entity_type: row.entity_type,
      field_key: row.field_key,
      label: row.label,
      field_type: row.field_type,
      options: row.options?.join("，") ?? "",
      option_set_code: row.option_set_code ?? undefined,
      required: Boolean(row.required),
      sort_order: row.sort_order,
    });
  };

  const cancelEditing = () => {
    setEditingId(null);
    form.resetFields();
  };

  const columns: ColumnsType<FieldDefinition> = [
    { title: "实体", dataIndex: "entity_type", render: (v: string) => configurableLabel("ENTITY_TYPE", v, ENTITY_TYPE_LABEL) },
    { title: "字段键", dataIndex: "field_key" },
    { title: "标签", dataIndex: "label" },
    { title: "类型", dataIndex: "field_type", render: (v: string) => configurableLabel("FIELD_TYPE", v, FIELD_TYPE_LABEL) },
    { title: "必填", dataIndex: "required", render: (value: boolean) => (value ? "是" : "否") },
    { title: "选项", dataIndex: "options", render: (value: string[] | null | undefined) => (value?.length ? value.join("、") : "-") },
    {
      title: "启用",
      dataIndex: "is_active",
      render: (value: boolean) => <StatusTag status={value ? "ACTIVE" : "DISABLED"} label={value ? "是" : "否"} />,
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
                ? "停用后该字段从所有表单消失，已填写的历史值保留。"
                : "启用后该字段重新出现在表单中。"}
              danger={row.is_active}
              onConfirm={async () => {
                await fieldsApi.setActive(row.id, !row.is_active);
                await load();
              }}
            >
              {row.is_active ? "停用" : "启用"}
            </ConfirmButton>
          </Space>
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
            <PermissionButton permission="field-definition.manage" size="small" danger>删除</PermissionButton>
          </Popconfirm>
        </PermissionGate>
      ),
    },
  ];

  return (
    <Card className="glass" title="扩展字段">
      <ErrorBanner error={error} onRetry={() => void load()} />
      <Typography.Paragraph type="secondary">
        扩展字段仅承载辅助信息，不得覆盖核算字段；有历史值只能停用，无历史值可删除（BAS-04）。
      </Typography.Paragraph>
      {onNavigate ? (
        <Space wrap style={{ marginBottom: 16 }}>
          <PermissionButton permission="field-definition.manage" onClick={() => onNavigate("form-fields")}>配置表单字段</PermissionButton>
          <PermissionButton permission="option-set.manage" onClick={() => onNavigate("option-sets")}>维护选项词典</PermissionButton>
        </Space>
      ) : null}
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
            <Select options={entityTypeOptions} className="ui-control-width-120" disabled={editingId !== null} />
          </Form.Item>
          <Form.Item name="field_key" label="字段键" rules={[{ required: true }]}>
            <Input placeholder="小写下划线，如 credit_level" disabled={editingId !== null} />
          </Form.Item>
          <Form.Item name="label" label="标签" rules={[{ required: true }]}>
            <Input placeholder="页面显示名" />
          </Form.Item>
          <Form.Item name="field_type" label="类型">
            <Select options={fieldTypeOptions} className="ui-control-width-110" disabled={editingId !== null} />
          </Form.Item>
          {needsOptions && (
            <Form.Item name="option_set_code" label="引用词典">
              <Select allowClear placeholder="字段专用选项" options={optionSets.map((set) => ({ value: set.code, label: `${set.label}（${set.code}）` }))} className="ui-control-width-200" />
            </Form.Item>
          )}
          {needsOptions && (
            <Form.Item name="options" label="选项">
              <Input placeholder="逗号分隔，如 优质,观察,黑名单" className="ui-control-width-200" />
            </Form.Item>
          )}
          <Form.Item name="required" label="必填" valuePropName="checked"><Switch /></Form.Item>
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
    </Card>
  );
}
