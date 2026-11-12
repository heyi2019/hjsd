import { useLayoutEffect, useRef, useState, type Key, type Dispatch, type SetStateAction, type MutableRefObject } from "react";
import { stocksApi } from "../../shared/api/stocks.api";
import type { AccountExecutionDetail } from "../../shared/api/types/account-execution";
import type { Account } from "../../shared/api/types/accounts";
import { normalizeError } from "../../shared/api/client";

export function useExecutionCache({ setRows, setError, locallyRemovedIdsRef }: {
  setRows: Dispatch<SetStateAction<Account[]>>;
  setError: Dispatch<SetStateAction<{ message: string; code?: string } | null>>;
  locallyRemovedIdsRef: MutableRefObject<Set<number>>;
}) {
  const [executionDetails, setExecutionDetails] = useState<Record<number, AccountExecutionDetail>>({});
  const [executionLoading, setExecutionLoading] = useState<Record<number, boolean>>({});
  const [expandedAccountIds, setExpandedAccountIds] = useState<Key[]>([]);
  // 横向滚动记忆：手风琴展开/收起会以 key 重建整张 Table，旧滚动位置归零。
  // 展开前抓取 .ant-table-body 的 scrollLeft，重建后用 useLayoutEffect 还原（绘制前写回，无闪烁）。
  const scrollLeftRef = useRef(0);
  function captureScroll() {
    const body = document.querySelector<HTMLElement>(".inventory-table .ant-table-body");
    if (body) scrollLeftRef.current = body.scrollLeft;
  }
  function expandTo(ids: Key[]) {
    captureScroll();
    setExpandedAccountIds(ids);
  }
  useLayoutEffect(() => {
    const body = document.querySelector<HTMLElement>(".inventory-table .ant-table-body");
    if (body && scrollLeftRef.current) body.scrollLeft = scrollLeftRef.current;
  }, [expandedAccountIds]);
  async function loadExecution(row: Account, force = false) {
    if (!force && (executionDetails[row.id] || executionLoading[row.id])) return;
    setExecutionLoading((current) => ({ ...current, [row.id]: true }));
    try {
      const detail = await stocksApi.executionDetail(row.id);
      setExecutionDetails((current) => ({ ...current, [row.id]: detail }));
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setExecutionLoading((current) => ({ ...current, [row.id]: false }));
    }
  }
  /** 只丢弃详情缓存：用于账号已离开在库列表（售出/下架）的场景，重拉已无展示方，纯属浪费请求。 */
  function dropExecutionCache(accountId: number) {
    setExecutionDetails((current) => {
      if (!(accountId in current)) return current;
      const next = { ...current };
      delete next[accountId];
      return next;
    });
  }
  /** 售出成功后先从当前视图移除，避免库存列表在异步重拉期间继续展示已售账号。 */
  function removeFromInventory(accountId: number) {
    locallyRemovedIdsRef.current.add(accountId);
    setRows((current) => current.filter((row) => row.id !== accountId));
    setExpandedAccountIds((current) => current.filter((id) => String(id) !== String(accountId)));
  }
  /** 写操作后让详情缓存失效并立即重拉，避免展开区停在写之前的快照。
   *  必须 force：此时 useState 尚未提交，闭包里的 executionDetails 仍是旧值，不加 force 会被命中缓存直接 return。 */
  function refreshExecution(row: Account) {
    dropExecutionCache(row.id);
    void loadExecution(row, true);
  }

  return {
    expandedAccountIds,
    loadExecution,
    executionDetails,
    setExecutionDetails,
    executionLoading,
    dropExecutionCache,
    removeFromInventory,
    refreshExecution,
    setExpandedAccountIds,
    expandTo,
  };
}
