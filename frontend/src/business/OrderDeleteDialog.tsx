import { CfgItem, FieldConfigScope } from "./ConfigurableField";
import { Form, Input, Modal, Typography } from "antd";
import { useEffect } from "react";
import type { Order } from "../shared/api/types/orders";

/** 物理删除二次确认：订单、绑定库存及其从属业务数据全部清除，删除原因写入审计日志。 */
export function OrderDeleteDialog({ order, submitting, onCancel, onConfirm }: {
  order: Order | null;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [form] = Form.useForm<{ reason: string }>();

  useEffect(() => {
    if (order) form.resetFields();
  }, [order, form]);

  return (
    <Modal
      open={Boolean(order)}
      title="删除"
      okText="确认删除"
      cancelText="取消"
      okButtonProps={{ danger: true, loading: submitting }}
      cancelButtonProps={{ disabled: submitting }}
      onOk={() => form.submit()}
      onCancel={() => { if (!submitting) onCancel(); }}
      maskClosable={false}
      keyboard={!submitting}
      className="heijin-fast-confirm"
    >
      <Typography.Paragraph>
        即将删除 <strong>{order?.order_no ?? ""}</strong> 及其关联的库存账号。
        此操作不可恢复，请二次确认。
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary">
        订单、事件、资金流水、分润、分期、返点、押金和订单关联等数据都会被清除，删除原因将写入审计日志。
      </Typography.Paragraph>
      <FieldConfigScope scope="ORDDELETE" active={Boolean(order)}><Form
        form={form}
        layout="vertical"
        onFinish={(values) => void onConfirm(values.reason.trim())}
      >
        <CfgItem alwaysActive
          name="reason"
          label="删除原因"
          rules={[
            { required: true, message: "请填写删除原因" },
            {
              validator: (_, value) => String(value ?? "").trim()
                ? Promise.resolve()
                : Promise.reject(new Error("删除原因不能为空")),
            },
          ]}
        >
          <Input.TextArea
            aria-label="删除原因"
            rows={3}
            maxLength={200}
            showCount
            placeholder="请填写删除原因（必填，将写入审计日志）"
          />
        </CfgItem>
      </Form></FieldConfigScope>
    </Modal>
  );
}
