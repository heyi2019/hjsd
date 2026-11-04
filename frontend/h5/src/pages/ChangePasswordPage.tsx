import { useState } from "react";
import { changePassword, type SessionUser } from "../api";

/**
 * 强制改密闸门（H5 版）。
 *
 * 与桌面端同一套后端规则：免密登录（手机号验证码 / 微信）进来的会话、且尚未自设密码时，
 * 可以不填「当前密码」——否则这类账号首次登录永远进不来（新建账号默认
 * must_change_password=true，而改密页却要一个他从未输入过的密码）。
 * 是否真的允许省略由后端判定，前端只负责不收集。
 */
export function ChangePasswordPage({
  user,
  onDone,
  onSignOut,
}: {
  user: SessionUser;
  onDone: () => Promise<void>;
  onSignOut: () => void;
}) {
  const passwordless = user.auth_method !== "password";
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (newPassword.length < 8) {
      setError("新密码至少 8 位");
      return;
    }
    if (newPassword !== repeat) {
      setError("两次输入的新密码不一致");
      return;
    }
    if (!passwordless && !oldPassword) {
      setError("请输入当前密码");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await changePassword(passwordless ? null : oldPassword, newPassword);
      await onDone();
    } catch (issue) {
      setError((issue as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h5-login">
      <section className="h5-login__card h5-login__card--plain">
        <h2>{passwordless ? "设置登录密码" : "修改登录密码"}</h2>
        <p className="h5-login__sub">
          {passwordless
            ? "你本次通过免密方式登录，直接设置一个登录密码即可"
            : "为保障账号安全，请设置新的登录密码"}
        </p>

        {error ? <div className="h5-alert h5-alert--error" role="alert">{error}</div> : null}

        <div className="h5-form">
          {passwordless ? null : (
            <label className="h5-field">
              <span>当前密码</span>
              <input
                type="password"
                autoComplete="current-password"
                value={oldPassword}
                onChange={(event) => setOldPassword(event.target.value)}
              />
            </label>
          )}
          <label className="h5-field">
            <span>新密码（至少 8 位）</span>
            <input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </label>
          <label className="h5-field">
            <span>确认新密码</span>
            <input
              type="password"
              autoComplete="new-password"
              value={repeat}
              onChange={(event) => setRepeat(event.target.value)}
            />
          </label>
          <button type="button" className="h5-primary" disabled={busy} onClick={submit}>
            {busy ? "提交中…" : "保存并进入"}
          </button>
          <button type="button" className="h5-link" onClick={onSignOut}>退出登录</button>
        </div>
      </section>
    </div>
  );
}
