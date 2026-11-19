import { Form, type FormProps } from "antd";
import type { ReactNode } from "react";
import { FormField } from "./AdaptiveFormGrid/FormField";
import "./BusinessRegistrationForm.css";

export type BusinessRegistrationFormProps<Values = Record<string, unknown>> = FormProps<Values> & {
  /** 当前业务表单的后端配置作用域，便于排查和自动化验证。 */
  scope?: string;
  children?: ReactNode;
};

/**
 * ERP 统一登记表容器。
 *
 * 复用建单表单的横向标签、控件列、间距、错误滚动和表单标识。
 * 字段数量对应的列数与弹窗宽度由外层 BusinessActionModal 统一控制。
 */
export function BusinessRegistrationForm<Values = Record<string, unknown>>({
  scope,
  className,
  layout = "horizontal",
  labelAlign = "left",
  labelCol = { flex: "108px" },
  wrapperCol = { flex: "auto" },
  scrollToFirstError = true,
  onFinish,
  children,
  ...props
}: BusinessRegistrationFormProps<Values>) {
  return (
    <Form
      {...props}
      onFinish={onFinish ? (values) => {
        if (values && typeof values === "object") {
          const cleaned = Object.fromEntries(Object.entries(values).filter(([key]) => !key.startsWith("__field_config_ready_")));
          return onFinish(cleaned as Values);
        }
        return onFinish(values);
      } : undefined}
      layout={layout}
      labelAlign={labelAlign}
      labelCol={labelCol}
      wrapperCol={wrapperCol}
      scrollToFirstError={scrollToFirstError}
      className={["ui-form-spaced", "business-registration-form", className].filter(Boolean).join(" ")}
      data-form-scope={scope}
    >
      {children}
    </Form>
  );
}

export type BusinessRegistrationSectionProps = {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
};

/** 建单式注册表的业务分区卡片。 */
export function BusinessRegistrationSection({
  title,
  description,
  action,
  children,
  className,
}: BusinessRegistrationSectionProps) {
  return (
    <section className={["business-registration-section", className].filter(Boolean).join(" ")}>
      <header className="business-registration-section__header">
        <div className="business-registration-section__heading">
          <h2 className="business-registration-section__title">{title}</h2>
          {description ? <div className="business-registration-section__description">{description}</div> : null}
        </div>
        {action ? <div className="business-registration-section__action">{action}</div> : null}
      </header>
      <div className="business-registration-section__fields">{children}</div>
    </section>
  );
}

export type BusinessRegistrationGroupProps = {
  title?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
};

export type BusinessRegistrationFieldProps = {
  label: ReactNode;
  children: ReactNode;
  className?: string;
  required?: boolean;
};

/** 建单式二级容器内的横向字段。 */
export function BusinessRegistrationField(props: BusinessRegistrationFieldProps) {
  return (
    <FormField
      className={["business-registration-field", props.className].filter(Boolean).join(" ")}
      labelClassName="business-registration-field__label"
      label={props.label}
      required={props.required}
    >
      {props.children}
    </FormField>
  );
}

/** 建单式分区内部的二级字段容器。 */
export function BusinessRegistrationGroup({ title, action, children, className }: BusinessRegistrationGroupProps) {
  return (
    <div className={["business-registration-group", className].filter(Boolean).join(" ")}>
      {title || action ? (
        <div className="business-registration-group__header">
          {title ? <h3 className="business-registration-group__title">{title}</h3> : <span />}
          {action ? <div className="business-registration-group__action">{action}</div> : null}
        </div>
      ) : null}
      <div className="business-registration-group__fields">{children}</div>
    </div>
  );
}
