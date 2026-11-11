import { Form, Input, Modal, Typography } from "antd";
import { useEffect } from "react";
import type { Account } from "../../shared/api/catalog";

/** 账号删除的二次确认框：点击行内「删除」不算数，必须在这里填写原因并再点「确认删除」。
 *
 * 与 ConfirmDialog（纯确认）分工不同：删除原因要随请求落审计日志，因此需要表单收集输入。
 * 弹窗只负责收集与必填校验；提交、失败提示与列表刷新都在 controller 里，失败时保持打开可重试。
 */
export function InventoryDeleteDialog({ account, submitting, onCancel, onConfirm }: {
  account: Account | null;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [form] = Form.useForm<{ reason: string }>();
  // 每次换账号都清掉上一次的原因，避免把 A 账号的删除原因误提交给 B 账号。
  useEffect(() => {
    if (!account) return;
    form.resetFields();
  }, [account, form]);

  return (
    // autoInsertSpace 已在 main.tsx 全局 ConfigProvider 统一关闭，此处不再局部重复包裹。
    <Modal
      open={Boolean(account)}
      title="删除账号"
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
        即将删除
        <strong>{account ? ` ${account.stock_no ?? `账号 ${account.id}`}（${account.game_account ?? "未填游戏账号"}）` : ""}</strong>
        。此操作不可恢复，请二次确认。
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary">
        关联的订单、资金流水与返点记录会保留，但不再关联此账号；删除原因将写入审计日志。
      </Typography.Paragraph>
      <Form
        form={form}
        layout="vertical"
        onFinish={(values) => void onConfirm(values.reason.trim())}
      >
        <Form.Item
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
        </Form.Item>
      </Form>
    </Modal>
  );
}
