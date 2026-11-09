/**
 * 主题（亮/暗）状态层。
 * - 初值：localStorage > 浅色。
 * - 同步把 data-theme 打到 documentElement（:root），驱动 tokens.css /
 *   hierarchy.css 里所有 [data-theme="dark"] 令牌块（自定义 CSS 玻璃/渐变/语义色）。
 * - 持久化到 localStorage，刷新不丢。
 *
 * 暗色双轨：自定义 CSS 由 data-theme 接管；antd 组件内部由 antdTheme.darkAlgorithm
 * 接管（见 antdTheme.ts 的 buildTheme）。两者必须同时切，缺一则半边仍是浅色。
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedThemeMode = "light" | "dark";

const STORAGE_KEY = "heijin-theme-mode";

function resolveInitial(): ThemeMode {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "dark" || stored === "light" || stored === "system") {
    document.documentElement.setAttribute("data-theme", stored === "system" ? resolveSystem() : stored);
    return stored;
  }
  document.documentElement.setAttribute("data-theme", "light");
  return "light";
}

function resolveSystem(): ResolvedThemeMode {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

interface ThemeValue {
  mode: ThemeMode;
  resolvedMode: ResolvedThemeMode;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(resolveInitial);
  const [resolvedMode, setResolvedMode] = useState<ResolvedThemeMode>(() =>
    mode === "system" ? resolveSystem() : mode,
  );

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return undefined;
    const sync = () => {
      if (mode === "system") {
        const next = resolveSystem();
        setResolvedMode(next);
        document.documentElement.setAttribute("data-theme", next);
      }
    };
    sync();
    media.addEventListener?.("change", sync);
    return () => media.removeEventListener?.("change", sync);
  }, [mode]);

  const setMode = (next: ThemeMode) => {
    setModeState(next);
    const resolved = next === "system" ? resolveSystem() : next;
    setResolvedMode(resolved);
    document.documentElement.setAttribute("data-theme", resolved);
    window.localStorage.setItem(STORAGE_KEY, next);
  };

  const toggle = () => setMode(mode === "dark" ? "light" : "dark");

  return (
    <ThemeContext.Provider value={{ mode, resolvedMode, setMode, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme 必须在 ThemeProvider 内使用");
  return ctx;
}
