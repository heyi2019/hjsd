import { useState } from "react";
import { changePassword, logout, type SessionUser } from "../api";
import { ROLE_LABEL } from "../labels";
import { ChevronIcon, WalletIcon } from "../icons";
import { navigate } from "../router";

const AUTH_METHOD_LABEL: Record<string, string> = {
  password: "账号密码",
  phone_code: "手机验证码",
  wechat: "微信授权",
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

  const name = user.display_name || user.username;
  // 头像取「用户名」首字而非显示名：显示名常是「系统管理员」这类角色化描述，
  // 取首字会得到毫无意义的「系」；用户名（admin / xuanxuan / 三三）才指向具体的人。
  const initial = (user.username || name).slice(0, 1).toUpperCase();

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
        <p>账号与登录安全</p>
      </header>

      <section className="h5-profile">
        <span className="h5-avatar" aria-hidden>{initial}</span>
        <div className="h5-profile__main">
          <p className="h5-profile__name">{name}</p>
          <p className="h5-profile__meta">
            {ROLE_LABEL[user.role] ?? user.role} · {user.username}
          </p>
        </div>
      </section>

      {error ? <div className="h5-alert h5-alert--error" role="alert">{error}</div> : null}
      {notice ? <div className="h5-alert">{notice}</div> : null}

      <section className="h5-section">
        <div className="h5-kv">
          <div><span>用户名</span><strong>{user.username}</strong></div>
          <div><span>角色</span><strong>{ROLE_LABEL[user.role] ?? user.role}</strong></div>
          <div><span>手机号</span><strong>{user.phone || "未配置"}</strong></div>
          <div>
            <span>本次登录</span>
            <strong>{AUTH_METHOD_LABEL[user.auth_method ?? "password"] ?? "账号密码"}</strong>
          </div>
        </div>
      </section>

      {/*
        资金中心入口放在「我的」：资金是低频查看型功能，占底栏一格会挤掉「建单」。
        入口要显眼可见（不能藏进设置二级菜单），因为查余额是常用动作。
      */}
      <section className="h5-section">
        <div className="h5-section__head"><h2>更多功能</h2></div>
        <div className="h5-list">
          <button type="button" className="h5-row h5-row--link" onClick={() => navigate("/funds")}>
            <span className="h5-row__icon h5-row__icon--green" aria-hidden>
              <WalletIcon size={20} />
            </span>
            <div className="h5-row__main">
              <div className="h5-row__title"><strong>资金中心</strong></div>
              <p className="h5-row__meta">账户余额 · 流水 · 对账 · 押金</p>
            </div>
            <ChevronIcon />
          </button>
        </div>
      </section>

      <section className="h5-section">
        {open ? (
          <div className="h5-login__card">
            <h2>修改密码</h2>
            <p className="h5-login__sub">新密码至少 8 位，修改后其他设备需重新登录</p>
            <div className="h5-form">
              <label className="h5-field">
                <span>当前密码</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  placeholder="请输入当前密码"
                  value={oldPassword}
                  onChange={(event) => setOldPassword(event.target.value)}
                />
              </label>
              <label className="h5-field">
                <span>新密码</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder="至少 8 位"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </label>
              <button type="button" className="h5-primary" disabled={busy} onClick={submit}>
                {busy ? "提交中…" : "保存新密码"}
              </button>
              <button
                type="button"
                className="h5-link"
                onClick={() => {
                  setOpen(false);
                  setError(null);
                }}
              >
                取消
              </button>
            </div>
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

      <p className="h5-page-foot">宜游轩 ERP · 移动端</p>
    </div>
  );
}
