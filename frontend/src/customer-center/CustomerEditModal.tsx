import { Form, Input } from "antd";
import type { FormInstance } from "antd";
import type { Customer } from "../shared/api/types/customers";
import type { OrderFormField } from "../shared/api/types/forms";
import { BusinessActionModal, BusinessRegistrationForm, dateValueFromEvent, dateValueProps, InlineError, PermissionButton } from "../shared/ui";
import { ExtraFieldControl } from "./CustomersPage.fragments";

export function CustomerEditModal({
  editTarget,
  activeDefs,
  editForm,
  error,
  pending,
  onCancel,
  onSubmit,
}: {
  editTarget: Customer | null;
  activeDefs: OrderFormField[];
  editForm: FormInstance;
  error?: { message: string; code?: string } | null;
  pending?: boolean;
  onCancel: () => void;
  onSubmit: (values: Record<string, unknown>) => void;
}) {
  return (
      <BusinessActionModal
        title={editTarget ? `编辑客户 · ${editTarget.customer_no}` : "编辑客户"}
        fieldCount={6 + activeDefs.length}
        open={Boolean(editTarget)}
        onCancel={onCancel}
        footer={null}
        destroyOnHidden
      >
        <InlineError error={error} />
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }}
          scope="CUSTOMER"
          form={editForm}
          colon={false}
          className="form-no-colon"
          onFinish={onSubmit}
          initialValues={
            editTarget
              ? {
                  display_name: editTarget.display_name,
                  contact_name: editTarget.contact_name ?? "",
                  phone: editTarget.phone ?? "",
                  wechat: editTarget.wechat ?? "",
                  qq: editTarget.qq ?? "",
                  note: editTarget.note ?? "",
                  ...Object.fromEntries(
                    activeDefs.map((def) => [def.field_key, editTarget.extra_values?.[def.field_key]]),
                  ),
                }
              : undefined
          }
        >
          <Form.Item name="display_name" label="名字" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <div className="form-cols-2">
            <Form.Item name="contact_name" label="联系人姓名">
              <Input />
            </Form.Item>
            <Form.Item name="phone" label="手机号">
              <Input />
            </Form.Item>
            <Form.Item name="wechat" label="微信号">
              <Input />
            </Form.Item>
            <Form.Item name="qq" label="QQ">
              <Input />
            </Form.Item>
          </div>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={3} />
          </Form.Item>
          {activeDefs.map((def) => (
            <Form.Item
              key={def.field_key}
              name={def.field_key}
              label={def.label}
              valuePropName={def.field_type === "BOOLEAN" ? "checked" : "value"}
              getValueFromEvent={def.field_type === "DATE" ? dateValueFromEvent : undefined}
              getValueProps={def.field_type === "DATE" ? dateValueProps : undefined}
              rules={def.required ? [{ required: true, message: `请填写${def.label}` }] : []}
            >
              <ExtraFieldControl def={def} />
            </Form.Item>
          ))}
          <PermissionButton permission="customer.update" type="primary" htmlType="submit" loading={pending}>
            保存
          </PermissionButton>
        </BusinessRegistrationForm>
      </BusinessActionModal>
  );
}
