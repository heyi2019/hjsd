/**
 * 底部弹出层（bottom sheet）——移动端唯一的二级交互容器。
 *
 * 为什么不用居中弹窗：iPhone 单手可达区域在屏幕下半部，居中弹窗的确认键常在拇指
 * 够不到的位置；iOS 自身的 picker / share / action sheet 全部从底部升起也是这个原因。
 *
 * 两个必须处理的细节：
 *  1) 打开时锁 body 滚动：否则手指在遮罩上滑动会把底层页面一起滚走，
 *     关闭后页面跑到别的位置（iOS 上尤其明显）。
 *  2) 安全区：面板底部要吃掉 `env(safe-area-inset-bottom)`，否则全面屏的
 *     Home 指示条会压在最后一行按钮上。
 */
import { useEffect } from "react";
import type { ReactNode } from "react";

export function Sheet(props: {
  open: boolean;
  title?: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  /** 底部固定操作区（如「保存」）；不传则内容自行结束。 */
  footer?: ReactNode;
  /** 收起面板时是否跳过动画（用于选项点选后的即时关闭，避免回弹残留）。 */
  dense?: boolean;
}) {
  useEffect(() => {
    if (!props.open) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [props.open]);

  if (!props.open) return null;

  return (
    <div className="h5-sheet-root" role="dialog" aria-modal="true" aria-label={props.title}>
      <button type="button" className="h5-sheet__scrim" aria-label="关闭" onClick={props.onClose} />
      <div className={`h5-sheet${props.dense ? " h5-sheet--dense" : ""}`}>
        <div className="h5-sheet__grip" aria-hidden="true" />
        {props.title ? (
          <header className="h5-sheet__head">
            <h2>{props.title}</h2>
            {props.description ? <p>{props.description}</p> : null}
          </header>
        ) : null}
        <div className="h5-sheet__body">{props.children}</div>
        {props.footer ? <div className="h5-sheet__foot">{props.footer}</div> : null}
      </div>
    </div>
  );
}

/** 动作面板：一串「点一下就执行」的选项，危险操作单独标红并排在最后。 */
export function ActionSheet(props: {
  open: boolean;
  title?: string;
  description?: string;
  actions: { key: string; label: string; hint?: string; danger?: boolean; disabled?: boolean; onSelect: () => void }[];
  onClose: () => void;
}) {
  return (
    <Sheet open={props.open} title={props.title} description={props.description} onClose={props.onClose}>
      <div className="h5-actionsheet">
        {props.actions.map((action) => (
          <button
            key={action.key}
            type="button"
            className={`h5-actionsheet__item${action.danger ? " is-danger" : ""}`}
            disabled={action.disabled}
            onClick={() => {
              if (action.disabled) return;
              props.onClose();
              action.onSelect();
            }}
          >
            <span className="h5-actionsheet__label">{action.label}</span>
            {action.hint ? <span className="h5-actionsheet__hint">{action.hint}</span> : null}
          </button>
        ))}
      </div>
      <button type="button" className="h5-actionsheet__cancel" onClick={props.onClose}>
        取消
      </button>
    </Sheet>
  );
}

/** 确认对话框：只用于「不可逆 + 需要一句理由」的破坏性操作。 */
export function ConfirmSheet(props: {
  open: boolean;
  title: string;
  description?: string;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  children?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Sheet open={props.open} title={props.title} description={props.description} onClose={props.onCancel}>
      {props.children}
      {props.error ? <div className="h5-alert h5-alert--error" role="alert">{props.error}</div> : null}
      <div className="h5-sheet__confirm">
        <button type="button" className="h5-ghost" onClick={props.onCancel} disabled={props.busy}>
          {props.cancelText ?? "取消"}
        </button>
        <button
          type="button"
          className={`h5-primary${props.danger ? " h5-primary--danger" : ""}`}
          onClick={props.onConfirm}
          disabled={props.busy}
        >
          {props.busy ? "处理中…" : (props.okText ?? "确认")}
        </button>
      </div>
    </Sheet>
  );
}
