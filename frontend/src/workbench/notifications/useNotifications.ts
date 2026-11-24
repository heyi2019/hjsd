import { useEffect, useRef, useState } from "react";
import { notificationsApi, type NotificationCategory } from "../../shared/api/notifications.api";
import { useNotificationDetails } from "./useNotificationDetails";
import { useReminderSync } from "./useReminderSync";
import type { NotificationItem } from "../../shared/api/types/common";
import { useSession } from "../../shared/state/session";
import { appMessage } from "../../shared/ui/appFeedback";

const PAGE_SIZE = 10;

export function isProfitNotification(item: NotificationItem) {
  return item.entity_type === "order" && (item.notification_type === "PROFIT_PENDING" || item.notification_type === "PROFIT_ALLOCATED");
}

export function useNotifications({ onPendingProfitNotificationsClick, active = true }: { onPendingProfitNotificationsClick?: (id?: number) => void | Promise<void>; active?: boolean }) {
  const { username } = useSession();
  const [dataOwner, setDataOwner] = useState(username);
  const [selected, setSelected] = useState<NotificationItem | null>(null);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [notificationLoading, setNotificationLoading] = useState(true);
  const [category, setCategory] = useState<NotificationCategory>("latest");
  const [retryItem, setRetryItem] = useState<NotificationItem | null>(null);
  const [reload, setReload] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const cursor = useRef<{ next?: string; done: boolean; generation: number; loading: boolean }>({ done: false, generation: 0, loading: false });
  const detailState = useNotificationDetails((generation) => cursor.current.generation === generation);
  const scrollRef = useRef<HTMLDivElement>(null);
  const busy = useRef(new Set<number>());
  const reminderSync = useReminderSync({ active, username, category, selected, loading: notificationLoading, notificationCount: notifications.length, busy, scrollRef, onRefresh: () => setReload((n) => n + 1) });
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
      if (page.next_cursor && page.next_cursor === state.next) throw new Error("消息分页游标异常");
      setNotifications((current) => [...current, ...page.items]);
      void detailState.load(ids, generation);
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
  useEffect(() => { setSelected(null); }, [active, category, username]);
  useEffect(() => {
    if (!active) return;
    cursor.current = { done: false, generation: cursor.current.generation + 1, loading: true };
    const generation = cursor.current.generation;
    setDataOwner(username);
    setNotifications([]);
    detailState.reset();
    setNotificationError(null);
    setRetryItem(null);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setHasMore(true);
    setNotificationLoading(true);
    reminderSync.start();
    cursor.current.loading = false;
    void loadMore();
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

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden" || notificationLoading || selected || busy.current.size || (scrollRef.current?.scrollTop ?? 0) > 0) return;
      if (category !== "sale") reminderSync.invalidate();
      setReload((n) => n + 1);
    }, 5 * 60_000);
    return () => window.clearInterval(timer);
  }, [active, category, notifications.length, notificationLoading, selected]);

  const openNotification = async (item: NotificationItem) => {
    if (busy.current.has(item.id)) return;
    busy.current.add(item.id);
    const generation = cursor.current.generation;
    let optimisticRead = false;
    try {
      if (item.notification_type === "PROFIT_PENDING" && item.entity_type === "order") {
        // 目标页实际打开分润后再标记；查询失败或无权查看时消息仍保留未读。
        await onPendingProfitNotificationsClick?.(item.id);
        return;
      }
      setNotificationError(null);
      setRetryItem(null);
      setSelected(item);
      if (item.read_at) return;

      optimisticRead = true;
      const optimisticReadAt = new Date().toISOString();
      setNotifications((current) => category === "latest"
        ? current.filter((entry) => entry.id !== item.id)
        : current.map((entry) => entry.id === item.id ? { ...entry, read_at: optimisticReadAt } : entry));

      const result = await notificationsApi.markReadBatch([item.id], category);
      if (cursor.current.generation !== generation) return;
      if (!result.read_ids.includes(item.id) || (category !== "latest" && !result.read_at)) {
        throw new Error("标记已读失败，请重试。");
      }
      if (category !== "latest") {
        setNotifications((current) => {
          const remaining = current.filter((entry) => entry.id !== item.id);
          const updated = { ...item, read_at: result.read_at };
          const position = remaining.findIndex((entry) => entry.id === result.next_read_id);
          if (position >= 0) {
            if (!remaining[position].read_at) remaining[position] = { ...remaining[position], read_at: updated.read_at };
            remaining.splice(position, 0, updated);
          } else remaining.push(updated);
          return remaining;
        });
      }
    } catch {
      if (cursor.current.generation !== generation) return;
      if (optimisticRead) {
        setNotifications((current) => category === "latest"
          ? [...current.filter((entry) => entry.id !== item.id), item]
            .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "") || b.id - a.id)
          : current.map((entry) => entry.id === item.id ? { ...entry, read_at: item.read_at } : entry));
        void appMessage.error("未能保存已读状态，已恢复未读。");
      }
      setNotificationError("标记已读失败，请重试。");
      setRetryItem(item);
    } finally {
      busy.current.delete(item.id);
    }
  };
  const ordered = dataOwner === username ? notifications : [];
  const retryDetails = () => detailState.retry(cursor.current.generation);
  const retryReminders = reminderSync.retry;
  return { username, dataOwner, selected, setSelected, notifications, notificationDetails: detailState.details, pendingDetails: detailState.pending, notificationError, reminderSyncError: reminderSync.error, notificationLoading, category, setCategory, retryItem, setReload, retryReminders, failedDetails: detailState.failed, detailsRetrying: detailState.retrying, retryDetails, hasMore, scrollRef, loadMore, refreshSyncedReminders: reminderSync.refreshWhenSafe, openNotification, ordered };
}
