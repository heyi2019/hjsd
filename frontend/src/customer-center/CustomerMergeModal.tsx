import { Form, Input } from "antd";
import type { FormInstance } from "antd";
import type { Customer } from "../shared/api/types/customers";
import type { CustomerOption } from "../shared/api/customers.api";
import { BusinessActionModal, BusinessRegistrationForm, CompactActions, InlineError, PermissionButton, Select } from "../shared/ui";

export function CustomerMergeModal({
  mergeTarget,
  candidates,
  mergeForm,
  error,
  pending,
  onCancel,
  onSubmit,
  onSearch,
}: {
  mergeTarget: Customer | null;
  candidates: CustomerOption[] | null;
  mergeForm: FormInstance;
  error?: { message: string; code?: string } | null;
  pending?: boolean;
  onCancel: () => void;
  onSubmit: (values: Record<string, unknown>) => void;
  onSearch: (keyword: string) => void;
}) {
  return (
      <BusinessActionModal size="compact"
        title={mergeTarget ? `合并客户 · ${mergeTarget.customer_no}` : "合并客户"}
        open={Boolean(mergeTarget)}
        onCancel={onCancel}
        footer={null}
      >
        <InlineError error={error} />
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope="CUSTOMER" form={mergeForm} colon={false} className="form-no-colon" onFinish={onSubmit}>
          <Form.Item name="target_customer_id" label="目标客户（需为有效客户）" rules={[{ required: true }]}>
            <Select
              showSearch
              placeholder="输入客户编号、姓名或联系方式搜索"
              filterOption={false}
              onSearch={onSearch}
              options={(candidates ?? [])
                .filter((row) => row.id !== mergeTarget?.id)
                .map((row) => ({ value: row.id, label: `${row.customer_no} ${row.display_name}` }))}
            />
          </Form.Item>
          <Form.Item name="reason" label="合并原因" rules={[{ required: true }]}>
            <Input.TextArea rows={2} />
          </Form.Item>
          <CompactActions>
            <PermissionButton permission="customer.merge" type="primary" danger htmlType="submit" loading={pending}>
              确认合并
            </PermissionButton>
          </CompactActions>
        </BusinessRegistrationForm>
      </BusinessActionModal>
  );
}
