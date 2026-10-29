import { Form, Input, Modal, Typography } from "antd";
import { Select } from "../shared/ui";
import { useEffect } from "react";
import { SCOPE_OPTIONS, today } from "./policyConstants";
import { describeConfig } from "./policyConfigSchema";

export interface PolicyResolveValues {
  policy_code: string;
  on: string;
  scope_type: string;
  scope_id?: string;
}

export interface PolicyResolveResult {
  found: boolean;
  version: {
    version: number;
    effective_from: string;
    effective_to?: string | null;
    status: string;
    config: Record<string, unknown>;
  } | null;
}

interface PolicyResolveModalProps {
  open: boolean;
  initialCode?: string;
  policyTypeOptions: { value: string; label: string }[];
  scopeOptions: { value: string; label: string }[];
  resolving: boolean;
  result: PolicyResolveResult | null;
  onCancel: () => void;
  onOk: (values: PolicyResolveValues) => void;
}

/** 规则生效期自查：解析某日某作用域实际命中的版本（发布只影响生效日之后的新单）。 */
export function PolicyResolveModal({
  open,
  initialCode,
  policyTypeOptions,
  scopeOptions,
  resolving,
  result,
  onCancel,
  onOk,
}: PolicyResolveModalProps) {
  const [form] = Form.useForm<PolicyResolveValues>();
  const scopeType = Form.useWatch("scope_type", form);

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({ policy_code: initialCode ?? "", on: today(), scope_type: "GLOBAL", scope_id: undefined });
  }, [open, initialCode, form]);

  return (
    <Modal
      open={open}
      title="规则生效期自查"
      okText="解析"
      cancelText="取消"
      confirmLoading={resolving}
      onCancel={onCancel}
      onOk={() => void form.submit()}
    >
      <Form form={form} layout="vertical" onFinish={onOk}>
        <Typography.Paragraph type="secondary">
          解析某个日期实际命中的规则版本——发布只影响生效日之后的新单，历史订单按建单时固化的快照计算，不随改版变化。
        </Typography.Paragraph>
        <Form.Item name="policy_code" label="规则编码" rules={[{ required: true, message: "请选择规则编码" }]}>
          <Select options={policyTypeOptions} placeholder="选择规则编码" />
        </Form.Item>
        <Form.Item name="on" label="生效日期" rules={[{ required: true, message: "请选择生效日期" }]}>
          <Input type="date" />
        </Form.Item>
        <Form.Item name="scope_type" label="适用范围" initialValue="GLOBAL" rules={[{ required: true, message: "请选择适用范围" }]}>
          <Select options={scopeOptions} />
        </Form.Item>
        <Form.Item
          name="scope_id"
          label="范围 ID"
          rules={scopeType && scopeType !== "GLOBAL" ? [{ required: true, message: "请输入范围 ID" }] : []}
        >
          <Input type="number" min={1} placeholder="按人员、业务类型或资金池时填写" />
        </Form.Item>
        {result ? (
          result.found && result.version ? (
            <Typography.Paragraph>
              命中版本 <b>v{result.version.version}</b>（{result.version.effective_from} ~ {result.version.effective_to ?? "至今"}，状态{" "}
              {result.version.status}）：
              {describeConfig(result.version.config)}
            </Typography.Paragraph>
          ) : (
            <Typography.Paragraph type="warning">
              该日该作用域没有生效的规则版本，新单不会套用此规则。
            </Typography.Paragraph>
          )
        ) : null}
      </Form>
    </Modal>
  );
}
