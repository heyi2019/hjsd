import { appMessage } from "./appFeedback";
/** Modal 级统一确认组件：与 ConfirmButton（Popover 级）构成「两级确认」标准的两端。
 *
 * 适用：需要多输入（表单）或丢弃未保存内容等较重确认；默认带遮罩、Esc 关闭、点击遮罩不关闭。
 * 轻量、可逆/简单销毁的单键操作请用 ConfirmButton（Popover 级，无遮罩）。
 *
 * 行为契约（与 ConfirmButton 对齐）：
 *  - 权限由触发方门控（本组件不再重复门控，避免与父级触发按钮双重拦截）；
 *  - pending 期间禁用取消、防重提交，确认按钮显示 loading；
 *  - 失败统一走全局 toast（appMessage.error），不自带页面级错误位；
 *  - okText 默认「确认」、cancelText 默认「取消」、danger 控制确认按钮红色；
 *  - 遮罩存在、Esc 可关闭（keyboard）、点击遮罩不关闭（maskClosable=false 防误关）；
 *  - 默认带 .heijin-fast-confirm（二次确认框 50ms 入场，见 antd-adapter.css）。
 *
 * 注意：本组件由父级用 open 受控，成功/失败后均由父级决定是否关闭；组件自身不在成功时自动关闭。
 */
import { ConfigProvider, Modal } from "antd";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { normalizeError } from "../api/client";

export function ConfirmDialog(props: {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  className?: string;
}) {
  const { open, title, description, okText, cancelText, danger, onConfirm, onCancel, className } = props;
  const [pending, setPending] = useState(false);
  // 关闭时复位 pending，避免下次打开残留 loading。
  useEffect(() => {
    if (!open) setPending(false);
  }, [open]);
  const handleConfirm = async () => {
    if (pending) return;
    setPending(true);
    try {
      await onConfirm();
    } catch (err) {
      appMessage.error(normalizeError(err).message);
    } finally {
      setPending(false);
    }
  };
  return (
    <Modal
      open={open}
      title={title}
      onCancel={() => {
        if (!pending) onCancel();
      }}
      onOk={() => void handleConfirm()}
      okText={okText ?? "确认"}
      cancelText={cancelText ?? "取消"}
      okButtonProps={{ danger, loading: pending }}
      cancelButtonProps={{ disabled: pending }}
      maskClosable={false}
      keyboard
      className={["heijin-fast-confirm", className].filter(Boolean).join(" ")}
    >
      {description}
    </Modal>
  );
}
