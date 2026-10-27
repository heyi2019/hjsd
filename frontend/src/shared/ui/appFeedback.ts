import { App } from "antd";
import { message as staticMessage, Modal as StaticModal } from "antd";

type Msg = typeof staticMessage;
type Mod = typeof StaticModal;

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
function resolveMod(): Mod {
  return (ctx?.modal ?? StaticModal) as Mod;
}

interface MsgFacade {
  success: Msg["success"];
  error: Msg["error"];
  warning: Msg["warning"];
  info: Msg["info"];
  open: Msg["open"];
  destroy: Msg["destroy"];
}
interface ModFacade {
  confirm: Mod["confirm"];
  info: Mod["info"];
  success: Mod["success"];
  warning: Mod["warning"];
  error: Mod["error"];
}

export const appMessage: MsgFacade = {
  success: ((...a: any[]) => (resolveMsg() as any).success(...a)) as Msg["success"],
  error: ((...a: any[]) => (resolveMsg() as any).error(...a)) as Msg["error"],
  warning: ((...a: any[]) => (resolveMsg() as any).warning(...a)) as Msg["warning"],
  info: ((...a: any[]) => (resolveMsg() as any).info(...a)) as Msg["info"],
  open: ((...a: any[]) => (resolveMsg() as any).open(...a)) as Msg["open"],
  destroy: ((...a: any[]) => (resolveMsg() as any).destroy(...a)) as Msg["destroy"],
};

export const appModal: ModFacade = {
  confirm: ((...a: any[]) => (resolveMod() as any).confirm(...a)) as Mod["confirm"],
  info: ((...a: any[]) => (resolveMod() as any).info(...a)) as Mod["info"],
  success: ((...a: any[]) => (resolveMod() as any).success(...a)) as Mod["success"],
  warning: ((...a: any[]) => (resolveMod() as any).warning(...a)) as Mod["warning"],
  error: ((...a: any[]) => (resolveMod() as any).error(...a)) as Mod["error"],
};
