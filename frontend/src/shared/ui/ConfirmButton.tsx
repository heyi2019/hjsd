import { appMessage } from "./appFeedback";
/** 破坏性/不可逆操作的统一按钮：二次确认 + loading + 防重 + 权限门控。
 *
 * 背景：此前全站 Popconfirm 仅 4 处，流水审核、规则发布、停用资金池/业务类型/用户、
 * 客户拉黑等都是一键生效——误点即落库且不可撤销。这里把「确认 + 反馈 + 防重 + 权限」
 * 收成一个组件，调用方只需提供 `title`（做什么）与 `description`（影响什么/能否撤销）。
 */
import { Button, Popconfirm } from "antd";
import type { ButtonProps } from "antd";
import { useState } from "react";
import type { ReactNode } from "react";
import { normalizeError } from "../api/client";
import { PermissionGate } from "./PermissionButton";
import type { Permission } from "../state/session";

export function ConfirmButton(
  props: {
    /** 权限：无权限时隐藏触发按钮。退出登录等无需权限的操作可省略。 */
    permission?: Permission;
    /** 确认标题：说清「做什么」，例如「停用资金池」。 */
    title: ReactNode;
    /** 后果说明：说清「影响什么 / 能否撤销」，这是确认弹窗唯一有价值的信息。 */
    description?: ReactNode;
    okText?: string;
    cancelText?: string;
    danger?: boolean;
    onConfirm: () => Promise<void>;
    children: ReactNode;
  } & Omit<ButtonProps, "onClick" | "loading">,
) {
  const { permission, title, description, okText, cancelText, danger, onConfirm, children, ...rest } = props;
  const [pending, setPending] = useState(false);
  // 受控开关：确认完成后显式关闭。交给 Popconfirm 自行关闭时，
  // 若 onConfirm 的 promise 迟迟不 settle，弹层会一直挂着挡住后续操作。
  const [open, setOpen] = useState(false);
  // 行内一键操作没有 Modal 容器可放 InlineError，失败必须走全局 toast，
  // 否则用户看到的是「点了没反应」。
  const handleConfirm = async () => {
    if (pending) return;
    setPending(true);
    try {
      await onConfirm();
      setOpen(false);
    } catch (err) {
      appMessage.error(normalizeError(err).message);
    } finally {
      setPending(false);
    }
  };
  const trigger = (
    <Popconfirm
      open={open}
      onOpenChange={(next) => {
        if (!pending) setOpen(next);
      }}
      title={title}
      description={description}
      okText={okText ?? "确认"}
      cancelText={cancelText ?? "取消"}
      okButtonProps={{ danger }}
      // 进行中禁止再次唤出确认，避免叠加提交。
      disabled={Boolean(rest.disabled) || pending}
      onConfirm={() => void handleConfirm()}
    >
      <Button {...rest} loading={pending}>
        {children}
      </Button>
    </Popconfirm>
  );
  if (permission) {
    return <PermissionGate permission={permission}>{trigger}</PermissionGate>;
  }
  return trigger;
}
