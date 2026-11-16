import { Form, Input } from "antd";
import type { FormInstance } from "antd";
import type { Customer } from "../shared/api/types/customers";
import { BusinessActionModal, BusinessRegistrationForm, CompactActions, PermissionButton, Select } from "../shared/ui";

export function CustomerMergeModal({
  mergeTarget,
  candidates,
  mergeForm,
  onCancel,
  onSubmit,
}: {
  mergeTarget: Customer | null;
  candidates: Customer[] | null;
  mergeForm: FormInstance;
  onCancel: () => void;
  onSubmit: (values: Record<string, unknown>) => void;
}) {
  return (
      <BusinessActionModal size="compact"
        title={mergeTarget ? `合并客户 · ${mergeTarget.customer_no}` : "合并客户"}
        open={Boolean(mergeTarget)}
        onCancel={onCancel}
        footer={null}
      >
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope="CUSTOMER" form={mergeForm} colon={false} className="form-no-colon" onFinish={onSubmit}>
          <Form.Item name="target_customer_id" label="目标客户（必须为 ACTIVE）" rules={[{ required: true }]}>
            <Select
              options={(candidates ?? [])
                .filter((row) => row.status === "ACTIVE" && row.id !== mergeTarget?.id)
                .map((row) => ({ value: row.id, label: `${row.customer_no} ${row.display_name}` }))}
            />
          </Form.Item>
          <Form.Item name="reason" label="合并原因" rules={[{ required: true }]}>
            <Input.TextArea rows={2} />
          </Form.Item>
          <CompactActions>
            <PermissionButton permission="customer.merge" type="primary" danger htmlType="submit">
              确认合并
            </PermissionButton>
          </CompactActions>
        </BusinessRegistrationForm>
      </BusinessActionModal>
  );
}
