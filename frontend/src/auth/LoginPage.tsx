import { Button, Card, Form, Input, Segmented } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkBackendHealth,
  confirmWechatBind,
  errorMessage,
  fetchLoginMethods,
  phoneLogin,
  requestWechatAuthorize,
  sendPhoneLoginCode,
  sendWechatBindCode,
  wechatLogin,
} from "../shared/api/client";
import type { CodeChallenge, LoginMethods } from "../shared/api/client";
import { useSession } from "../shared/state/session";

type Mode = "password" | "phone";

type BindState = {
  ticket: string;
  verifyMode: "sms" | "password";
  message: string;
};

const RESEND_SECONDS = 60;

/** 三种登录方式共用一张卡：账号密码、手机号验证码、微信。
 * 系统不开放注册——能登录的账号必须先在「设置-用户」里建好，手机号也要在这里配齐，
 * 否则验证码与微信都会在服务端被拒绝（前端不做假放行）。 */
export function LoginPage() {
  const { login, loginWithToken } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [methods, setMethods] = useState<LoginMethods | null>(null);
  const [mode, setMode] = useState<Mode>("password");
  const [challenge, setChallenge] = useState<CodeChallenge | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [bind, setBind] = useState<BindState | null>(null);
  const [bindChallenge, setBindChallenge] = useState<CodeChallenge | null>(null);
  const [wechatBusy, setWechatBusy] = useState(false);
  // 说明（2026-11-05 实测）：`Form.useForm()` 拿到的实例与页面实际渲染的表单**不是同一个**
  // （getFieldsValue() 恒为 {}，而表单自身 store 有值），导致「获取验证码」永远读不到手机号。
  // 因此不依赖 useForm 实例，改用 onValuesChange 把值镜像进 React state：调用点一致、可测。
  const [phoneValues, setPhoneValues] = useState<Record<string, string>>({});
  const [bindValues, setBindValues] = useState<Record<string, string>>({});
  const callbackHandled = useRef(false);

  // 重发倒计时：验证码 60 秒内不可重复获取，按钮必须如实反映。
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setTimeout(() => setCountdown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  const handleWechatCallback = useCallback(
    async (code: string, state: string) => {
      setWechatBusy(true);
      setError(null);
      try {
        const result = await wechatLogin(code, state);
        if (result.status === "logged_in" && result.access_token && result.user) {
          loginWithToken(result.access_token, result.user);
          return;
        }
        if (result.bind_ticket) {
          setBind({
            ticket: result.bind_ticket,
            verifyMode: result.verify_mode ?? "sms",
            message: result.message ?? "首次使用微信登录，请先绑定手机号",
          });
          setBindChallenge(null);
        }
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setWechatBusy(false);
      }
    },
    [loginWithToken],
  );

  useEffect(() => {
    let active = true;
    void checkBackendHealth().catch((err) => {
      if (active) setError(errorMessage(err));
    });
    // 用 async IIFE 而不是 .then：即使实现同步抛出，也不会变成未捕获异常把整页打白。
    void (async () => {
      try {
        const data = await fetchLoginMethods();
        if (active) setMethods(data);
      } catch {
        // 取不到登录方式时退回「只有账号密码」，不让整页卡在加载态。
        if (active) setMethods(null);
      }
    })();

    // 微信回跳：微信会把 ?code=&state= 拼在回调地址后面。处理完立刻清掉 query，
    // 否则刷新页面会拿同一个已失效的 code 再换一次 token 而报错。
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    if (code && state && !callbackHandled.current) {
      callbackHandled.current = true;
      window.history.replaceState({}, "", `${window.location.pathname}${window.location.hash}`);
      void handleWechatCallback(code, state);
    }

    return () => {
      active = false;
    };
  }, [handleWechatCallback]);

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

  const requestPhoneCode = async () => {
    const phone = (phoneValues.phone ?? "").trim();
    if (!phone) {
      setError("请先输入手机号");
      return;
    }
    try {
      setError(null);
      const sent = await sendPhoneLoginCode(phone);
      setChallenge(sent);
      setCountdown(RESEND_SECONDS);
      setNotice(sent.dev_code ? `演示环境验证码：${sent.dev_code}` : "验证码已发送，请查收短信");
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const submitPhone = async (values: { phone: string; code: string }) => {
    if (!challenge) {
      setError("请先获取验证码");
      return;
    }
    try {
      setError(null);
      setSubmitting(true);
      const result = await phoneLogin(values.phone, values.code, challenge.code_ticket);
      if (result.access_token && result.user) {
        loginWithToken(result.access_token, result.user);
        return;
      }
      setError("登录未完成，请重试");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const beginWechat = async () => {
    try {
      setError(null);
      setWechatBusy(true);
      const redirect = `${window.location.origin}${window.location.pathname}`;
      const data = await requestWechatAuthorize(redirect);
      window.location.assign(data.authorize_url);
    } catch (err) {
      setError(errorMessage(err));
      setWechatBusy(false);
    }
  };

  const requestBindCode = async () => {
    if (!bind) return;
    const phone = (bindValues.phone ?? "").trim();
    if (!phone) {
      setError("请先输入手机号");
      return;
    }
    try {
      setError(null);
      const sent = await sendWechatBindCode(bind.ticket, phone);
      setBindChallenge(sent);
      setCountdown(RESEND_SECONDS);
      setNotice(sent.dev_code ? `演示环境验证码：${sent.dev_code}` : "验证码已发送，请查收短信");
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const submitBind = async (values: { phone: string; code?: string; password?: string }) => {
    if (!bind) return;
    try {
      setError(null);
      setSubmitting(true);
      const result = await confirmWechatBind({
        bind_ticket: bind.ticket,
        phone: values.phone,
        code_ticket: bindChallenge?.code_ticket,
        code: values.code,
        password: values.password,
      });
      if (result.access_token && result.user) {
        loginWithToken(result.access_token, result.user);
        return;
      }
      setError("绑定未完成，请重试");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const cancelBind = () => {
    setBind(null);
    setBindChallenge(null);
    setNotice(null);
    setError(null);
  };

  const showPhone = methods?.phone_code.enabled ?? false;
  const showWechat = methods?.wechat.enabled ?? false;

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
          <h2>{bind ? "绑定手机号" : "登录工作台"}</h2>
          <p className="login-sub">
            {bind ? bind.message : "使用你的账号继续经营工作"}
          </p>
        </div>
        {error ? <div id="login-error" className="error" role="alert">{error}</div> : null}
        {notice ? <p className="login-notice" role="status">{notice}</p> : null}

        {bind ? (
          <Form layout="vertical" onFinish={submitBind} className="login-bind" onValuesChange={(_, all) => setBindValues(all as Record<string, string>)}>
            <p className="login-bind__hint">
              微信需要与系统中已配置的手机号绑定后才能登录；绑定后再次使用微信登录无需验证码。
            </p>
            <Form.Item
              name="phone"
              label="手机号"
              rules={[{ required: true, message: "请输入手机号" }]}
            >
              <Input autoFocus autoComplete="tel" inputMode="numeric" placeholder="后台已配置的手机号" />
            </Form.Item>
            {bind.verifyMode === "sms" ? (
              <Form.Item
                name="code"
                label="短信验证码"
                rules={[{ required: true, message: "请输入验证码" }]}
              >
                <Input
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  maxLength={6}
                  addonAfter={
                    <Button type="link" size="small" disabled={countdown > 0} onClick={requestBindCode}>
                      {countdown > 0 ? `${countdown}s 后重发` : "获取验证码"}
                    </Button>
                  }
                />
              </Form.Item>
            ) : (
              <Form.Item
                name="password"
                label="账号密码"
                rules={[{ required: true, message: "请输入账号密码" }]}
              >
                <Input.Password autoComplete="current-password" placeholder="用于确认你是该账号本人" />
              </Form.Item>
            )}
            <Button type="primary" htmlType="submit" block loading={submitting}>绑定并登录</Button>
            <Button type="link" block onClick={cancelBind}>返回其他登录方式</Button>
          </Form>
        ) : (
          <>
            {showPhone ? (
              <Segmented
                className="login-method-switch"
                block
                value={mode}
                onChange={(value) => {
                  setMode(value as Mode);
                  setError(null);
                  setNotice(null);
                }}
                options={[
                  { label: "账号密码", value: "password" },
                  { label: "手机号验证码", value: "phone" },
                ]}
              />
            ) : null}

            {/* 表单与微信入口同属「登录动作」，自成一组：.login-card-body 的 24px 节奏
                只管「标题 / 切换器 / 动作组」三段之间，按钮之间用组内 12px。 */}
            <div className="login-actions">
            {mode === "phone" && showPhone ? (
              <Form layout="vertical" onFinish={submitPhone} onValuesChange={(_, all) => setPhoneValues(all as Record<string, string>)}>
                <Form.Item
                  name="phone"
                  label="手机号"
                  rules={[{ required: true, message: "请输入手机号" }]}
                >
                  <Input autoFocus autoComplete="tel" inputMode="numeric" placeholder="后台已配置的手机号" />
                </Form.Item>
                <Form.Item
                  name="code"
                  label="短信验证码"
                  rules={[{ required: true, message: "请输入验证码" }]}
                >
                  <Input
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    maxLength={6}
                    addonAfter={
                      <Button type="link" size="small" disabled={countdown > 0} onClick={requestPhoneCode}>
                        {countdown > 0 ? `${countdown}s 后重发` : "获取验证码"}
                      </Button>
                    }
                  />
                </Form.Item>
                <Button type="primary" htmlType="submit" block loading={submitting}>登录</Button>
              </Form>
            ) : (
              <Form layout="vertical" onFinish={submit}>
                <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }]}>
                  <Input autoFocus autoComplete="username" aria-describedby={error ? "login-error" : undefined} />
                </Form.Item>
                <Form.Item
                  name="password"
                  label="密码"
                  rules={[{ required: !import.meta.env.DEV, message: "请输入密码" }]}
                >
                  <Input.Password autoComplete="current-password" aria-describedby={error ? "login-error" : undefined} />
                </Form.Item>
                <Button type="primary" htmlType="submit" block loading={submitting}>登录</Button>
              </Form>
            )}

            {showWechat ? (
              <div className="login-platform">
                <Button block loading={wechatBusy} onClick={beginWechat}>微信登录</Button>
                <p className="login-platform__hint">首次登录需绑定后台已配置的手机号</p>
              </div>
            ) : null}
            </div>
          </>
        )}

        <p className="login-card-foot">宜游轩 ERP <span>／</span> V1.0@宜游轩技术团队</p>
      </Card>
    </main>
  );
}
