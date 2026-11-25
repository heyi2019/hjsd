import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import dayjs from "dayjs";
import { optionSetsApi } from "../api/options.api";
import { currentReportPeriod, previousReportPeriod, type ReportPeriod } from "../lib/reportPeriod";

export const BUSINESS_PERIOD_CODE = "BUSINESS_PERIOD";
const PERIOD_CHANGED = "business-period-config-changed";

export type PeriodState = {
  period: ReportPeriod | null;
  startDay: number;
  ready: boolean;
  error: string | null;
  retry: () => void;
  setPeriod: (period: ReportPeriod) => void;
  useCurrentPeriod: () => void;
  usePreviousPeriod: () => void;
  useAllPeriods: () => void;
};

const PeriodContext = createContext<PeriodState | null>(null);

export function announceBusinessPeriodChange(startDay: number) {
  window.dispatchEvent(new CustomEvent(PERIOD_CHANGED, { detail: startDay }));
}

function usePeriodState(enabled = true): PeriodState {
  const [startDay, setStartDay] = useState(16);
  const [selection, setSelection] = useState<ReportPeriod | null | undefined>(undefined);
  const [ready, setReady] = useState(!enabled);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const version = useRef(0);
  // today 值本身不参与计算，但跨天时用它作为 period memo 的依赖，保证「当期」随日期滚动重算。
  const [today, setToday] = useState(() => dayjs().format("YYYY-MM-DD"));
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
        setSelection(undefined);
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
  // 稳定 state 对象与 action 引用：Provider value 在无关渲染时保持同一引用，
  // 避免 4 个页面级消费者（含 keep-alive 隐藏页）连同子树整棵重渲染。
  // 周期切换 / 配置回填 / 跨天滚动时依赖变化，行为与改造前完全一致。
  const period = useMemo(
    () => (selection === undefined ? currentReportPeriod(dayjs(), startDay) : selection),
    [selection, startDay, today],
  );
  const retry = useCallback(() => setRetryCount((value) => value + 1), []);
  const setPeriod = useCallback((next: ReportPeriod) => {
    const current = currentReportPeriod(dayjs(), startDay);
    setSelection(next.from === current.from && next.to === current.to ? undefined : next);
  }, [startDay]);
  const useCurrentPeriod = useCallback(() => setSelection(undefined), []);
  const usePreviousPeriod = useCallback(() => setSelection(previousReportPeriod(dayjs(), startDay)), [startDay]);
  const useAllPeriods = useCallback(() => setSelection(null), []);

  return useMemo(() => ({
    period,
    startDay,
    ready,
    error,
    retry,
    setPeriod,
    useCurrentPeriod,
    usePreviousPeriod,
    useAllPeriods,
  }), [period, startDay, ready, error, retry, setPeriod, useCurrentPeriod, usePreviousPeriod, useAllPeriods]);
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
