import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeError } from "../../shared/api/client";
import { gameTypesApi } from "../../shared/api/misc.api";
import { poolsApi } from "../../shared/api/pools.api";
import type { Pool } from "../../shared/api/types/finance";
import type { GameTypeOption } from "../../shared/api/types/org";
import { useAsyncAction } from "../../shared/hooks/useAsyncAction";
import { useEmployeeOptions } from "../../shared/hooks/useEmployeeOptions";
import { subscribeReferenceDataChanged } from "../../shared/state/referenceDataEvents";

/** 建单资料预先加载，失败时可在表单中重试。 */
export function useCreateBusinessLookups(open: boolean) {
  const [pools, setPools] = useState<Pool[]>([]);
  const [gameTypes, setGameTypes] = useState<GameTypeOption[]>([]);
  const { activeEmployees, error: employeeError, reload: reloadEmployees } = useEmployeeOptions(false);
  const [loadError, setLoadError] = useState<{ message: string; code?: string } | null>(null);
  const [lookupError, setLookupError] = useState<{ message: string; code?: string } | null>(null);
  const lookupWrite = useAsyncAction();
  const lookupLoading = lookupWrite.pending;
  const didInitLookup = useRef(false);
  const poolSequence = useRef(0);
  const gameTypeSequence = useRef(0);
  const changeSequence = useRef(0);
  const openRef = useRef(open);
  const refreshedForOpen = useRef(false);
  openRef.current = open;

  const loadPools = useCallback(async (fresh = false) => {
    const request = ++poolSequence.current;
    try {
      const poolList = await (fresh ? poolsApi.list({ fresh: true }) : poolsApi.list());
      if (request === poolSequence.current) {
        setPools((Array.isArray(poolList) ? poolList : []).filter((pool) => pool.status === "ACTIVE"));
      }
    } catch (error) {
      if (request === poolSequence.current) throw error;
    }
  }, []);

  const loadGameTypes = useCallback(async (fresh = false) => {
    const request = ++gameTypeSequence.current;
    try {
      const params = { include_inactive: false };
      const gameTypeList = await (fresh ? gameTypesApi.list(params, { fresh: true }) : gameTypesApi.list(params));
      if (request === gameTypeSequence.current) setGameTypes(Array.isArray(gameTypeList) ? gameTypeList : []);
    } catch (error) {
      if (request === gameTypeSequence.current) throw error;
    }
  }, []);

  const retryLookups = useCallback(async () => {
    await lookupWrite.run(async () => {
      const current = changeSequence.current;
      try {
        const fresh = openRef.current;
        if (fresh) refreshedForOpen.current = true;
        await Promise.all([loadPools(fresh), loadGameTypes(fresh), reloadEmployees()]);
        if (current === changeSequence.current) setLookupError(null);
        didInitLookup.current = true;
      } catch (error) {
        setLookupError(normalizeError(error));
      }
    });
  }, [lookupWrite.run, loadPools, loadGameTypes, reloadEmployees]);

  useEffect(() => {
    const onError = (error: unknown) => setLookupError(normalizeError(error));
    const unsubscribePools = subscribeReferenceDataChanged("pools", () => {
      changeSequence.current += 1;
      void loadPools().catch(onError);
    });
    const unsubscribeGameTypes = subscribeReferenceDataChanged("gameTypes", () => {
      changeSequence.current += 1;
      void loadGameTypes().catch(onError);
    });
    const unsubscribeEmployees = subscribeReferenceDataChanged("employees", () => { changeSequence.current += 1; });
    return () => {
      poolSequence.current += 1;
      gameTypeSequence.current += 1;
      unsubscribePools();
      unsubscribeGameTypes();
      unsubscribeEmployees();
    };
  }, [loadPools, loadGameTypes]);

  useEffect(() => {
    if (employeeError) setLookupError(normalizeError(employeeError));
  }, [employeeError]);

  useEffect(() => {
    if (!didInitLookup.current) void retryLookups();
  }, [retryLookups]);

  useEffect(() => {
    if (!open) {
      refreshedForOpen.current = false;
      return;
    }
    if (lookupLoading || !didInitLookup.current || refreshedForOpen.current) return;
    refreshedForOpen.current = true;
    const onError = (error: unknown) => setLookupError(normalizeError(error));
    void loadPools(true).catch(onError);
    void loadGameTypes(true).catch(onError);
  }, [open, lookupLoading, loadPools, loadGameTypes]);

  return {
    pools,
    gameTypes,
    employees: activeEmployees,
    loadError: loadError ?? lookupError,
    setLoadError,
    canRetryLookups: Boolean(lookupError && !loadError),
    lookupLoading,
    retryLookups,
  };
}
