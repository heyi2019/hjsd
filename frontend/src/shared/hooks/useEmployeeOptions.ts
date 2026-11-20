import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { employeesApi } from "../api/org.api";
import type { EmployeeOption } from "../api/types/org";
import { subscribeReferenceDataChanged } from "../state/referenceDataEvents";

/** 员工被管理页修改后刷新已加载的名单，忽略变更前发出的旧请求。 */
export function useEmployeeOptions(autoLoad = true) {
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [settled, setSettled] = useState(false);
  const sequence = useRef(0);
  const mounted = useRef(false);
  const requested = useRef(false);

  const reload = useCallback(async () => {
    requested.current = true;
    const request = ++sequence.current;
    try {
      const items = (await employeesApi.list()) ?? [];
      if (mounted.current && request === sequence.current) {
        setEmployees(items);
        setError(null);
        setSettled(true);
      }
      return items;
    } catch (cause) {
      if (!mounted.current || request !== sequence.current) return [];
      setError(cause);
      setSettled(true);
      throw cause;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = subscribeReferenceDataChanged("employees", () => {
      if (requested.current) void reload().catch(() => undefined);
    });
    if (autoLoad) void reload().catch(() => undefined);
    return () => {
      mounted.current = false;
      sequence.current += 1;
      unsubscribe();
    };
  }, [autoLoad, reload]);

  const activeEmployees = useMemo(() => employees.filter((employee) => employee.is_active), [employees]);
  return { employees, activeEmployees, error, settled, reload };
}
