import { Form } from "antd";
import type { SelectProps } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import type { EmployeeOption } from "../shared/api/types/org";
import { currentDevUser } from "../shared/api/client";
import { employeesApi } from "../shared/api/org.api";
import { notifyReferenceDataRefreshed, subscribeReferenceDataChanged } from "../shared/state/referenceDataEvents";
import { useSession } from "../shared/state/session";
import { Select } from "../shared/ui";
import { appMessage } from "../shared/ui/appFeedback";
import { CfgItem } from "./ConfigurableField";
import "./ResponsibleEmployeeSelect.css";

type EmployeeSelectControlProps = Omit<SelectProps, "options"> & {
  employees?: EmployeeOption[];
  options?: SelectProps["options"];
};

/** 统一人员选项与下拉控件；建单操作人、交付操作人、分润配置共用此入口。 */
export function EmployeeSelectControl({ employees, options, onOpenChange, ...props }: EmployeeSelectControlProps) {
  const signature = employees ? JSON.stringify(employees) : "";
  const signatureRef = useRef(signature);
  signatureRef.current = signature;
  const sequence = useRef(0);
  const [fresh, setFresh] = useState<{ signature: string; employees: EmployeeOption[] } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    const unsubscribe = subscribeReferenceDataChanged("employees", (origin) => {
      if (origin === "refresh") return;
      sequence.current += 1;
      setFresh(null);
      setRefreshing(false);
    });
    return () => { sequence.current += 1; unsubscribe(); };
  }, []);
  const currentEmployees = fresh?.signature === signature ? fresh.employees : employees;
  const employeeOptions = options ?? currentEmployees?.filter((employee) => employee.is_active).map((employee) => ({
    value: employee.id,
    label: employee.display_name,
  })) ?? [];
  const handleOpen = (open: boolean) => {
    onOpenChange?.(open);
    if (!open || !employees || options) return;
    const request = ++sequence.current;
    setRefreshing(true);
    void employeesApi.list({ fresh: true }).then((items) => {
      if (request !== sequence.current || signature !== signatureRef.current) return;
      if (!Array.isArray(items)) throw new Error("员工列表数据不可用");
      setFresh({ signature, employees: items });
      notifyReferenceDataRefreshed("employees");
    }).catch(() => {
      if (request === sequence.current) appMessage.warning("员工列表刷新失败，请稍后重试");
    }).finally(() => {
      if (request === sequence.current) setRefreshing(false);
    });
  };
  return (
    <Select
      {...props}
      loading={Boolean(props.loading || refreshing)}
      onOpenChange={handleOpen}
      showSearch={props.showSearch ?? true}
      optionFilterProp={props.optionFilterProp ?? "label"}
      options={employeeOptions}
    />
  );
}

/** 多人操作人：优先用当前会话员工默认值，仍允许补充其他在职员工。 */
export function ResponsibleEmployeeSelect(props: { name: string; label: string; employees: EmployeeOption[]; className?: string }) {
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
      rules={[{ required: true, message: `${props.label}必填` }]}
    >
      <EmployeeSelectControl mode="multiple" placeholder="默认当前员工，可多选" employees={props.employees} />
    </CfgItem>
  );
}
