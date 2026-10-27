import { useEffect, useState } from "react";

/** 窄屏（移动端）布局开关：≤640px 时返回 true。
 *
 * 用于「桌面表格 / 移动卡片列表」二选一渲染——同一时刻只挂一种，
 * 避免移动卡片与桌面表格同处 DOM 造成测试里 getByRole 单匹配歧义。
 * 测试环境 matchMedia 桩固定 matches:false，故测试里恒为 false（只渲染表格）。
 */
export function useCompactLayout(breakpoint = 640): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const media = window.matchMedia?.(`(max-width: ${breakpoint}px)`);
    if (!media) return undefined;
    const sync = () => setCompact(media.matches);
    sync();
    media.addEventListener?.("change", sync);
    return () => media.removeEventListener?.("change", sync);
  }, [breakpoint]);
  return compact;
}
