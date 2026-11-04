import { Button, Card, Form, Input } from "antd";
import { useState } from "react";
import { errorMessage } from "../shared/api/client";
import { useSession } from "../shared/state/session";

export function ChangePasswordPage() {
  const { changePassword, logout, passwordlessSession } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submit = async (values: { old_password?: string; new_password: string; confirm_password: string }) => {
    if (values.new_password !== values.confirm_password) { setError("两次输入的新密码不一致"); return; }
    try {
      setError(null);
      setSubmitting(true);
      await changePassword(values.old_password ?? null, values.new_password);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };
  // 免密登录（手机号验证码 / 微信）的会话从未输入过密码。这一页是登录后的强制闸门，
  // 若仍要求「当前密码」，这类账号首次登录就永远进不去——所以只设新密码。
  // 是否真的允许省略由后端判定（token 的 amr + must_change_password），前端只负责不收集。
  const skipOldPassword = passwordlessSession;
  return (
    <main className="login-shell">
      <Card className="login-card" variant="borderless">
        <div className="login-hero">
          <span className="login-brand-mark" aria-hidden="true">宜</span>
          <h1>{skipOldPassword ? "设置登录密码" : "首次登录设置密码"}</h1>
        </div>
        <p className="login-sub">
          {skipOldPassword
            ? "你本次通过免密方式登录，直接设置一个登录密码即可。"
            : "为了保护账号安全，请先修改管理员设置的初始密码。"}
        </p>
        {error ? <div id="change-password-error" className="error" role="alert">{error}</div> : null}
        <Form layout="vertical" onFinish={submit}>
          {skipOldPassword ? null : (
            <Form.Item name="old_password" label="当前密码" rules={[{ required: true, message: "请输入当前密码" }]}><Input.Password autoFocus autoComplete="current-password" aria-describedby={error ? "change-password-error" : undefined} /></Form.Item>
          )}
          <Form.Item name="new_password" label="新密码" rules={[{ required: true, min: 8, message: "密码至少 8 位" }]}><Input.Password autoFocus={skipOldPassword} autoComplete="new-password" aria-describedby={error ? "change-password-error" : undefined} /></Form.Item>
          <Form.Item name="confirm_password" label="确认新密码" rules={[{ required: true, message: "请再次输入新密码" }]}><Input.Password autoComplete="new-password" aria-describedby={error ? "change-password-error" : undefined} /></Form.Item>
          <Button type="primary" htmlType="submit" block loading={submitting}>保存新密码</Button>
          <Button type="link" block onClick={() => void logout()}>退出登录</Button>
        </Form>
      </Card>
    </main>
  );
}
