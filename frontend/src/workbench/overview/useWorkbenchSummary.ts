import { useEffect, useRef, useState } from "react";
import { normalizeError } from "../../shared/api/client";
import { workbenchApi, type WorkbenchSummary } from "../../shared/api/workbench.api";
import type { ReportPeriod } from "../../shared/lib/reportPeriod";

export function samePeriod(left: ReportPeriod | null, right: ReportPeriod | null): boolean {
  return left === null || right === null
    ? left === right
    : left.from === right.from && left.to === right.to;
}

export function useWorkbenchSummary(active: boolean, selectedPeriod: ReportPeriod | null, periodReady: boolean, currentPeriod: ReportPeriod) {
  const [summary, setSummary] = useState<WorkbenchSummary | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);
  const requestRef = useRef(0);
  const initialRequestRef = useRef<Promise<WorkbenchSummary> | null>(null);

  const fetchSummary = async (reuseInitial: boolean) => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      let result: WorkbenchSummary;
      if (!periodReady) {
        const initial = reuseInitial && initialRequestRef.current
          ? initialRequestRef.current
          : workbenchApi.summary(undefined);
        initialRequestRef.current = initial;
        result = await initial;
      } else if (reuseInitial && initialRequestRef.current && samePeriod(selectedPeriod, currentPeriod)) {
        const initial = initialRequestRef.current;
        result = await initial;
        if (!mountedRef.current || request !== requestRef.current) return;
        if (initialRequestRef.current === initial) initialRequestRef.current = null;
        if (!samePeriod(result.period, selectedPeriod)) result = await workbenchApi.summary(selectedPeriod);
      } else {
        initialRequestRef.current = null;
        result = await workbenchApi.summary(selectedPeriod);
      }
      if (!mountedRef.current || request !== requestRef.current) return;
      setSummary(result);
      setError(null);
    } catch (err) {
      if (!mountedRef.current || request !== requestRef.current) return;
      setSummary(null);
      setError(normalizeError(err));
    } finally {
      if (mountedRef.current && request === requestRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => {
    if (active) void fetchSummary(true);
    else initialRequestRef.current = null;
    return () => { requestRef.current += 1; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, periodReady, selectedPeriod === null, selectedPeriod?.from, selectedPeriod?.to, currentPeriod.from, currentPeriod.to]);

  return { summary, error, loading, loadSummary: () => active ? fetchSummary(false) : Promise.resolve() };
}
