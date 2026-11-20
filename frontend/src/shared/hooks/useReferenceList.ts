import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeReferenceDataChanged, type ReferenceData } from "../state/referenceDataEvents";

/** 仅在资料被读取过时跟随变更刷新，并忽略变更前发出的旧请求。 */
export function useReferenceList<T>(resource: ReferenceData, list: () => Promise<T[]>, autoLoad = true) {
  const [items, setItems] = useState<T[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [settled, setSettled] = useState(false);
  const sequence = useRef(0);
  const mounted = useRef(false);
  const requested = useRef(false);

  const reload = useCallback(async () => {
    requested.current = true;
    const request = ++sequence.current;
    try {
      const next = (await list()) ?? [];
      if (mounted.current && request === sequence.current) {
        setItems(next);
        setError(null);
        setSettled(true);
      }
      return next;
    } catch (cause) {
      if (!mounted.current || request !== sequence.current) return [];
      setError(cause);
      setSettled(true);
      throw cause;
    }
  }, [list]);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = subscribeReferenceDataChanged(resource, () => {
      if (requested.current) void reload().catch(() => undefined);
    });
    if (autoLoad) void reload().catch(() => undefined);
    return () => {
      mounted.current = false;
      sequence.current += 1;
      unsubscribe();
    };
  }, [autoLoad, reload, resource]);

  return { items, error, settled, reload };
}
