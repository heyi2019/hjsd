import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeError } from "../shared/api/client";
import { counterpartiesApi } from "../shared/api/customers.api";
import type { Counterparty } from "../shared/api/types/customers";
import { useLatestRequest } from "../shared/hooks/useLatestRequest";

export function useCounterpartyList(active: boolean, createdPeriod?: { from: string; to: string } | null) {
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [searchInput, setSearchInput] = useState("");
  const [keyword, setKeyword] = useState("");
  const [creatorFilter, setCreatorFilter] = useState<string[]>([]);
  const [rows, setRows] = useState<Counterparty[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [total, setTotal] = useState(0);
  const [sortDesc, setSortDesc] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const request = useLatestRequest();

  const loadList = useCallback(async () => {
    const token = request.start();
    setLoading(true);
    try {
      const result = await counterpartiesApi.page({
        ...(keyword.trim() ? { keyword: keyword.trim() } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(creatorFilter.length > 0 ? { created_by: creatorFilter } : {}),
        ...(createdPeriod ? { created_from: createdPeriod.from, created_to: createdPeriod.to } : {}),
        ...(sortDesc ? {} : { sort_desc: false }),
        limit: pageSize, offset: (page - 1) * pageSize,
      });
      if (!request.isCurrent(token)) return;
      if (!result.items.length && page > 1 && (page - 1) * pageSize >= result.total) {
        setPage(Math.max(1, Math.ceil(result.total / pageSize)));
        return;
      }
      setRows(result.items);
      setTotal(result.total);
      setError(null);
    } catch (err) {
      if (request.isCurrent(token)) setError(normalizeError(err));
    } finally {
      if (request.isCurrent(token)) setLoading(false);
    }
  }, [creatorFilter, keyword, page, pageSize, sortDesc, statusFilter, createdPeriod?.from, createdPeriod?.to, request]);

  const latestLoad = useRef<() => Promise<void>>(async () => {});
  latestLoad.current = async () => { if (active) await loadList(); };
  const load = useCallback(() => latestLoad.current(), []);

  const resetKey = JSON.stringify([createdPeriod?.from, createdPeriod?.to]);
  const previousResetKey = useRef(resetKey);
  useEffect(() => {
    if (!active) return;
    if (previousResetKey.current !== resetKey) {
      previousResetKey.current = resetKey;
      if (page !== 1) { setPage(1); return; }
    }
    void loadList();
    return request.invalidate;
  }, [active, loadList, page, resetKey, request]);

  return {
    statusFilter, setStatusFilter, searchInput, setSearchInput, setKeyword, creatorFilter, setCreatorFilter,
    rows, total, loading, error, sortDesc, setSortDesc, page, setPage, pageSize, setPageSize, load,
  };
}
