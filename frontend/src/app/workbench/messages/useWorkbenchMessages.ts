import { useEffect, useRef, useState } from "react";
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
  const loadMore = async () => {
    const state = cursor.current;
    if (!active || state.loading || state.done) return;
    state.loading = true;
    const generation = state.generation;
    setNotificationLoading(true);
    try {
      const page = await notificationsApi.list({ limit: PAGE_SIZE, category, ...(state.next ? { cursor: state.next } : {}) });
      if (cursor.current.generation !== generation) return;
      const ids = page.items.filter(isProfitNotification).map((item) => item.id);
      let details: ProfitDetail[] = [];
      if (ids.length) {
        try { details = await notificationsApi.profitDetails(ids); } catch { /* 消息仍可展示 */ }
      }
      if (cursor.current.generation !== generation) return;
      if (page.next_cursor && page.next_cursor === state.next) throw new Error("消息分页游标异常");
      setNotificationDetails((current) => ({ ...current, ...Object.fromEntries(details.map((item) => [item.notification_id, item])) }));
      setNotifications((current) => [...current, ...page.items]);
      state.next = page.next_cursor ?? undefined;
      state.done = !page.next_cursor;
      setHasMore(!state.done);
      setNotificationError(null);
    } catch {
      if (cursor.current.generation === generation) setNotificationError("消息加载失败，请重试。");
    } finally {
      if (cursor.current.generation === generation) { state.loading = false; setNotificationLoading(false); }
    }
  };
  useEffect(() => { setSelected(null); }, [category, username]);
  useEffect(() => {
    if (!active) return;
    cursor.current = { done: false, generation: cursor.current.generation + 1, loading: true };
    const generation = cursor.current.generation;
    setDataOwner(username);
    setNotifications([]);
    setNotificationDetails({});
    setNotificationError(null);
    setRetryItem(null);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setHasMore(true);
    setInventorySyncError(false);
    setNotificationLoading(true);
    void (async () => {
      try { await notificationsApi.syncInventory(); } catch { if (cursor.current.generation === generation) setInventorySyncError(true); }
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
        else setReload((n) => n + 1);
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
    }
  };
  const ordered = dataOwner === username ? notifications : [];
  return { username, dataOwner, selected, setSelected, notifications, notificationDetails, notificationError, inventorySyncError, notificationLoading, category, setCategory, retryItem, setReload, hasMore, scrollRef, loadMore, openNotification, ordered };
}
