import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeError } from "../../shared/api/client";
import { gameTypesApi } from "../../shared/api/misc.api";
import { employeesApi } from "../../shared/api/org.api";
import { poolsApi } from "../../shared/api/pools.api";
import type { Pool } from "../../shared/api/types/finance";
import type { EmployeeOption, GameTypeOption } from "../../shared/api/types/org";

/** 建单资料预先加载，失败时可在表单中重试。 */
export function useCreateBusinessLookups() {
  const [pools, setPools] = useState<Pool[]>([]);
  const [gameTypes, setGameTypes] = useState<GameTypeOption[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [loadError, setLoadError] = useState<{ message: string; code?: string } | null>(null);
  const [lookupError, setLookupError] = useState<{ message: string; code?: string } | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const didInitLookup = useRef(false);
  const lookupInFlight = useRef(false);

  const retryLookups = useCallback(async () => {
    if (lookupInFlight.current) return;
    lookupInFlight.current = true;
    setLookupLoading(true);
    try {
      const [poolList, gameTypeList, employeeList] = await Promise.all([
        poolsApi.list(),
        gameTypesApi.list({ include_inactive: false }),
        employeesApi.list(),
      ]);
      setPools((Array.isArray(poolList) ? poolList : []).filter((pool) => pool.status === "ACTIVE"));
      setGameTypes(Array.isArray(gameTypeList) ? gameTypeList : []);
      setEmployees((Array.isArray(employeeList) ? employeeList : []).filter((employee) => employee.is_active));
      setLookupError(null);
      didInitLookup.current = true;
    } catch (error) {
      setLookupError(normalizeError(error));
    } finally {
      lookupInFlight.current = false;
      setLookupLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!didInitLookup.current) void retryLookups();
  }, [retryLookups]);

  return {
    pools,
    gameTypes,
    employees,
    loadError: loadError ?? lookupError,
    setLoadError,
    canRetryLookups: Boolean(lookupError && !loadError),
    lookupLoading,
    retryLookups,
  };
}
