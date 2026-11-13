import { Form } from "antd";
import type { SelectProps } from "antd";
import { useEffect, useMemo, useState } from "react";
import type { EmployeeOption } from "../shared/api/types/org";
import { useSession } from "../shared/state/session";
import { Select } from "../shared/ui";
import { CfgItem } from "./ConfigurableField";
import "./ResponsibleEmployeeSelect.css";

type EmployeeSelectControlProps = Omit<SelectProps, "options"> & {
  employees?: EmployeeOption[];
  options?: SelectProps["options"];
};

/** 统一人员选项与下拉控件；建单负责人、交付负责人、分润配置共用此入口。 */
export function EmployeeSelectControl({ employees, options, ...props }: EmployeeSelectControlProps) {
  const employeeOptions = options ?? employees?.filter((employee) => employee.is_active).map((employee) => ({
    value: employee.id,
    label: employee.display_name,
  })) ?? [];
  return <Select {...props} options={employeeOptions} />;
}

/** 多人负责人：优先用当前会话员工默认值，仍允许补充其他在职员工。 */
export function ResponsibleEmployeeSelect(props: { name: string; label: string; employees: EmployeeOption[]; className?: string }) {
  const form = Form.useFormInstance();
  // 按人匹配必须用 username（users.username），不能用 role（ADMIN/OPERATOR 这类系统角色）：
  // 拿角色去比 username 在生产环境恒不命中，默认值只能靠 /auth/me 那一路兜。
  const { username } = useSession();
  const defaultEmployeeId = useMemo(
    () => props.employees.find((employee) => employee.username === username)?.id,
    [props.employees, username],
  );
  useEffect(() => {
    if (defaultEmployeeId !== undefined && form.getFieldValue(props.name) == null) {
      form.setFieldValue(props.name, [defaultEmployeeId]);
    }
  }, [defaultEmployeeId, form, props.name]);

  return (
    <CfgItem alwaysActive className={["responsible-employee-select", props.className].filter(Boolean).join(" ")} name={props.name} label={props.label}>
      <EmployeeSelectControl mode="multiple" placeholder="默认当前员工，可多选" employees={props.employees} />
    </CfgItem>
  );
}
