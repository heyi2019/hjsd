/*
 * 触觉反馈工具（Apple HIG「感官反馈 / Haptics」）。
 * ---------------------------------------------------------------------------
 * 平台边界（务必知悉，非缺陷）：
 *   - iOS Safari **不支持** navigator.vibrate（Web 平台限制，Apple 未在 WKWebView
 *     暴露 Vibration API）。故 iPhone 上 vibrate 必然返回 false。
 *   - Android Chrome / 多数安卓浏览器支持 navigator.vibrate。
 * 因此本工具只做「尽力而为」：支持则轻触，不支持则调用方改用视觉脉冲替代
 * （见 ConfirmButton 的 .haptic-pulse）。不要假设返回值恒为 true。
 *
 * 选用「轻量级」触感档，避免每次点击都重击用户手腕（Apple 准则：触觉应克制）。
 */
export type HapticKind = "light" | "medium" | "heavy" | "success" | "warning" | "error";

const PATTERN: Record<HapticKind, number[]> = {
  light: [8],
  medium: [14],
  heavy: [22],
  success: [10, 30, 12],
  warning: [18, 40, 18],
  error: [28, 60, 28],
};

/** 触发触觉。返回 true 表示平台已接受振动指令；false 表示不支持（调用方应视觉替代）。 */
export function haptic(kind: HapticKind = "light"): boolean {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") {
    return false;
  }
  try {
    return navigator.vibrate(PATTERN[kind]);
  } catch {
    return false;
  }
}

/** 在不支持 vibrate 的端（如 iOS Safari）给元素加一次性视觉脉冲，替代触觉。 */
export function visualPulse(el: Element | null | undefined, ms = 220): void {
  if (!el) return;
  el.classList.add("haptic-pulse");
  window.setTimeout(() => el.classList.remove("haptic-pulse"), ms);
}
