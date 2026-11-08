// AppShell 对访问过的页面做 keep-alive（仅 display:none 隐藏，不卸载），
// 因此「仅在 mount 时加载」的页面不会自动感知其他页面/入口写入的数据变更
// 确保切回页面时能看到最新数据。
// 统一收敛为 useReloadOnActive：页面把 loader 交给它，即可在「首次挂载 + 每次重新激活」时重拉，
// 避免每个页面各自记得写 useEffect 而漏接。
//
// 用法：
//   useReloadOnActive(active, load);            // active 由 AppShell 下发
//   useReloadOnActive(active, load, { skipFirstMount: true }); // 不想与已有 mount 效应重复拉取时
import { useEffect, useRef } from "react";
import { usePullToRefreshRegistration } from "../ui/pullToRefresh/PullToRefreshProvider";

export function useReloadOnActive(
  active: boolean,
  loader: () => void | Promise<void>,
  options?: { skipFirstMount?: boolean },
): void {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const mountedRef = useRef(false);
  // 下拉刷新：把同一份 loader 注册给 PullToRefreshProvider（仅激活页生效）。
  const ptr = usePullToRefreshRegistration();
  useEffect(() => {
    if (!ptr) return;
    ptr.register(active ? loaderRef.current : null);
    return () => ptr.register(null);
  }, [active, ptr]);
  useEffect(() => {
    const firstRun = !mountedRef.current;
    mountedRef.current = true;
    if (!active) return;
    if (firstRun && options?.skipFirstMount) return;
    void loaderRef.current();
    // loader 每次渲染可能重建（内联 async 函数），故不放依赖，只按 active 触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
