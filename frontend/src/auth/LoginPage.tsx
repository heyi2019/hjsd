import { Button, Card, Form, Input } from "antd";
import { useEffect, useState } from "react";
import { checkBackendHealth, errorMessage } from "../shared/api/client";
import { useSession } from "../shared/state/session";

export function LoginPage() {
  const { login } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    void checkBackendHealth().catch((err) => {
      if (active) setError(errorMessage(err));
    });
    return () => {
      active = false;
    };
  }, []);

  const submit = async (values: { username: string; password: string }) => {
    try {
      setError(null);
      setSubmitting(true);
      await login(values.username, values.password);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <main className="login-shell">
      <section className="login-aside" aria-label="产品介绍">
        <div className="login-aside__topline">
          <span className="login-brand-mark" aria-hidden="true">宜</span>
          <span>宜游轩</span>
        </div>
        <div className="login-aside__content">
          <p className="login-kicker">业务运营中枢</p>
          <h1>经营，<br /><em>进入高速模式。</em></h1>
          <p className="login-aside__copy">订单、资金、库存与利润，在一个工作台里实时同步。</p>
        </div>
        <div className="login-aside__footer">
          <span>订单</span><i /> <span>资金</span><i /> <span>经营</span>
        </div>
      </section>
      <Card className="login-card" variant="borderless">
        <div className="login-card-head">
          <p className="login-kicker">欢迎回来</p>
          <h2>登录工作台</h2>
          <p className="login-sub">使用你的账号继续经营工作</p>
        </div>
        {error ? <div id="login-error" className="error" role="alert">{error}</div> : null}
        <Form layout="vertical" onFinish={submit}>
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }]}>
            <Input autoFocus autoComplete="username" aria-describedby={error ? "login-error" : undefined} />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}>
            <Input.Password autoComplete="current-password" aria-describedby={error ? "login-error" : undefined} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={submitting}>登录</Button>
        </Form>
        <p className="login-card-foot">宜游轩 ERP <span>／</span> V1.0@宜游轩技术团队</p>
      </Card>
    </main>
  );
}
