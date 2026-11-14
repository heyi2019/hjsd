import { useLayoutEffect, useRef, useState, type Key, type Dispatch, type SetStateAction, type MutableRefObject } from "react";
import { ordersApi } from "../../shared/api/orders.api";
import type { AccountExecutionDetail } from "../../shared/api/types/account-execution";
import type { Account } from "../../shared/api/types/accounts";
import { normalizeError } from "../../shared/api/client";
import type { InventoryOrderRow } from "./types";

export function useExecutionCache({ setRows, setError, locallyRemovedIdsRef }: {
  setRows: Dispatch<SetStateAction<InventoryOrderRow[]>>;
  setError: Dispatch<SetStateAction<{ message: string; code?: string } | null>>;
  locallyRemovedIdsRef: MutableRefObject<Set<number>>;
}) {
  const [executionDetails, setExecutionDetails] = useState<Record<number, AccountExecutionDetail>>({});
  const [executionLoading, setExecutionLoading] = useState<Record<number, boolean>>({});
  const [orderExecutionDetails, setOrderExecutionDetails] = useState<Record<number, AccountExecutionDetail>>({});
  const [orderExecutionLoading, setOrderExecutionLoading] = useState<Record<number, boolean>>({});
  const [expandedOrderIds, setExpandedOrderIds] = useState<Key[]>([]);
  // 横向滚动记忆：手风琴展开/收起会以 key 重建整张 Table，旧滚动位置归零。
  // 展开前抓取 .ant-table-body 的 scrollLeft，重建后用 useLayoutEffect 还原（绘制前写回，无闪烁）。
  const scrollLeftRef = useRef(0);
  function captureScroll() {
    const body = document.querySelector<HTMLElement>(".inventory-table .ant-table-body");
    if (body) scrollLeftRef.current = body.scrollLeft;
  }
  function expandTo(ids: Key[]) {
    captureScroll();
    setExpandedOrderIds(ids);
  }
  useLayoutEffect(() => {
    const body = document.querySelector<HTMLElement>(".inventory-table .ant-table-body");
    if (body && scrollLeftRef.current) body.scrollLeft = scrollLeftRef.current;
  }, [expandedOrderIds]);
  async function loadExecution(row: Account, force = false) {
    if (!force && (executionDetails[row.id] || executionLoading[row.id])) return;
    if (row.source_order_id == null) {
      setError({ message: "当前账号没有绑定来源订单，无法读取详情" });
      return;
    }
    setExecutionLoading((current) => ({ ...current, [row.id]: true }));
    try {
      const detail = await ordersApi.executionDetail(row.source_order_id);
      setExecutionDetails((current) => ({ ...current, [row.id]: detail }));
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setExecutionLoading((current) => ({ ...current, [row.id]: false }));
    }
  }
  async function loadOrderExecution(orderId: number, force = false) {
    if (!force && (orderExecutionDetails[orderId] || orderExecutionLoading[orderId])) return;
    setOrderExecutionLoading((current) => ({ ...current, [orderId]: true }));
    try {
      const detail = await ordersApi.executionDetail(orderId);
      setOrderExecutionDetails((current) => ({ ...current, [orderId]: detail }));
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setOrderExecutionLoading((current) => ({ ...current, [orderId]: false }));
    }
  }
  /** 编辑入口同时需要账号详情与当前订单详情，两者是同一份订单执行快照。 */
  async function loadEditorExecution(row: Account, orderId: number) {
    const cached = executionDetails[row.id] ?? orderExecutionDetails[orderId];
    if (cached) {
      setExecutionDetails((current) => current[row.id] ? current : { ...current, [row.id]: cached });
      setOrderExecutionDetails((current) => current[orderId] ? current : { ...current, [orderId]: cached });
      return;
    }
    if (executionLoading[row.id] || orderExecutionLoading[orderId]) return;
    setExecutionLoading((current) => ({ ...current, [row.id]: true }));
    setOrderExecutionLoading((current) => ({ ...current, [orderId]: true }));
    try {
      const detail = await ordersApi.executionDetail(orderId);
      setExecutionDetails((current) => ({ ...current, [row.id]: detail }));
      setOrderExecutionDetails((current) => ({ ...current, [orderId]: detail }));
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setExecutionLoading((current) => ({ ...current, [row.id]: false }));
      setOrderExecutionLoading((current) => ({ ...current, [orderId]: false }));
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
  function dropOrderExecutionCache(orderId: number) {
    setOrderExecutionDetails((current) => {
      if (!(orderId in current)) return current;
      const next = { ...current };
      delete next[orderId];
      return next;
    });
  }
  /** 售出成功后先从当前视图移除，避免库存列表在异步重拉期间继续展示已售账号。 */
  function removeFromInventory(accountId: number, orderId?: number) {
    locallyRemovedIdsRef.current.add(accountId);
    setRows((current) => current.filter((row) => row.account.id !== accountId));
    if (orderId != null) {
      setExpandedOrderIds((current) => current.filter((id) => String(id) !== String(orderId)));
    }
  }
  /** 写操作后让详情缓存失效并立即重拉，避免展开区停在写之前的快照。
   *  必须 force：此时 useState 尚未提交，闭包里的 executionDetails 仍是旧值，不加 force 会被命中缓存直接 return。 */
  function refreshExecution(row: Account, orderId = row.source_order_id) {
    dropExecutionCache(row.id);
    void loadExecution(row, true);
    const cachedOrderIds = Object.entries(orderExecutionDetails)
      .filter(([, detail]) => detail.account.id === row.id)
      .map(([id]) => Number(id));
    const orderIds = new Set(orderId != null ? [orderId, ...cachedOrderIds] : cachedOrderIds);
    orderIds.forEach((id) => {
      dropOrderExecutionCache(id);
      void loadOrderExecution(id, true);
    });
  }

  return {
    expandedOrderIds,
    loadExecution,
    executionDetails,
    setExecutionDetails,
    executionLoading,
    orderExecutionDetails,
    orderExecutionLoading,
    setOrderExecutionDetails,
    loadOrderExecution,
    loadEditorExecution,
    dropOrderExecutionCache,
    dropExecutionCache,
    removeFromInventory,
    refreshExecution,
    expandTo,
  };
}
