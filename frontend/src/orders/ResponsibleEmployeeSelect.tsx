import { Form } from "antd";
import type { SelectProps } from "antd";
import { useEffect, useMemo, useState } from "react";
import type { EmployeeOption } from "../shared/api/types/org";
import { currentDevUser } from "../shared/api/client";
import { useSession } from "../shared/state/session";
import { Select } from "../shared/ui";
import { CfgItem } from "./ConfigurableField";
import "./ResponsibleEmployeeSelect.css";

type EmployeeSelectControlProps = Omit<SelectProps, "options"> & {
  employees?: EmployeeOption[];
  options?: SelectProps["options"];
};

/** 统一人员选项与下拉控件；建单操作人、交付操作人、分润配置共用此入口。 */
export function EmployeeSelectControl({ employees, options, ...props }: EmployeeSelectControlProps) {
  const employeeOptions = options ?? employees?.filter((employee) => employee.is_active).map((employee) => ({
    value: employee.id,
    label: employee.display_name,
  })) ?? [];
  return (
    <Select
      {...props}
      showSearch={props.showSearch ?? true}
      optionFilterProp={props.optionFilterProp ?? "label"}
      options={employeeOptions}
    />
  );
}

/** 多人操作人：优先用当前会话员工默认值，仍允许补充其他在职员工。 */
export function ResponsibleEmployeeSelect(props: { name: string; label: string; employees: EmployeeOption[]; className?: string; required?: boolean }) {
  const form = Form.useFormInstance();
  // 按人匹配必须用 username（users.username），不能用 role（ADMIN/OPERATOR 这类系统角色）：
  // 拿角色去比 username 在生产环境恒不命中，默认值只能靠 /auth/me 那一路兜。
  const { username } = useSession();
  const defaultEmployeeId = useMemo(() => {
    const sessionEmployee = props.employees.find((employee) => employee.is_active && employee.username === username);
    if (sessionEmployee) return sessionEmployee.id;
    if (!import.meta.env.DEV) return undefined;
    const devUsername = currentDevUser();
    return props.employees.find((employee) => employee.is_active && employee.username === devUsername)?.id;
  }, [props.employees, username]);
  useEffect(() => {
    const currentValue = form.getFieldValue(props.name);
    const isEmpty = currentValue == null || (Array.isArray(currentValue) && currentValue.length === 0);
    if (defaultEmployeeId !== undefined && isEmpty) {
      form.setFieldValue(props.name, [defaultEmployeeId]);
    }
  }, [defaultEmployeeId, form, props.name]);

  return (
    <CfgItem
      alwaysActive
      className={["responsible-employee-select", props.className].filter(Boolean).join(" ")}
      name={props.name}
      label={props.label}
      rules={props.required ? [{ required: true, message: `${props.label}必填` }] : undefined}
    >
      <EmployeeSelectControl mode="multiple" placeholder="默认当前员工，可多选" employees={props.employees} />
    </CfgItem>
  );
}
