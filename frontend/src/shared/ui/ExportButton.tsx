import { Button } from "antd";
import type { ButtonProps } from "antd";
import { forwardRef } from "react";
import { useSession } from "../state/session";
import type { Permission } from "../state/session";

export const ExportButton = forwardRef<HTMLButtonElement, Omit<ButtonProps, "size" | "children"> & { permission?: Permission }>(
  ({ permission, className, ...props }, ref) => {
    const { can } = useSession();
    if (permission && !can(permission)) return null;
    return <Button {...props} ref={ref} size="small" className={["ui-export-button", className].filter(Boolean).join(" ")}>导出</Button>;
  },
);

ExportButton.displayName = "ExportButton";
