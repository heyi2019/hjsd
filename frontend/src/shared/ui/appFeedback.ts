import { App } from "antd";
import { message as staticMessage } from "antd";

type Msg = typeof staticMessage;

let ctx: ReturnType<typeof App.useApp> | null = null;

/**
 * 在 <App> 内渲染一次，把 App.useApp() 的反馈实例（继承 ConfigProvider 的
 * locale/theme）绑定到模块级单例。此后全站 message/modal 统一走 App 上下文，
 * 静态方法不再脱离 React 树、丢失中文 locale。
 */
export function AppFeedbackBridge(): null {
  ctx = App.useApp();
  return null;
}

function resolveMsg(): Msg {
  return (ctx?.message ?? staticMessage) as Msg;
}

interface MsgFacade {
  success: Msg["success"];
  error: Msg["error"];
  warning: Msg["warning"];
  info: Msg["info"];
  open: Msg["open"];
  destroy: Msg["destroy"];
}

export const appMessage: MsgFacade = {
  success: ((...a: any[]) => (resolveMsg() as any).success(...a)) as Msg["success"],
  error: ((...a: any[]) => (resolveMsg() as any).error(...a)) as Msg["error"],
  warning: ((...a: any[]) => (resolveMsg() as any).warning(...a)) as Msg["warning"],
  info: ((...a: any[]) => (resolveMsg() as any).info(...a)) as Msg["info"],
  open: ((...a: any[]) => (resolveMsg() as any).open(...a)) as Msg["open"],
  destroy: ((...a: any[]) => (resolveMsg() as any).destroy(...a)) as Msg["destroy"],
};
