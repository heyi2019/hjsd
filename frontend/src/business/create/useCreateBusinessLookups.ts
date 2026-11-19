import { useEffect, useRef, useState } from "react";
import { normalizeError } from "../../shared/api/client";
import { gameTypesApi } from "../../shared/api/misc.api";
import { employeesApi } from "../../shared/api/org.api";
import { poolsApi } from "../../shared/api/pools.api";
import type { Pool } from "../../shared/api/types/finance";
import type { EmployeeOption, GameTypeOption } from "../../shared/api/types/org";

/** 建单所需的静态资料只在页面生命周期内预取一次；失败时允许下次打开重试。 */
export function useCreateBusinessLookups() {
  const [pools, setPools] = useState<Pool[]>([]);
  const [gameTypes, setGameTypes] = useState<GameTypeOption[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [loadError, setLoadError] = useState<{ message: string; code?: string } | null>(null);
  const didInitLookup = useRef(false);

  useEffect(() => {
    if (didInitLookup.current) return;
    void (async () => {
      try {
        const [poolList, gameTypeList, employeeList] = await Promise.all([
          poolsApi.list(),
          gameTypesApi.list({ include_inactive: false }),
          employeesApi.list(),
        ]);
        setPools((Array.isArray(poolList) ? poolList : []).filter((pool) => pool.status === "ACTIVE"));
        setGameTypes(Array.isArray(gameTypeList) ? gameTypeList : []);
        setEmployees((Array.isArray(employeeList) ? employeeList : []).filter((employee) => employee.is_active));
        setLoadError(null);
        didInitLookup.current = true;
      } catch (error) {
        setLoadError(normalizeError(error));
      }
    })();
  }, []);

  return {
    pools,
    gameTypes,
    employees,
    loadError,
    setLoadError,
  };
}
