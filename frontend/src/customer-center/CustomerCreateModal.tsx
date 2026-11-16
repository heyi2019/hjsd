import { Form, Input, Typography } from "antd";
import type { FormInstance } from "antd";
import { CfgItem, FieldConfigScope } from "../orders/ConfigurableField";
import type { OrderFormField } from "../shared/api/types/forms";
import { BusinessActionModal, BusinessRegistrationForm, BusinessRegistrationSection, PermissionButton } from "../shared/ui";
import { ExtraFieldControl } from "./CustomersPage.fragments";

const CUSTOMER_CREATE_FORM_ID = "customer-create-form";

export function CustomerCreateModal({
  createOpen,
  activeDefs,
  form,
  onCancel,
  onSubmit,
}: {
  createOpen: boolean;
  activeDefs: OrderFormField[];
  form: FormInstance;
  onCancel: () => void;
  onSubmit: (values: Record<string, unknown>) => void;
}) {
  return (
      <BusinessActionModal
        title="新建客户"
        open={createOpen}
        onCancel={() => onCancel()}
        wrapClassName="customer-create-modal"
        fieldCount={5 + activeDefs.length}
        footer={(
          <PermissionButton permission="customer.create" type="primary" htmlType="submit" form={CUSTOMER_CREATE_FORM_ID}>
            建档
          </PermissionButton>
        )}
      >
        <FieldConfigScope scope="CUSTOMER" active={createOpen}>
          <BusinessRegistrationForm
            id={CUSTOMER_CREATE_FORM_ID}
            layout="horizontal"
            labelAlign="left"
            labelCol={{ flex: "108px" }}
            wrapperCol={{ flex: "auto" }}
            scope="CUSTOMER"
            form={form}
            colon={false}
            className="form-no-colon customer-create-form"
            onFinish={onSubmit}
          >
            <BusinessRegistrationSection className="customer-create-section" title="客户信息">
              <CfgItem name="display_name" label="名字" rules={[{ required: true }] }>
                <Input />
              </CfgItem>
              <CfgItem name="contact_name" label="联系人姓名">
                <Input />
              </CfgItem>
              <CfgItem name="phone" label="手机号">
                <Input />
              </CfgItem>
              <CfgItem name="wechat" label="微信号">
                <Input />
              </CfgItem>
              <CfgItem name="qq" label="QQ">
                <Input />
              </CfgItem>
              <CfgItem name="note" label="备注">
                <Input.TextArea rows={3} placeholder="选填：客户来源、偏好、注意事项等" />
              </CfgItem>
              {activeDefs.map((def) => (
                <Form.Item
                  key={def.field_key}
                  name={def.field_key}
                  label={def.label}
                  valuePropName={def.field_type === "BOOLEAN" ? "checked" : "value"}
                  rules={def.required ? [{ required: true, message: `请填写${def.label}` }] : []}
                >
                  <ExtraFieldControl def={def} />
                </Form.Item>
              ))}
              <Typography.Paragraph type="secondary" className="customer-create-note">
                联系方式允许重复；重复只提示候选，不拦截建档。扩展字段在「设置 › 表单字段 › 客户建档」维护，可随时增删。
              </Typography.Paragraph>
            </BusinessRegistrationSection>
          </BusinessRegistrationForm>
        </FieldConfigScope>
      </BusinessActionModal>
  );
}
