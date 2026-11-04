import { useCallback, useEffect, useRef, useState } from "react";
import {
  TOKEN_KEY,
  confirmWechatBind,
  fetchLoginMethods,
  loginWithPassword,
  loginWithPhone,
  loginWithWechat,
  requestWechatAuthorize,
  sendPhoneCode,
  sendWechatBindCode,
  type LoginMethods,
  type PasswordlessResult,
} from "../api";
import { WeChatIcon } from "../icons";

type Mode = "password" | "phone";

const WECHAT_CHANNEL_KEY = "hj.h5.wechat-channel";

function isWeChatBrowser(): boolean {
  return /micromessenger/i.test(navigator.userAgent);
}

export function LoginPage({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [mode, setMode] = useState<Mode>("password");
  const [methods, setMethods] = useState<LoginMethods | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [codeTicket, setCodeTicket] = useState("");
  const [countdown, setCountdown] = useState(0);

  // 微信首次登录需要绑定后台已配置的手机号；这里保存后端返回的绑定票据。
  const [bind, setBind] = useState<PasswordlessResult | null>(null);
  const [bindPhone, setBindPhone] = useState("");
  const [bindCode, setBindCode] = useState("");
  const [bindTicket, setBindTicket] = useState("");
  const [bindPassword, setBindPassword] = useState("");

  const callbackHandled = useRef(false);

  const persist = useCallback(
    async (token: string) => {
      localStorage.setItem(TOKEN_KEY, token);
      await onSignedIn();
    },
    [onSignedIn],
  );

  useEffect(() => {
    void fetchLoginMethods()
      .then(setMethods)
      .catch(() => setMethods(null));
  }, []);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setTimeout(() => setCountdown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  // 微信授权回跳：?code=..&state=..。一次只处理一次，处理完清掉 query，
  // 否则用户刷新页面会拿同一个（一次性的）code 再换一次，必然失败。
  useEffect(() => {
    if (callbackHandled.current) return;
    const params = new URLSearchParams(window.location.search);
    const callbackCode = params.get("code");
    const state = params.get("state");
    if (!callbackCode || !state) return;
    callbackHandled.current = true;

    const channel = (sessionStorage.getItem(WECHAT_CHANNEL_KEY) ?? "h5") as "web" | "h5";
    window.history.replaceState(null, "", window.location.pathname);

    setBusy(true);
    void loginWithWechat(callbackCode, state, channel)
      .then(async (result) => {
        if (result.status === "logged_in" && result.access_token) {
          await persist(result.access_token);
          return;
        }
        setBind(result);
        setBindPhone(result.phone_hint ?? "");
        setNotice(result.message ?? "请先绑定后台已配置的手机号");
      })
      .catch((issue: Error) => setError(issue.message))
      .finally(() => setBusy(false));
  }, [persist]);

  const submitPassword = async () => {
    if (!username.trim() || !password) {
      setError("请输入用户名与密码");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await persist(await loginWithPassword(username.trim(), password));
    } catch (issue) {
      setError((issue as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const requestCode = async () => {
    if (!/^1[3-9]\d{9}$/.test(phone.trim())) {
      setError("请输入正确的 11 位手机号");
      return;
    }
    setError(null);
    try {
      const challenge = await sendPhoneCode(phone.trim());
      setCodeTicket(challenge.code_ticket);
      setCountdown(60);
      setNotice(
        challenge.dev_code ? `演示环境验证码：${challenge.dev_code}` : "验证码已发送，请查收短信",
      );
    } catch (issue) {
      setError((issue as Error).message);
    }
  };

  const submitPhone = async () => {
    if (!phone.trim() || !code.trim() || !codeTicket) {
      setError("请先获取并填写验证码");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await persist(await loginWithPhone(phone.trim(), code.trim(), codeTicket));
    } catch (issue) {
      setError((issue as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const startWechat = async () => {
    setBusy(true);
    setError(null);
    try {
      sessionStorage.setItem(WECHAT_CHANNEL_KEY, "h5");
      const redirectUri = `${window.location.origin}${window.location.pathname}`;
      const { authorize_url } = await requestWechatAuthorize("h5", redirectUri);
      window.location.href = authorize_url;
    } catch (issue) {
      setError((issue as Error).message);
      setBusy(false);
    }
  };

  const requestBindCode = async () => {
    if (!bind || !/^1[3-9]\d{9}$/.test(bindPhone.trim())) {
      setError("请输入正确的 11 位手机号");
      return;
    }
    setError(null);
    try {
      const challenge = await sendWechatBindCode(bind.bind_ticket ?? "", bindPhone.trim());
      setBindTicket(challenge.code_ticket);
      setCountdown(60);
      setNotice(
        challenge.dev_code ? `演示环境验证码：${challenge.dev_code}` : "验证码已发送，请查收短信",
      );
    } catch (issue) {
      setError((issue as Error).message);
    }
  };

  const submitBind = async () => {
    if (!bind) return;
    setBusy(true);
    setError(null);
    try {
      const result = await confirmWechatBind({
        bindTicket: bind.bind_ticket ?? "",
        phone: bindPhone.trim(),
        code: bind.verify_mode === "password" ? undefined : bindCode.trim(),
        codeTicket: bind.verify_mode === "password" ? undefined : bindTicket,
        password: bind.verify_mode === "password" ? bindPassword : undefined,
      });
      if (result.access_token) await persist(result.access_token);
    } catch (issue) {
      setError((issue as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const wechatReady = Boolean(methods?.wechat_h5.enabled);
  const wechatReason = methods?.wechat_h5.reason ?? "微信 H5 登录未启用";
  const inWeChat = isWeChatBrowser();

  return (
    <div className="h5-login">
      <header className="h5-login__hero">
        <div className="h5-login__brand">
          <span className="h5-login__mark" aria-hidden>宜</span>
          宜游轩 ERP
        </div>
        <h1>{bind ? "绑定手机号" : "登录工作台"}</h1>
        <p>
          {bind
            ? "首次微信登录需绑定后台已配置的手机号"
            : "使用管理员分配给你的账号进入工作台"}
        </p>
      </header>

      <div className="h5-login__body">
        <section className="h5-login__card">
          {error ? <div className="h5-alert h5-alert--error" role="alert">{error}</div> : null}
          {notice ? <div className="h5-alert">{notice}</div> : null}

        {bind ? (
          <div className="h5-form">
            <label className="h5-field">
              <span>手机号</span>
              <input
                inputMode="numeric"
                autoComplete="tel"
                placeholder="后台已配置的手机号"
                value={bindPhone}
                onChange={(event) => setBindPhone(event.target.value)}
              />
            </label>
            {bind.verify_mode === "password" ? (
              <label className="h5-field">
                <span>账号密码</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  placeholder="用于确认你是该账号本人"
                  value={bindPassword}
                  onChange={(event) => setBindPassword(event.target.value)}
                />
              </label>
            ) : (
              <label className="h5-field">
                <span>短信验证码</span>
                <div className="h5-field__row">
                  <input
                    inputMode="numeric"
                    maxLength={6}
                    autoComplete="one-time-code"
                    placeholder="6 位验证码"
                    value={bindCode}
                    onChange={(event) => setBindCode(event.target.value)}
                  />
                  <button type="button" className="h5-ghost" disabled={countdown > 0} onClick={requestBindCode}>
                    {countdown > 0 ? `${countdown}s` : "获取验证码"}
                  </button>
                </div>
              </label>
            )}
            <button type="button" className="h5-primary" disabled={busy} onClick={submitBind}>
              {busy ? "处理中…" : "绑定并登录"}
            </button>
            <button
              type="button"
              className="h5-link"
              onClick={() => {
                setBind(null);
                setNotice(null);
                setError(null);
              }}
            >
              返回其他登录方式
            </button>
          </div>
        ) : (
          <>
            <div className="h5-switch" role="tablist" aria-label="登录方式">
              <button
                type="button"
                role="tab"
                aria-selected={mode === "password"}
                className={mode === "password" ? "is-active" : ""}
                onClick={() => {
                  setMode("password");
                  setError(null);
                  setNotice(null);
                }}
              >
                账号密码
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "phone"}
                className={mode === "phone" ? "is-active" : ""}
                disabled={methods ? !methods.phone_code.enabled : false}
                onClick={() => {
                  setMode("phone");
                  setError(null);
                  setNotice(null);
                }}
              >
                手机号验证码
              </button>
            </div>

            {mode === "password" ? (
              <div className="h5-form">
                <label className="h5-field">
                  <span>用户名</span>
                  <input
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    placeholder="请输入用户名"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                  />
                </label>
                <label className="h5-field">
                  <span>密码</span>
                  <input
                    type="password"
                    autoComplete="current-password"
                    placeholder="请输入密码"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </label>
                <button type="button" className="h5-primary" disabled={busy} onClick={submitPassword}>
                  {busy ? "登录中…" : "登录"}
                </button>
              </div>
            ) : (
              <div className="h5-form">
                <label className="h5-field">
                  <span>手机号</span>
                  <input
                    inputMode="numeric"
                    autoComplete="tel"
                    placeholder="后台已配置的手机号"
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                  />
                </label>
                <label className="h5-field">
                  <span>短信验证码</span>
                  <div className="h5-field__row">
                    <input
                      inputMode="numeric"
                      maxLength={6}
                      autoComplete="one-time-code"
                      placeholder="6 位验证码"
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                    />
                    <button type="button" className="h5-ghost" disabled={countdown > 0} onClick={requestCode}>
                      {countdown > 0 ? `${countdown}s` : "获取验证码"}
                    </button>
                  </div>
                </label>
                <button type="button" className="h5-primary" disabled={busy} onClick={submitPhone}>
                  {busy ? "登录中…" : "登录"}
                </button>
              </div>
            )}

            <div className="h5-login__divider"><span>或</span></div>

            <button
              type="button"
              className="h5-wechat"
              disabled={busy || !wechatReady}
              onClick={startWechat}
            >
              <WeChatIcon />
              <span>{busy ? "跳转中…" : "微信登录"}</span>
            </button>
            <p className="h5-login__hint">
              {wechatReady
                ? inWeChat
                  ? "首次登录需绑定后台已配置的手机号"
                  : "微信网页授权需在微信内打开本页"
                : wechatReason}
            </p>
          </>
        )}
        </section>
      </div>

      <footer className="h5-login__foot">宜游轩 ERP · 移动端</footer>
    </div>
  );
}
