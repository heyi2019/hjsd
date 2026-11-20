import { useEffect, useLayoutEffect, useRef } from "react";

/** 保证只有最新操作可以更新界面；失效不会取消已发出的写请求。 */
export function createLatestRequest() {
  let version = 0;
  return {
    start: () => ++version,
    invalidate: () => { version += 1; },
    current: () => version,
    isCurrent: (token: number) => token === version,
  };
}

export type LatestRequest = ReturnType<typeof createLatestRequest>;

export function createKeyedLatestRequest<Key>() {
  const versions = new Map<Key, number>();
  const current = (key: Key) => versions.get(key) ?? 0;
  const start = (key: Key) => {
    const next = current(key) + 1;
    versions.set(key, next);
    return next;
  };
  return {
    start,
    invalidate: (key: Key) => { start(key); },
    current,
    isCurrent: (key: Key, token: number) => current(key) === token,
    snapshot: () => new Map(versions),
    invalidateAll: () => { for (const key of versions.keys()) start(key); },
  };
}

export function useKeyedLatestRequest<Key>() {
  const ref = useRef<ReturnType<typeof createKeyedLatestRequest<Key>> | null>(null);
  if (!ref.current) ref.current = createKeyedLatestRequest<Key>();
  const request = ref.current;
  useEffect(() => () => request.invalidateAll(), [request]);
  return request;
}

/** 在组件整个生命周期共享同一个请求序列，卸载时使未完成的结果失效。 */
export function useLatestRequest(): LatestRequest {
  const ref = useRef<LatestRequest | null>(null);
  if (!ref.current) ref.current = createLatestRequest();
  const request = ref.current;
  useEffect(() => () => request.invalidate(), [request]);
  return request;
}

/** 弹窗目标或开关改变时，旧会话的异步结果立即失效。 */
export function useRequestSession(key: unknown): LatestRequest {
  const request = useLatestRequest();
  useLayoutEffect(() => {
    request.invalidate();
    return request.invalidate;
  }, [key, request]);
  return request;
}
