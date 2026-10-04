/** 权限门控按钮：无权限时隐藏（或禁用），后端仍二次鉴权。 */
import { Button, Tooltip } from "antd";
import type { ButtonProps } from "antd";
import type { ReactNode } from "react";
import { useSession } from "../state/session";
import type { Permission } from "../state/session";

export function PermissionGate(props: {
  permission: Permission;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { can } = useSession();
  if (!can(props.permission)) return <>{props.fallback ?? null}</>;
  return <>{props.children}</>;
}

export function PermissionButton(
  props: ButtonProps & {
    permission: Permission;
    /** 无权限时仍渲染但禁用（用于需要让用户知道该功能存在的场景）。 */
    showDisabled?: boolean;
    disabledReason?: string;
  },
) {
  const { permission, showDisabled, disabledReason, ...rest } = props;
  const { can } = useSession();
  if (!can(permission)) {
    if (!showDisabled) return null;
    return (
      <Tooltip title={disabledReason ?? "当前角色无权执行"}>
        <Button {...rest} disabled />
      </Tooltip>
    );
  }
  return <Button {...rest} />;
}
