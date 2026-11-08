/**
 * 移动端下拉刷新（Pull-to-refresh）。
 *
 * 设计要点：
 * - 仅在触摸设备（pointer: coarse）生效；桌面端不接管、指示器恒隐藏。
 * - 滚动容器是 document.body（移动端实测），故手势监听挂在 body 上。
 * - 复用各列表页已有的 loader：页面通过 useReloadOnActive / usePullToRefresh 把
 *   loader 注册进来；手势在 body 处于顶部且下拉超阈值时，触发当前注册 loader。
 * - 任意 antd Modal 打开时（.ant-modal-root 可见）不接管，避免盖在弹层上误刷新。
 * - 三态：pulling（下拉中）/ ready（超阈值可释放）/ refreshing（刷新中）。
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

type Loader = () => void | Promise<void>;

interface PullToRefreshApi {
  register: (loader: Loader | null) => void;
}

const PullToRefreshContext = createContext<PullToRefreshApi | null>(null);

/** 供页面（useReloadOnActive / 直接使用）注册自己的刷新函数。 */
export function usePullToRefreshRegistration(): PullToRefreshApi | null {
  return useContext(PullToRefreshContext);
}

const THRESHOLD = 64; // 触发刷新所需下拉距离(px)
const MAX_PULL = 120; // 可视下拉上限(px)
const RESISTANCE = 0.5; // 橡皮筋系数（越大越跟手）
const TOPBAR_OFFSET = 56; // 顶栏近似高度：指示器从其下方透出（仿 iOS）
const REFRESH_MIN_MS = 400; // 刷新态最短停留，避免闪一下

type Status = "idle" | "pulling" | "ready" | "refreshing";

interface IndicatorState {
  status: Status;
  pull: number;
}

export function PullToRefreshProvider({ children }: { children: ReactNode }) {
  const [indicator, setIndicator] = useState<IndicatorState>({ status: "idle", pull: 0 });
  const loaderRef = useRef<Loader | null>(null);
  // 手势期间的可变状态用 ref 持有，避免每次 pull 变化都重挂监听。
  const stateRef = useRef({ startY: 0, pulling: false, token: 0, status: "idle" as Status, pull: 0 });

  const register = useCallback((loader: Loader | null) => {
    loaderRef.current = loader;
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    if (!window.matchMedia("(pointer: coarse)").matches) return; // 桌面不接管

    const body = document.body;
    const atTop = () =>
      Math.max(body.scrollTop || 0, document.documentElement.scrollTop || 0, 0) <= 0;
    const modalOpen = () => {
      const root = document.querySelector(".ant-modal-root");
      return !!root && (root as HTMLElement).offsetParent !== null;
    };

    const update = (status: Status, pull: number) => {
      stateRef.current.status = status;
      stateRef.current.pull = pull;
      setIndicator({ status, pull });
    };

    const onStart = (e: TouchEvent) => {
      const s = stateRef.current;
      if (s.status === "refreshing") return;
      if (!atTop() || modalOpen() || !loaderRef.current) {
        s.pulling = false;
        return;
      }
      s.startY = e.touches[0].clientY;
      s.pulling = true;
    };

    const onMove = (e: TouchEvent) => {
      const s = stateRef.current;
      if (!s.pulling) return;
      const dy = e.touches[0].clientY - s.startY;
      if (dy <= 0) {
        // 向上/回滚：交还原生滚动，撤销本次手势。
        s.pulling = false;
        if (s.status !== "idle") update("idle", 0);
        return;
      }
      if (!atTop()) {
        // 起点判定为顶部，但过程中已离开顶部（理论上少见），撤销。
        s.pulling = false;
        update("idle", 0);
        return;
      }
      // 顶部下拉：阻止原生过滚动，自行接管，呈现橡皮筋阻尼。
      e.preventDefault();
      const resisted = Math.min(MAX_PULL, dy * RESISTANCE);
      update(resisted >= THRESHOLD ? "ready" : "pulling", resisted);
    };

    const onEnd = () => {
      const s = stateRef.current;
      if (!s.pulling) return;
      s.pulling = false;
      if (s.status === "ready") {
        const token = ++s.token;
        update("refreshing", THRESHOLD);
        Promise.resolve()
          .then(() => loaderRef.current && loaderRef.current())
          .then(() => new Promise((r) => window.setTimeout(r, REFRESH_MIN_MS)))
          .then(() => {
            if (stateRef.current.token === token) update("idle", 0);
          })
          .catch(() => {
            if (stateRef.current.token === token) update("idle", 0);
          });
      } else {
        update("idle", 0);
      }
    };

    body.addEventListener("touchstart", onStart, { passive: true });
    body.addEventListener("touchmove", onMove, { passive: false });
    body.addEventListener("touchend", onEnd, { passive: true });
    body.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      body.removeEventListener("touchstart", onStart);
      body.removeEventListener("touchmove", onMove);
      body.removeEventListener("touchend", onEnd);
      body.removeEventListener("touchcancel", onEnd);
    };
  }, []);

  const { status, pull } = indicator;
  const label =
    status === "refreshing" ? "刷新中…" : status === "ready" ? "释放即可刷新" : "下拉刷新";
  const visible = status !== "idle";
  const translateY = Math.min(Math.max(pull - TOPBAR_OFFSET, -TOPBAR_OFFSET), 0);

  return (
    <PullToRefreshContext.Provider value={{ register }}>
      {children}
      <div
        className={`ptr-indicator ptr-${status}`}
        style={{ opacity: visible ? 1 : 0, transform: `translateY(${translateY}px)` }}
        aria-hidden="true"
      >
        <span
          className={`ptr-spinner${status === "refreshing" ? " spinning" : ""}`}
          style={{ transform: `rotate(${(pull / THRESHOLD) * 220}deg)` }}
        />
        <span className="ptr-label">{label}</span>
      </div>
    </PullToRefreshContext.Provider>
  );
}
