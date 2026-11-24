import { appMessage } from "../../shared/ui/appFeedback";
/** 用户中心：当前账号/角色信息 + 修改登录密码（顶栏入口进入）。
 *  区别于 auth/ChangePasswordPage（首登强制改密）：本组件挂载在顶栏「用户中心」Modal 内，
 *  改密走同一 changePassword API（后端校验旧密码），成功后本次会话直接生效。
 *  onClose 由 Modal 容器注入：退出登录需先关弹窗再 logout。 */
import { Button, Card, Form, Input } from "antd";
import { useState } from "react";
import { ConfirmButton, ErrorBanner } from "../../shared/ui";
import { normalizeError } from "../../shared/api/client";
import { DEV_ROLES, ROLE_PERMISSIONS, useSession } from "../../shared/state/session";
import { PERMISSION_LABEL } from "../../shared/lib/labels";

export function UserCenterPage({ onClose }: { onClose?: () => void }) {
  const { role, changePassword, logout } = useSession();
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();
  const roleLabel = DEV_ROLES.find((r) => r.value === role)?.label ?? "未设置角色";
  const permissions = ROLE_PERMISSIONS[role] ?? [];

  const submit = async (values: { old_password: string; new_password: string; confirm_password: string }) => {
    if (values.new_password !== values.confirm_password) {
      setError({ message: "两次输入的新密码不一致" });
      return;
    }
    try {
      setError(null);
      setSubmitting(true);
      await changePassword(values.old_password, values.new_password);
      appMessage.success("密码已更新");
      form.resetFields();
    } catch (err) {
      // 出错保留已填内容（含旧密码），仅顶部横幅提示，不清空表单。
      setError(normalizeError(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="user-center">
      <Card title="账号信息" className="user-center__card">
        <dl className="user-center__meta">
          <div>
            <dt>当前角色</dt>
          <dd>{roleLabel}</dd>
          </div>
          <div>
            <dt>权限范围</dt>
            <dd>{permissions.length} 个权限点</dd>
          </div>
        </dl>
        <ul className="user-center__perms" aria-label="权限点列表">
          {permissions.map((p) => (
            <li key={p}>{PERMISSION_LABEL[p] ?? "其他权限"}</li>
          ))}
        </ul>
      </Card>

      <Card title="修改密码" className="user-center__card">
        <ErrorBanner error={error} />
        <Form form={form} layout="vertical" className="user-center__password-form" onFinish={submit}>
          <Form.Item name="old_password" label="当前密码" rules={[{ required: true }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Form.Item
            name="new_password"
            label="新密码"
            rules={[{ required: true, min: 8, message: "密码至少 8 位" }]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="confirm_password" label="确认新密码" rules={[{ required: true }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={submitting}>修改密码</Button>
          <ConfirmButton
            type="primary"
            danger
            className="user-center__logout"
            title="确认退出登录？"
            description="退出后需重新登录，未保存的修改会丢失。"
            okText="确认退出"
            cancelText="取消"
            onConfirm={async () => { onClose?.(); void logout(); }}
          >
            退出登录
          </ConfirmButton>
        </Form>
      </Card>
    </div>
  );
}
