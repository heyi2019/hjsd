import { Form, type FormProps } from "antd";
import type { ReactNode } from "react";

export type BusinessFormProps<Values = Record<string, unknown>> = FormProps<Values> & {
  /** 当前业务表单的后端配置作用域，便于排查和自动化验证。 */
  scope?: string;
  children?: ReactNode;
};

/**
 * 业务表单的唯一基础容器。
 *
 * 字段组件仍由各业务域组合，但布局、错误滚动和表单标识只在这里定义，
 * 避免每个弹窗复制一套 Form 属性后逐渐产生行为差异。
 */
export function BusinessForm<Values = Record<string, unknown>>({
  scope,
  className,
  layout = "vertical",
  scrollToFirstError = true,
  children,
  ...props
}: BusinessFormProps<Values>) {
  return (
    <Form
      {...props}
      layout={layout}
      scrollToFirstError={scrollToFirstError}
      className={["ui-form-spaced", className].filter(Boolean).join(" ")}
      data-form-scope={scope}
    >
      {children}
    </Form>
  );
}
