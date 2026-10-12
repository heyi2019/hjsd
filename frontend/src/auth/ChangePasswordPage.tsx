import { Button, Card, Form, Input, Typography } from "antd";
import { useState } from "react";
import { errorMessage } from "../shared/api/client";
import { useSession } from "../shared/state/session";

export function ChangePasswordPage() {
  const { changePassword, logout } = useSession();
  const [error, setError] = useState<string | null>(null);
  const submit = async (values: { old_password: string; new_password: string; confirm_password: string }) => {
    if (values.new_password !== values.confirm_password) { setError("两次输入的新密码不一致"); return; }
    try { setError(null); await changePassword(values.old_password, values.new_password); }
    catch (err) { setError(errorMessage(err)); }
  };
  return <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
    <Card className="glass" style={{ width: 420 }}>
      <Typography.Title level={2}>首次登录设置密码</Typography.Title>
      <Typography.Paragraph type="secondary">为了保护账号安全，请先修改管理员设置的初始密码。</Typography.Paragraph>
      {error && <Typography.Text type="danger">{error}</Typography.Text>}
      <Form layout="vertical" onFinish={submit} style={{ marginTop: 16 }}>
        <Form.Item name="old_password" label="当前密码" rules={[{ required: true }]}><Input.Password autoComplete="current-password" /></Form.Item>
        <Form.Item name="new_password" label="新密码" rules={[{ required: true, min: 8, message: "密码至少 8 位" }]}><Input.Password autoComplete="new-password" /></Form.Item>
        <Form.Item name="confirm_password" label="确认新密码" rules={[{ required: true }]}><Input.Password autoComplete="new-password" /></Form.Item>
        <Button type="primary" htmlType="submit" block>保存新密码</Button>
        <Button type="link" block onClick={() => void logout()}>退出登录</Button>
      </Form>
    </Card>
  </main>;
}
