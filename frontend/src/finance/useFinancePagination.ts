import { useCallback, useRef, useState } from "react";
import { normalizeError, type NormalizedError } from "../shared/api/client";
import { useLatestRequest } from "../shared/hooks/useLatestRequest";

type PageRequest = { limit: number; offset: number };
type PageResult<T> = { items: T[]; total: number };

/** 资金域分页：旧请求失效、页大小变更及末页回退。 */
export function useFinancePagination<T>(fetchPage: (params: PageRequest) => Promise<PageResult<T>>) {
  const [items, setItems] = useState<T[]>([]);
  const [paging, setPaging] = useState({ page: 1, pageSize: 10, total: 0 });
  const pagingRef = useRef(paging);
  pagingRef.current = paging;
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<NormalizedError | null>(null);
  const request = useLatestRequest();

  const load = useCallback(async () => {
    const id = request.start();
    setReady(false);
    setLoading(true);
    setError(null);
    try {
      let selected = pagingRef.current;
      let result = await fetchPage({ limit: selected.pageSize, offset: (selected.page - 1) * selected.pageSize });
      if (!request.isCurrent(id)) return;
      const lastPage = Math.max(1, Math.ceil(result.total / selected.pageSize));
      if (selected.page > lastPage) {
        selected = { ...selected, page: lastPage };
        result = await fetchPage({ limit: selected.pageSize, offset: (lastPage - 1) * selected.pageSize });
        if (!request.isCurrent(id)) return;
      }
      const next = { ...selected, total: result.total };
      pagingRef.current = next;
      setPaging(next);
      setItems(result.items);
      setReady(true);
    } catch (err) {
      if (request.isCurrent(id)) setError(normalizeError(err));
    } finally {
      if (request.isCurrent(id)) setLoading(false);
    }
  }, [fetchPage, request]);

  const setPage = (page: number, pageSize: number) => {
    const next = { ...pagingRef.current, page: pageSize === pagingRef.current.pageSize ? page : 1, pageSize };
    pagingRef.current = next;
    setPaging(next);
    void load();
  };
  return { items, ready, loading, error, paging, load, setPage };
}
