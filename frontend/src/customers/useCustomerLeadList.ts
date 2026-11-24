import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeError } from "../shared/api/client";
import { leadsApi } from "../shared/api/customers.api";
import type { Lead, LeadSummary } from "../shared/api/types/customers";
import { useLatestRequest } from "../shared/hooks/useLatestRequest";

export function useCustomerLeadList(active: boolean, createdPeriod?: { from: string; to: string } | null) {
  const [rows, setRows] = useState<Lead[]>([]);
  const [summary, setSummary] = useState<LeadSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [summaryError, setSummaryError] = useState<{ message: string; code?: string } | null>(null);
  const [total, setTotal] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [keyword, setKeyword] = useState("");
  const [sortDesc, setSortDesc] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const listRequest = useLatestRequest();
  const summaryRequest = useLatestRequest();

  const loadList = useCallback(async () => {
    const request = listRequest.start();
    setLoading(true);
    const dates = createdPeriod ? { created_from: createdPeriod.from, created_to: createdPeriod.to } : {};
    try {
      const result = await leadsApi.page({ ...dates, ...(keyword.trim() ? { keyword: keyword.trim() } : {}), ...(sortDesc ? {} : { sort_desc: false }), limit: pageSize, offset: (page - 1) * pageSize });
      if (!listRequest.isCurrent(request)) return;
      if (!result.items.length && page > 1 && (page - 1) * pageSize >= result.total) {
        setPage(Math.max(1, Math.ceil(result.total / pageSize)));
        return;
      }
      setRows(result.items);
      setTotal(result.total);
      setError(null);
    } catch (err) {
      if (listRequest.isCurrent(request)) setError(normalizeError(err));
    } finally {
      if (listRequest.isCurrent(request)) setLoading(false);
    }
  }, [keyword, page, pageSize, sortDesc, createdPeriod?.from, createdPeriod?.to, listRequest]);

  const loadSummary = useCallback(async () => {
    const request = summaryRequest.start();
    setSummaryLoading(true);
    setSummaryError(null);
    const dates = createdPeriod ? { created_from: createdPeriod.from, created_to: createdPeriod.to } : {};
    try {
      const result = await leadsApi.summary({ ...dates, ...(keyword.trim() ? { keyword: keyword.trim() } : {}) });
      if (summaryRequest.isCurrent(request)) setSummary(result);
    } catch (err) {
      if (summaryRequest.isCurrent(request)) setSummaryError(normalizeError(err));
    } finally {
      if (summaryRequest.isCurrent(request)) setSummaryLoading(false);
    }
  }, [keyword, createdPeriod?.from, createdPeriod?.to, summaryRequest]);

  const latestLoad = useRef<() => Promise<void>>(async () => {});
  latestLoad.current = async () => { if (active) await Promise.all([loadList(), loadSummary()]); };
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
    return listRequest.invalidate;
  }, [active, loadList, page, resetKey, listRequest]);
  useEffect(() => {
    if (!active) return;
    void loadSummary();
    return summaryRequest.invalidate;
  }, [active, loadSummary, summaryRequest]);

  return {
    rows, total, summary, loading, summaryLoading, error, summaryError,
    searchInput, setSearchInput, setKeyword, sortDesc, setSortDesc,
    page, setPage, pageSize, setPageSize, setError, load, loadList, loadSummary,
  };
}
