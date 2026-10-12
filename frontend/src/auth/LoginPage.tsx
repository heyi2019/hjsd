import { Button, Card, Form, Input, Typography } from "antd";
import { useState } from "react";
import { errorMessage } from "../shared/api/client";
import { useSession } from "../shared/state/session";

export function LoginPage() {
  const { login } = useSession();
  const [error, setError] = useState<string | null>(null);
  const submit = async (values: { username: string; password: string }) => {
    try { setError(null); await login(values.username, values.password); }
    catch (err) { setError(errorMessage(err)); }
  };
  return <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
    <Card className="glass" style={{ width: 380 }}>
      <Typography.Title level={2}>宜游轩 ERP</Typography.Title>
      <Typography.Paragraph type="secondary">请登录后进入经营工作台</Typography.Paragraph>
      {error && <Typography.Text type="danger">{error}</Typography.Text>}
      <Form layout="vertical" onFinish={submit} style={{ marginTop: 16 }}>
        <Form.Item name="username" label="用户名" rules={[{ required: true }]}><Input autoComplete="username" /></Form.Item>
        <Form.Item name="password" label="密码" rules={[{ required: true }]}><Input.Password autoComplete="current-password" /></Form.Item>
        <Button type="primary" htmlType="submit" block>登录</Button>
      </Form>
    </Card>
  </main>;
}
