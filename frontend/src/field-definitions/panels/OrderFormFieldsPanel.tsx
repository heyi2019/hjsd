/** 建单表单字段配置面板：按业务类型（回收/提号/代挂/代分期）配置字段的
 *  新增、删除、必填/选填（行内开关）、停用/启用。字段可配置必填态与启用态；
 *  仅自定义字段可删除（预置字段受保护）。 */
import { Card, Form, Input, InputNumber, Popconfirm, Select, Space, Switch, Tooltip, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { orderFormFieldsApi, type OrderFormField } from "../../shared/api/catalog";
import { normalizeError } from "../../shared/api/client";
import { FIELD_TYPE_LABEL } from "../../shared/lib/labels";
import { FORM_SCOPE_GROUPED_OPTIONS, FORM_SCOPE_LABEL } from "../formScopes";
import { ConfirmButton, DataTable, ErrorBanner, PermissionButton, PermissionGate, StatusTag } from "../../shared/ui";

const FIELD_TYPE_OPTIONS = Object.entries(FIELD_TYPE_LABEL).map(([value, label]) => ({ value, label }));
const OPTION_FIELD_TYPES = ["SELECT", "MULTI_SELECT"];

const parseOptions = (raw: unknown): string[] | undefined => {
  const text = typeof raw === "string" ? raw : "";
  const items = text.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
  return items.length ? items : undefined;
};

export function OrderFormFieldsPanel() {
  const [activeType, setActiveType] = useState<string>("HS");
  const [rows, setRows] = useState<OrderFormField[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [form] = Form.useForm();
  const fieldType = Form.useWatch("field_type", form);
  const needsOptions = OPTION_FIELD_TYPES.includes(fieldType as string);

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

  const submit = async (values: Record<string, unknown>) => {
    try {
      const sortOrder = Number(values.sort_order ?? 0);
      const required = Boolean(values.required);
      const options = needsOptions ? (parseOptions(values.options) ?? []) : undefined;
      if (editingId === null) {
        await orderFormFieldsApi.create({
          order_type_code: activeType,
          field_key: values.field_key as string,
          label: values.label as string,
          field_type: (values.field_type as string) ?? "TEXT",
          options,
          required,
          sort_order: sortOrder,
        });
        message.success("字段已创建");
      } else {
        await orderFormFieldsApi.update(editingId, {
          label: values.label as string,
          options,
          required,
          sort_order: sortOrder,
        });
        message.success("字段已更新");
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
      options: row.options?.join("，") ?? "",
      required: Boolean(row.required),
      sort_order: row.sort_order,
    });
  };

  const cancelEditing = () => {
    setEditingId(null);
    form.resetFields();
  };

  const columns: ColumnsType<OrderFormField> = [
    { title: "字段键", dataIndex: "field_key" },
    { title: "标签", dataIndex: "label" },
    { title: "类型", dataIndex: "field_type", render: (v: string) => FIELD_TYPE_LABEL[v] ?? v },
    {
      title: "必填",
      dataIndex: "required",
      render: (value: boolean, row: OrderFormField) => (
        <PermissionGate
          permission="field-definition.manage"
          fallback={<Typography.Text type="secondary">{value ? "必填" : "选填"}</Typography.Text>}
        >
          <Switch
            checked={value}
            loading={togglingId === row.id}
            aria-label={`必填_${row.field_key}`}
            onChange={async (checked: boolean) => {
              try {
                setTogglingId(row.id);
                await orderFormFieldsApi.update(row.id, { required: checked });
                message.success(checked ? "已设为必填" : "已设为选填");
                await load(activeType);
              } catch (err) {
                setError(normalizeError(err));
              } finally {
                setTogglingId(null);
              }
            }}
          />
        </PermissionGate>
      ),
    },
    { title: "选项", dataIndex: "options", render: (value: string[] | null | undefined) => (value?.length ? value.join("、") : "-") },
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
                ? "停用后该字段从建单表单消失（自定义字段值保留在订单数据中）。"
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
                      message.success("字段已删除");
                      await load(activeType);
                    } catch (err) {
                      setError(normalizeError(err));
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

  return (
    <Card className="glass" title="表单字段配置">
      <ErrorBanner error={error} onRetry={() => void load(activeType)} />
      <Typography.Paragraph type="secondary">
        选择上方「表单」可配置任意业务表单的字段：建单（回收/提号/代挂/代分期）、库存（售出/寄售/返点）、
        客户需求池、分期（收款/回收/出售/换绑/取消/结清/违约/减免/展期）、返点（新建/结算/冲销）、
        资金（占用/流水/划转/对账/核销/拒绝/冲销/释放/损失/修复/月结）。
        可新增自定义字段、删除自定义字段（仅自定义字段可删）、停用/启用；
        「必填」列提供行内开关，点击即在必填/选填间切换。改动即时反映到对应表单。
        当前：{FORM_SCOPE_LABEL[activeType] ?? activeType}
      </Typography.Paragraph>
      <Space style={{ marginBottom: 16 }} align="center">
        <Typography.Text strong>表单</Typography.Text>
        <Select
          style={{ width: 260 }}
          value={activeType}
          onChange={(value: string) => {
            setActiveType(value);
            setEditingId(null);
            form.resetFields();
          }}
          options={FORM_SCOPE_GROUPED_OPTIONS}
          optionFilterProp="label"
          showSearch
        />
      </Space>
      <DataTable<OrderFormField>
        columns={columns}
        rows={rows}
        page={1}
        pageSize={Math.max(rows.length, 10)}
        total={rows.length}
        emptyText="该表单暂无字段配置"
        onPageChange={() => undefined}
      />
      <PermissionGate permission="field-definition.manage">
        <Form
          form={form}
          layout="inline"
          onFinish={submit}
          className="ui-form-spaced"
          initialValues={{ field_type: "TEXT", sort_order: 0 }}
        >
          <Form.Item name="field_key" label="字段键" rules={[{ required: true }]}>
            <Input placeholder="小写下划线，如 vip_tag" disabled={editingId !== null} />
          </Form.Item>
          <Form.Item name="label" label="标签" rules={[{ required: true }]}>
            <Input placeholder="页面显示名" />
          </Form.Item>
          <Form.Item name="field_type" label="类型">
            <Select options={FIELD_TYPE_OPTIONS} className="ui-control-width-110" disabled={editingId !== null} />
          </Form.Item>
          {needsOptions && (
            <Form.Item name="options" label="选项">
              <Input placeholder="逗号分隔，如 是,否" className="ui-control-width-200" />
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
