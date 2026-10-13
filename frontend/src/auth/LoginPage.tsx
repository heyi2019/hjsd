import { Button, Card, Form, Input } from "antd";
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
  return (
    <main className="login-shell">
      <Card className="login-card" variant="borderless">
        <div className="login-hero">
          <span className="login-brand-mark" aria-hidden="true">宜</span>
          <h1>宜游轩 ERP</h1>
        </div>
        <p className="login-sub">请登录后进入经营工作台</p>
        {error ? <div className="error" role="alert">{error}</div> : null}
        <Form layout="vertical" onFinish={submit}>
          <Form.Item name="username" label="用户名" rules={[{ required: true }]}>
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>登录</Button>
        </Form>
      </Card>
    </main>
  );
}
