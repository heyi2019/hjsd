import type { ReactNode } from "react";
import { BusinessActionModal, type BusinessActionModalProps } from "./BusinessActionModal";
import { BusinessRegistrationForm, type BusinessRegistrationFormProps } from "./BusinessRegistrationForm";

export type BusinessRegistrationModalProps<Values = Record<string, unknown>> = BusinessActionModalProps & {
  /** 注册表属性集中放在 formProps，业务页面无需再拼接两个公共组件。 */
  formProps?: Omit<BusinessRegistrationFormProps<Values>, "children">;
  children?: ReactNode;
};

/**
 * ERP 标准注册弹窗的唯一组合入口。
 *
 * 对外一次调用，内部统一组合弹窗外壳与建单式注册表；业务页面只提供字段和提交逻辑。
 */
export function BusinessRegistrationModal<Values = Record<string, unknown>>({
  formProps,
  children,
  ...modalProps
}: BusinessRegistrationModalProps<Values>) {
  return (
    <BusinessActionModal {...modalProps}>
      <BusinessRegistrationForm {...formProps}>
        {children}
      </BusinessRegistrationForm>
    </BusinessActionModal>
  );
}
