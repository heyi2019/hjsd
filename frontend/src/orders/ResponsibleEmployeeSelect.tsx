import { Form } from "antd";
import { useEffect, useMemo, useState } from "react";
import type { EmployeeOption } from "../shared/api/catalog";
import { currentUser } from "../shared/api/client";
import { useSession } from "../shared/state/session";
import { Select } from "../shared/ui";
import { CfgItem } from "./ConfigurableField";

/** 多人负责人：优先用当前会话员工默认值，仍允许补充其他在职员工。 */
export function ResponsibleEmployeeSelect(props: { name: string; label: string; employees: EmployeeOption[]; className?: string }) {
  const form = Form.useFormInstance();
  const { user } = useSession();
  const [currentEmployeeId, setCurrentEmployeeId] = useState<number>();
  const defaultEmployeeId = useMemo(
    () => currentEmployeeId ?? props.employees.find((employee) => employee.username === user)?.id,
    [currentEmployeeId, props.employees, user],
  );

  useEffect(() => {
    void currentUser().then((current) => setCurrentEmployeeId(current.id)).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (defaultEmployeeId !== undefined && form.getFieldValue(props.name) == null) {
      form.setFieldValue(props.name, [defaultEmployeeId]);
    }
  }, [defaultEmployeeId, form, props.name]);

  return (
    <CfgItem alwaysActive className={["responsible-employee-select", props.className].filter(Boolean).join(" ")} name={props.name} label={props.label}>
      <Select mode="multiple" placeholder="默认当前员工，可多选" options={props.employees.filter((employee) => employee.is_active).map((employee) => ({ value: employee.id, label: `${employee.display_name}（${employee.username}）` }))} />
    </CfgItem>
  );
}
