import { Form, Input, Modal, Select, Space, Typography } from "antd";
import { useEffect } from "react";
import { configToFields, fieldsToConfig, policyConfigFields } from "./policyConfigSchema";
import { today } from "./policyConstants";

export interface PolicyVersionSubmit {
  effective_from: string;
  effective_to?: string;
  config: Record<string, unknown>;
  note?: string;
}

interface PolicyVersionEditorModalProps {
  open: boolean;
  code: string;
  /** 预填的初始配置（通常取当前生效版本的 config）。 */
  initialConfig: Record<string, unknown>;
  confirmLoading: boolean;
  onCancel: () => void;
  onOk: (values: PolicyVersionSubmit) => void;
}

/** 结构化配置编辑器：按规则编码渲染字段，替代原裸 JSON 文本框。
 * 保存即生成新版本并立即发布（无需审批环节）。 */
export function PolicyVersionEditorModal({
  open,
  code,
  initialConfig,
  confirmLoading,
  onCancel,
  onOk,
}: PolicyVersionEditorModalProps) {
  const [form] = Form.useForm<Record<string, string>>();
  const fields = policyConfigFields(code);

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      effective_from: today(),
      effective_to: undefined,
      note: undefined,
      ...configToFields(code, initialConfig),
    });
  }, [open, code, initialConfig, form]);

  const onFinish = (values: Record<string, string>) => {
    const { effective_from, effective_to, note, ...rest } = values;
    onOk({
      effective_from,
      effective_to: effective_to || undefined,
      config: fieldsToConfig(code, rest),
      note: note || undefined,
    });
  };

  return (
    <Modal
      open={open}
      title="设置配置"
      okText="保存"
      cancelText="取消"
      confirmLoading={confirmLoading}
      onCancel={onCancel}
      onOk={() => void form.submit()}
    >
      <Form form={form} layout="vertical" onFinish={onFinish}>
        <Space direction="horizontal" size="middle" className="policy-version-date-row">
          <Form.Item
            name="effective_from"
            label="生效日期"
            rules={[{ required: true, message: "请选择生效日期" }]}
            className="policy-version-date-row__item"
          >
            <Input type="date" />
          </Form.Item>
          <Form.Item name="effective_to" label="失效日期" className="policy-version-date-row__item">
            <Input type="date" />
          </Form.Item>
        </Space>

        {fields.length === 0 ? (
          <Typography.Paragraph type="secondary">
            该规则暂无需配置的参数；保存即生成一条新版本并立即生效。
          </Typography.Paragraph>
        ) : (
          fields.map((f) => (
            <Form.Item
              key={f.key}
              name={f.key}
              label={f.label}
              extra={f.help}
              rules={[{ required: true, message: `请输入${f.label}` }]}
            >
              {f.kind === "select" ? (
                <Select options={f.options} />
              ) : (
                <Input placeholder={f.placeholder} />
              )}
            </Form.Item>
          ))
        )}

        <Form.Item name="note" label="变更说明">
          <Input.TextArea rows={2} placeholder="可选，说明本次版本变更" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
