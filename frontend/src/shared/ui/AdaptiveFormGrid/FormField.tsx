import type { ReactNode } from "react";
import "./FormField.css";

/** 通用的“字段说明 + 控件”横向字段。 */
export function FormField(props: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
  labelClassName?: string;
  colon?: boolean;
}) {
  return (
    <div className={["form-field", props.className].filter(Boolean).join(" ")}>
      <span className={["form-field__label", props.labelClassName].filter(Boolean).join(" ")}>
        {props.label}{props.colon === false ? null : "："}
      </span>
      {props.children}
    </div>
  );
}
