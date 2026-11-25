/** 用户中心：当前账号信息、修改用户名和修改密码。 */
import { appMessage } from "../../shared/ui/appFeedback";
import { Button, Card, Form, Input } from "antd";
import { useState } from "react";
import { ErrorBanner } from "../../shared/ui";
import { normalizeError } from "../../shared/api/client";
import { DEV_ROLES, ROLE_PERMISSIONS, useSession } from "../../shared/state/session";
import { PERMISSION_LABEL } from "../../shared/lib/labels";

export function UserCenterPage() {
  const { username, role, changeUsername, changePassword } = useSession();
  const [usernameError, setUsernameError] = useState<{ message: string; code?: string } | null>(null);
  const [savingUsername, setSavingUsername] = useState(false);
  const [usernameForm] = Form.useForm();
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();
  const roleLabel = DEV_ROLES.find((r) => r.value === role)?.label ?? "未设置角色";
  const permissions = ROLE_PERMISSIONS[role] ?? [];

  const submitUsername = async (values: { username: string; current_password: string }) => {
    setUsernameError(null);
    setSavingUsername(true);
    try {
      await changeUsername(values.username.trim(), values.current_password);
      usernameForm.resetFields();
      appMessage.success("用户名已更新");
    } catch (err) {
      setUsernameError(normalizeError(err));
    } finally {
      setSavingUsername(false);
    }
  };

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

      <Card title="修改用户名" className="user-center__card">
        <ErrorBanner error={usernameError} />
        <Form name="change-username" form={usernameForm} layout="vertical" className="user-center__form" onFinish={submitUsername}>
          <Form.Item label="当前用户名">
            <span className="user-center__username">{username}</span>
          </Form.Item>
          <Form.Item name="username" label="更改用户名" rules={[
            { required: true, whitespace: true, message: "请输入新用户名" },
            { min: 2, max: 64, transform: (value: string | undefined) => value?.trim(), message: "用户名须为 2 至 64 个字符" },
          ]}>
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item name="current_password" label="当前密码" rules={[{ required: true }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={savingUsername}>修改用户名</Button>
        </Form>
      </Card>

      <Card title="修改密码" className="user-center__card">
        <ErrorBanner error={error} />
        <Form form={form} layout="vertical" className="user-center__form" onFinish={submit}>
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
        </Form>
      </Card>
    </div>
  );
}
