/** 资金操作抽屉：金额类动作必须走抽屉/弹窗提交，禁止列表内直接过账。 */
import { Button, Drawer, Form, Input, InputNumber, Select, Space } from "antd";
import type { ReactNode } from "react";

export interface DrawerField {
  name: string;
  label: string;
  required?: boolean;
  /** 金额字段：以字符串提交，避免浮点尾差。 */
  kind?: "text" | "money" | "date" | "select" | "number" | "textarea";
  initialValue?: unknown;
  options?: { value: string | number; label: string }[];
  placeholder?: string;
}

export function FormDrawer(props: {
  open: boolean;
  title: string;
  fields: DrawerField[];
  submitting?: boolean;
  submitText?: string;
  extra?: ReactNode;
  onClose: () => void;
  onSubmit: (values: Record<string, unknown>) => void;
}) {
  const [form] = Form.useForm();
  return (
    <Drawer
      className="form-drawer"
      title={props.title}
      open={props.open}
      onClose={props.onClose}
      width={460}
      destroyOnHidden
      footer={
        <Space className="ui-drawer-actions">
          <Button onClick={props.onClose}>取消</Button>
          <Button
            type="primary"
            loading={props.submitting}
            onClick={() => {
              // 校验失败由表单内联错误承载；这里必须吞掉 rejection，
              // 否则每次点提交都产生一个 unhandled promise rejection（测试与控制台都会报）。
              form
                .validateFields()
                .then((values) => props.onSubmit(values))
                .catch(() => undefined);
            }}
          >
            {props.submitText ?? "提交"}
          </Button>
        </Space>
      }
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={Object.fromEntries(
          props.fields
            .filter((f) => f.initialValue !== undefined)
            .map((f) => [f.name, f.initialValue]),
        )}
      >
        {props.fields.map((field) => (
          <Form.Item
            key={field.name}
            name={field.name}
            label={field.label}
            rules={field.required ? [{ required: true, message: `请输入${field.label}` }] : []}
          >
            {field.kind === "money" ? (
              <Input placeholder={field.placeholder ?? "0.00"} inputMode="decimal" />
            ) : field.kind === "number" ? (
              <InputNumber className="ui-control-full" />
            ) : field.kind === "textarea" ? (
              <Input.TextArea rows={3} placeholder={field.placeholder} />
            ) : field.kind === "select" ? (
              <Select
                allowClear
                placeholder={field.placeholder ?? "请选择"}
                options={field.options}
              />
            ) : (
              <Input placeholder={field.placeholder} />
            )}
          </Form.Item>
        ))}
      </Form>
      {props.extra}
    </Drawer>
  );
}
