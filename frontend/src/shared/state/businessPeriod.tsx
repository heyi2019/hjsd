import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import dayjs from "dayjs";
import { optionSetsApi } from "../api/options.api";
import { currentReportPeriod, previousReportPeriod, type ReportPeriod } from "../../reporting/reportPeriod";

export const BUSINESS_PERIOD_CODE = "BUSINESS_PERIOD";
const PERIOD_CHANGED = "business-period-config-changed";

export type PeriodState = {
  period: ReportPeriod;
  startDay: number;
  ready: boolean;
  error: string | null;
  retry: () => void;
  setPeriod: (period: ReportPeriod) => void;
  useCurrentPeriod: () => void;
  usePreviousPeriod: () => void;
};

const PeriodContext = createContext<PeriodState | null>(null);

export function announceBusinessPeriodChange(startDay: number) {
  window.dispatchEvent(new CustomEvent(PERIOD_CHANGED, { detail: startDay }));
}

function usePeriodState(enabled = true): PeriodState {
  const [startDay, setStartDay] = useState(16);
  const [selection, setSelection] = useState<ReportPeriod | null>(null);
  const [ready, setReady] = useState(!enabled);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const version = useRef(0);
  const [, setToday] = useState(() => dayjs().format("YYYY-MM-DD"));
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const load = () => {
      const request = ++version.current;
      Promise.resolve(optionSetsApi.get(BUSINESS_PERIOD_CODE)).then((config) => {
        const value = Number(config?.options?.find((item) => item.value === "start_day")?.label);
        if (cancelled || request !== version.current) return;
        if (config && (!Number.isInteger(value) || value < 1 || value > 31)) throw new Error("当期起始日配置无效");
        if (Number.isInteger(value) && value >= 1 && value <= 31) setStartDay(value);
        setError(null);
        setReady(true);
      }).catch(() => {
        if (!cancelled && request === version.current) { setError("当期配置读取失败，请重试"); setReady(false); }
      });
    };
    const changed = (event: Event) => {
      const value = (event as CustomEvent<number>).detail;
      if (Number.isInteger(value) && value >= 1 && value <= 31) {
        version.current += 1;
        setStartDay(value);
        setSelection(null);
        setError(null);
        setReady(true);
      }
    };
    const onFocus = () => { setToday(dayjs().format("YYYY-MM-DD")); load(); };
    load();
    window.addEventListener(PERIOD_CHANGED, changed);
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => setToday(dayjs().format("YYYY-MM-DD")), 60_000);
    return () => { cancelled = true; window.removeEventListener(PERIOD_CHANGED, changed); window.removeEventListener("focus", onFocus); window.clearInterval(timer); };
  }, [enabled, retryCount]);
  return {
    period: selection ?? currentReportPeriod(dayjs(), startDay),
    startDay,
    ready,
    error,
    retry: () => setRetryCount((value) => value + 1),
    setPeriod: (period) => {
      const current = currentReportPeriod(dayjs(), startDay);
      setSelection(period.from === current.from && period.to === current.to ? null : period);
    },
    useCurrentPeriod: () => setSelection(null),
    usePreviousPeriod: () => setSelection(previousReportPeriod(dayjs(), startDay)),
  };
}

export function BusinessPeriodProvider({ children }: { children: ReactNode }) {
  const state = usePeriodState();
  return <PeriodContext.Provider value={state}>{children}</PeriodContext.Provider>;
}

export function useBusinessPeriod(): PeriodState {
  const context = useContext(PeriodContext);
  const fallback = usePeriodState(context === null);
  return context ?? fallback;
}
