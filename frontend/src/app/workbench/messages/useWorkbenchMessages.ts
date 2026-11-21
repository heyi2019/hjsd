import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { notificationsApi, type ProfitNotificationDetail as ProfitDetail } from "../../../shared/api/notifications.api";
import type { NotificationItem } from "../../../shared/api/types/common";
import { useSession } from "../../../shared/state/session";

const PAGE_SIZE = 10;

export function isProfitNotification(item: NotificationItem) {
  return item.entity_type === "order" && (item.notification_type === "PROFIT_PENDING" || item.notification_type === "PROFIT_ALLOCATED");
}

export function useWorkbenchMessages({ onPendingProfitNotificationsClick, onProfitNotificationsRead, active = true }: { onPendingProfitNotificationsClick?: (id?: number) => void; onProfitNotificationsRead?: () => void; active?: boolean }) {
  const { username } = useSession();
  const [dataOwner, setDataOwner] = useState(username);
  const [selected, setSelected] = useState<NotificationItem | null>(null);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [notificationDetails, setNotificationDetails] = useState<Record<number, ProfitDetail>>({});
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [inventorySyncError, setInventorySyncError] = useState(false);
  const [notificationLoading, setNotificationLoading] = useState(true);
  const [category, setCategory] = useState<"latest" | "sale" | "inventory">("latest");
  const [retryItem, setRetryItem] = useState<NotificationItem | null>(null);
  const [reload, setReload] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const cursor = useRef<{ next?: string; done: boolean; generation: number; loading: boolean }>({ done: false, generation: 0, loading: false });
  const scrollRef = useRef<HTMLDivElement>(null);
  const busy = useRef(new Set<number>());
  const inventorySync = useRef<Promise<unknown> | null>(null);
  const refreshAfterRead = useRef<number | null>(null);
  const preserve = useRef<{ count: number; top: number } | null>(null);
  const restoreTop = useRef<number | null>(null);
  const loadMore = async () => {
    const state = cursor.current;
    if (!active || state.loading || state.done) return;
    state.loading = true;
    const generation = state.generation;
    setNotificationLoading(true);
    try {
      const target = preserve.current?.count ?? PAGE_SIZE;
      const items: NotificationItem[] = [];
      const details: ProfitDetail[] = [];
      let next = state.next;
      do {
        const page = await notificationsApi.list({ limit: PAGE_SIZE, category, ...(next ? { cursor: next } : {}) });
        if (cursor.current.generation !== generation) return;
        const ids = page.items.filter(isProfitNotification).map((item) => item.id);
        if (ids.length) {
          try { details.push(...await notificationsApi.profitDetails(ids)); } catch { /* 消息仍可展示 */ }
        }
        if (cursor.current.generation !== generation) return;
        if (page.next_cursor && page.next_cursor === next) throw new Error("消息分页游标异常");
        items.push(...page.items);
        next = page.next_cursor ?? undefined;
      } while (next && items.length < target);
      setNotificationDetails((current) => ({ ...current, ...Object.fromEntries(details.map((item) => [item.notification_id, item])) }));
      setNotifications((current) => [...current, ...items]);
      if (preserve.current) { restoreTop.current = preserve.current.top; preserve.current = null; }
      state.next = next;
      state.done = !next;
      setHasMore(!state.done);
      setNotificationError(null);
    } catch {
      if (cursor.current.generation === generation) setNotificationError("消息加载失败，请重试。");
    } finally {
      if (cursor.current.generation === generation) { state.loading = false; setNotificationLoading(false); }
    }
  };
  useEffect(() => { setSelected(null); preserve.current = null; restoreTop.current = null; }, [category, username]);
  useEffect(() => { inventorySync.current = null; }, [active, username]);
  useEffect(() => {
    if (!active) return;
    cursor.current = { done: false, generation: cursor.current.generation + 1, loading: true };
    const generation = cursor.current.generation;
    setDataOwner(username);
    setNotifications([]);
    setNotificationDetails({});
    setNotificationError(null);
    setRetryItem(null);
    if (scrollRef.current && !preserve.current) scrollRef.current.scrollTop = 0;
    setHasMore(true);
    setInventorySyncError(false);
    setNotificationLoading(true);
    void (async () => {
      inventorySync.current ??= notificationsApi.syncInventory();
      try { await inventorySync.current; } catch { if (cursor.current.generation === generation) setInventorySyncError(true); }
      if (active && cursor.current.generation === generation) { cursor.current.loading = false; void loadMore(); }
    })();
    return () => { cursor.current.generation += 1; };
    // 加载由 active 和用户重试触发；滚动时使用当前游标。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, reload, category, username]);
  useEffect(() => {
    const el = scrollRef.current;
    if (active && el && !notificationLoading && hasMore && !notificationError && el.scrollHeight <= el.clientHeight + 1) void loadMore();
    // 只有列表不足以滚动时自动补页。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, notifications.length, notificationLoading, hasMore, notificationError]);

  useLayoutEffect(() => {
    if (!notificationLoading && restoreTop.current !== null && scrollRef.current) {
      scrollRef.current.scrollTop = restoreTop.current;
      restoreTop.current = null;
    }
  }, [notificationLoading, notifications]);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden" || notificationLoading || selected || busy.current.size || (scrollRef.current?.scrollTop ?? 0) > 0) return;
      preserve.current = { count: notifications.length, top: 0 };
      if (category !== "sale") inventorySync.current = null;
      setReload((n) => n + 1);
    }, 5 * 60_000);
    return () => window.clearInterval(timer);
  }, [active, category, notifications.length, notificationLoading, selected]);

  const openNotification = async (item: NotificationItem) => {
    if (busy.current.has(item.id)) return;
    busy.current.add(item.id);
    const generation = cursor.current.generation;
    try {
      if (!item.read_at) {
        const result = await notificationsApi.markReadBatch([item.id]);
        if (cursor.current.generation !== generation) return;
        if (!result.read_ids.includes(item.id)) throw new Error("标记已读失败，请重试。");
        if (category === "latest") setNotifications((current) => current.filter((entry) => entry.id !== item.id));
        else refreshAfterRead.current = generation;
        onProfitNotificationsRead?.();
      }
      setNotificationError(null);
      setRetryItem(null);
      if (item.notification_type === "PROFIT_PENDING" && item.entity_type === "order") onPendingProfitNotificationsClick?.(item.id);
      else setSelected(item);
    } catch {
      if (cursor.current.generation === generation) { setNotificationError("标记已读失败，请重试。"); setRetryItem(item); }
    } finally {
      busy.current.delete(item.id);
      if (!busy.current.size && refreshAfterRead.current === cursor.current.generation) {
        refreshAfterRead.current = null;
        preserve.current = { count: notifications.length, top: scrollRef.current?.scrollTop ?? 0 };
        setReload((n) => n + 1);
      }
    }
  };
  const ordered = dataOwner === username ? notifications : [];
  const retryInventory = () => { inventorySync.current = null; setReload((n) => n + 1); };
  return { username, dataOwner, selected, setSelected, notifications, notificationDetails, notificationError, inventorySyncError, notificationLoading, category, setCategory, retryItem, setReload, retryInventory, hasMore, scrollRef, loadMore, openNotification, ordered };
}
