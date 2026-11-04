import { useState } from "react";
import { changePassword, logout, type SessionUser } from "../api";
import { ChevronIcon } from "../icons";

const ROLE_LABEL: Record<string, string> = {
  ADMIN: "管理员",
  OPERATOR: "经办人",
  FINANCE: "财务",
  AUDITOR: "审核",
  VIEWER: "只读",
};

export function MinePage({
  user,
  onSignOut,
  onUserChange,
}: {
  user: SessionUser;
  onSignOut: () => void;
  onUserChange: (next: SessionUser) => void;
}) {
  const [open, setOpen] = useState(false);
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async () => {
    if (!oldPassword || newPassword.length < 8) {
      setError("请填写当前密码，新密码至少 8 位");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await changePassword(oldPassword, newPassword);
      setNotice("密码已更新");
      setOldPassword("");
      setNewPassword("");
      setOpen(false);
      onUserChange({ ...user, must_change_password: false });
    } catch (issue) {
      setError((issue as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h5-page">
      <header className="h5-pagehead">
        <h1>我的</h1>
        <p>{user.display_name || user.username}</p>
      </header>

      <section className="h5-section">
        <div className="h5-kv">
          <div><span>用户名</span><strong>{user.username}</strong></div>
          <div><span>角色</span><strong>{ROLE_LABEL[user.role] ?? user.role}</strong></div>
          <div><span>手机号</span><strong>{user.phone || "未配置"}</strong></div>
        </div>
      </section>

      {error ? <div className="h5-alert h5-alert--error">{error}</div> : null}
      {notice ? <div className="h5-alert">{notice}</div> : null}

      <section className="h5-section">
        {open ? (
          <div className="h5-form">
            <label className="h5-field">
              <span>当前密码</span>
              <input
                type="password"
                autoComplete="current-password"
                value={oldPassword}
                onChange={(event) => setOldPassword(event.target.value)}
              />
            </label>
            <label className="h5-field">
              <span>新密码（至少 8 位）</span>
              <input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </label>
            <button type="button" className="h5-primary" disabled={busy} onClick={submit}>
              {busy ? "提交中…" : "保存新密码"}
            </button>
            <button type="button" className="h5-link" onClick={() => setOpen(false)}>取消</button>
          </div>
        ) : (
          <div className="h5-list">
            <button type="button" className="h5-row h5-row--button" onClick={() => setOpen(true)}>
              <span>修改密码</span>
              <ChevronIcon />
            </button>
          </div>
        )}
      </section>

      <button
        type="button"
        className="h5-danger"
        onClick={() => {
          void logout();
          onSignOut();
        }}
      >
        退出登录
      </button>

      <p className="h5-login__foot">宜游轩 ERP ／ 移动端</p>
    </div>
  );
}
