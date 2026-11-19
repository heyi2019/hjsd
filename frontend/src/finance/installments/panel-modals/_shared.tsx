import { BusinessActionModal, BusinessRegistrationForm, InlineError, PermissionButton } from "../../../shared/ui";
import { CustomFieldSection, FieldConfigScope } from "../../../business/ConfigurableField";
import { ResponsibleEmployeeSelect } from "../../../business/ResponsibleEmployeeSelect";
import type { FormInstance } from "antd";
import type { ReactNode } from "react";
import type { NormalizedError } from "../../../shared/api/client";
import type { Permission } from "../../../shared/state/session";
import type { ContractTableController } from "../useContractTableController";

export const Modal = BusinessActionModal;

export type WriteState = { error: NormalizedError | null; pending: boolean };

export interface InstallmentActionModalProps {
  title: string;
  open: boolean;
  onCancel: () => void;
  scope: string;
  form: FormInstance;
  onFinish: (values: Record<string, unknown>) => void;
  write: WriteState;
  permission: Permission;
  submitLabel: string;
  danger?: boolean;
  intro?: ReactNode;
  outro?: ReactNode;
  section?: string;
  testIdSuffix: string;
  employees: ContractTableController["employees"];
  children?: ReactNode;
}

/**
 * 分期 9 个动作 Modal 的共用骨架：Modal + InlineError + FieldConfigScope + BusinessRegistrationForm
 * 的布局属性完全一致，差异（标题/字段/文案/权限/危险态/testIdSuffix）通过 props 与 children 表达。
 */
export function InstallmentActionModal({
  title,
  open,
  onCancel,
  scope,
  form,
  onFinish,
  write,
  permission,
  submitLabel,
  danger,
  intro,
  outro,
  section,
  testIdSuffix,
  employees,
  children,
}: InstallmentActionModalProps) {
  return (
    <Modal title={title} open={open} onCancel={onCancel} footer={null}>
      <InlineError error={write.error} />
      <FieldConfigScope scope={scope} active={open}>
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }}
          scope={scope}
          form={form}
          onFinish={onFinish}
        >
          {intro}
          {children}
          <ResponsibleEmployeeSelect name="operator_user_ids" label="操作人" employees={employees} />
          <CustomFieldSection {...(section ? { section } : {})} testIdSuffix={testIdSuffix} />
          {outro}
          <PermissionButton
            permission={permission}
            type="primary"
            danger={danger}
            htmlType="submit"
            loading={write.pending}
          >
            {submitLabel}
          </PermissionButton>
        </BusinessRegistrationForm>
      </FieldConfigScope>
    </Modal>
  );
}
