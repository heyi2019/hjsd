import { useCallback, useMemo } from "react";
import { employeesApi } from "../api/org.api";
import { useReferenceList } from "./useReferenceList";

/** 员工被管理页修改后刷新已加载的名单，忽略变更前发出的旧请求。 */
export function useEmployeeOptions(autoLoad = true) {
  const { items: employees, error, settled, reload } = useReferenceList("employees", employeesApi.list, autoLoad);
  const reloadFresh = useCallback(() => reload(() => employeesApi.list({ fresh: true })), [reload]);
  const activeEmployees = useMemo(() => employees.filter((employee) => employee.is_active), [employees]);
  return { employees, activeEmployees, error, settled, reload, reloadFresh };
}
