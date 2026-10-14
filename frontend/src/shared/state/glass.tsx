/**
 * 玻璃材质透明度状态层（iOS 27 透明度滑桿口径）。
 * - 单一系数 --glass-alpha 打到 documentElement，全站玻璃材质（--glass / --glass-border
 *   及其派生的 --glass-tint / --glass-hi）自动跟随，无需逐组件改写。
 * - 系数语义：1 = 设计基准值（等价改造前的固定 alpha）；<1 偏 crystal-clear（更透），
 *   >1 偏 fully tinted（更实，alpha 超过 1 由 rgb() 自动 clamp）。
 * - 持久化到 localStorage，刷新不丢。
 *
 * 无障碍边界：系统开启「降低透明度」或「增强对比度」时，tokens.css 的降级块会把 --glass
 * 整条覆盖为不透明实底，此时系数写入不产生视觉变化。UI 层须用 useGlassReduced() 提示用户，
 * 避免给出「滑桿坏了」的错觉。这是 Web 平台的既定边界，非缺陷。
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export const GLASS_MIN = 0.2;
export const GLASS_MAX = 1.6;
export const GLASS_STEP = 0.1;
export const GLASS_DEFAULT = 1;

const STORAGE_KEY = "heijin-glass-alpha";

function clamp(v: number): number {
  return Math.min(GLASS_MAX, Math.max(GLASS_MIN, v));
}

function readInitial(): number {
  if (typeof window === "undefined") return GLASS_DEFAULT;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  const parsed = raw === null ? Number.NaN : Number.parseFloat(raw);
  return Number.isFinite(parsed) ? clamp(parsed) : GLASS_DEFAULT;
}

interface GlassValue {
  alpha: number;
  setAlpha: (next: number) => void;
  /** 系统无障碍降级生效中（降低透明度 / 增强对比度），此时滑桿不产生视觉变化。 */
  reduced: boolean;
}

const GlassContext = createContext<GlassValue | null>(null);

export function GlassProvider({ children }: { children: ReactNode }) {
  const [alpha, setAlphaState] = useState<number>(readInitial);
  const [reduced, setReduced] = useState<boolean>(false);

  useEffect(() => {
    document.documentElement.style.setProperty("--glass-alpha", String(alpha));
  }, [alpha]);

  // 系统偏好是运行时可变的（macOS 里随时开关），用 matchMedia 订阅而非一次性读取。
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const queries = [
      window.matchMedia("(prefers-reduced-transparency: reduce)"),
      window.matchMedia("(prefers-contrast: more)"),
    ];
    const sync = () => setReduced(queries.some((q) => q.matches));
    sync();
    queries.forEach((q) => q.addEventListener?.("change", sync));
    return () => queries.forEach((q) => q.removeEventListener?.("change", sync));
  }, []);

  const setAlpha = (next: number) => {
    const v = clamp(Number.isFinite(next) ? next : GLASS_DEFAULT);
    setAlphaState(v);
    window.localStorage.setItem(STORAGE_KEY, String(v));
  };

  return <GlassContext.Provider value={{ alpha, setAlpha, reduced }}>{children}</GlassContext.Provider>;
}

export function useGlass(): GlassValue {
  const ctx = useContext(GlassContext);
  if (!ctx) throw new Error("useGlass 必须在 GlassProvider 内使用");
  return ctx;
}
