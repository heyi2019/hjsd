/**
 * H5 极简哈希路由。
 *
 * 为什么不用 react-router：
 *  1) H5 的定位是「零 antd、零 router、独立首包」，加一个 20KB 的路由库只为
 *     6 个一级页面 + 若干详情页，不划算；桌面的路由依赖（react-router-dom）
 *     一旦被 H5 import，就会把它的整条依赖链带进首包。
 *  2) 我们需要的能力只有三件：深链、浏览器前进后退、按前缀高亮底栏。
 *     这三件用 hashchange 就够，不需要嵌套路由/loader/数据路由。
 *
 * 路径约定（以 # 开头，可带 query）：
 *   /dashboard
 *   /business/inventory | /business/ledger | /business/collections
 *   /orders/:id | /orders/new
 *   /customers | /customers/:id | /customers/new
 *   /funds | /funds/flows | /funds/reconcile
 *   /operations | /operations/:tab
 *   /settings | /settings/:section
 *   /mine
 */
import { useEffect, useState } from "react";

export const DEFAULT_ROUTE = "/dashboard";

export interface Route {
  path: string;
  query: URLSearchParams;
}

const NAV_EVENT = "h5:navigate";

function snapshot(): Route {
  const raw = window.location.hash.replace(/^#/, "");
  const [path, search] = raw.split("?");
  const normalized = path && path.startsWith("/") ? path : path ? `/${path}` : DEFAULT_ROUTE;
  return { path: normalized, query: new URLSearchParams(search ?? "") };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(snapshot);

  useEffect(() => {
    const sync = () => setRoute(snapshot());
    window.addEventListener("hashchange", sync);
    // history.replaceState 不触发 hashchange，所以「替换式」跳转由本模块自己补事件。
    window.addEventListener(NAV_EVENT, sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener(NAV_EVENT, sync);
    };
  }, []);

  return route;
}

export function navigate(to: string, replace = false): void {
  const target = `#${to}`;
  if (window.location.hash === target) return;
  if (replace) {
    window.history.replaceState(null, "", target);
    window.dispatchEvent(new Event(NAV_EVENT));
    return;
  }
  // 压栈（默认）：保留浏览器后退语义。
  window.location.hash = to;
}

export function goBack(fallback = DEFAULT_ROUTE): void {
  // 直接进详情页（外部深链、刷新）时历史栈里没有上一页，后退会离开本站。
  // 用 history.length 判断不可靠（新标签页也常为 2），故统一走 replace 回退到 fallback。
  if (window.history.length > 1) {
    window.history.back();
  } else {
    navigate(fallback, true);
  }
}

/** 把 "/orders/:id" 与 "/orders/42" 对齐，返回参数表；不匹配返回 null。 */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const a = path.split("/").filter(Boolean);
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i += 1) {
    if (p[i].startsWith(":")) {
      params[p[i].slice(1)] = decodeURIComponent(a[i]);
      continue;
    }
    if (p[i] !== a[i]) return null;
  }
  return params;
}

export function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}
