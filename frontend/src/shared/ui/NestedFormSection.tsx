import type { ReactNode } from "react";
import { FormField } from "./AdaptiveFormGrid/FormField";
import "./NestedFormSection.css";

/**
 * 表中表：用于主表单内有独立标题、说明和字段规则的子表单区。
 * 业务模块只提供内容与状态，外观和响应式由使用场景的 className 决定。
 */
export function NestedFormSection(props: {
  title?: ReactNode;
  description?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
  headerClassName?: string;
  titleClassName?: string;
  descriptionClassName?: string;
}) {
  const classes = ["nested-form-section", props.className].filter(Boolean).join(" ");
  const headerClasses = ["nested-form-section__header", props.headerClassName].filter(Boolean).join(" ");
  const titleClasses = ["nested-form-section__title", props.titleClassName].filter(Boolean).join(" ");
  const descriptionClasses = ["nested-form-section__description", props.descriptionClassName].filter(Boolean).join(" ");

  return (
    <section className={classes}>
      {(props.title || props.description || props.extra) && (
        <div className={headerClasses}>
          {props.title && <div className={titleClasses}>{props.title}</div>}
          {props.description && <div className={descriptionClasses}>{props.description}</div>}
          {props.extra}
        </div>
      )}
      {props.children}
    </section>
  );
}

/** 表中表内统一的“标签：控件”字段。 */
export function NestedFormField(props: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
  required?: boolean;
}) {
  return <FormField className={["nested-form-section__field", props.className].filter(Boolean).join(" ")} labelClassName="nested-form-section__field-label" label={props.label} required={props.required}>{props.children}</FormField>;
}

