import { useEffect, useRef, useState, type RefObject } from "react";
import { notificationsApi } from "../../../shared/api/notifications.api";
import type { NotificationItem } from "../../../shared/api/types/common";

type Options = {
  active: boolean;
  username: string;
  category: "latest" | "sale" | "inventory" | "contract";
  selected: NotificationItem | null;
  loading: boolean;
  notificationCount: number;
  busy: RefObject<Set<number>>;
  scrollRef: RefObject<HTMLDivElement | null>;
  onRefresh: () => void;
};

/** 提醒同步独立于消息列表；有新提醒时，在用户空闲后刷新列表。 */
export function useReminderSync(options: Options) {
  const [error, setError] = useState(false);
  const request = useRef<Promise<{ created: number }> | null>(null);
  const needsRefresh = useRef(false);
  const current = useRef(options);
  current.current = options;

  const refreshWhenSafe = () => {
    const view = current.current;
    if (!needsRefresh.current || !view.active || view.category === "sale" || view.selected || (view.busy.current?.size ?? 0) || (view.scrollRef.current?.scrollTop ?? 0) > 0) return false;
    needsRefresh.current = false;
    view.onRefresh();
    return true;
  };
  useEffect(() => {
    request.current = null;
    needsRefresh.current = false;
    setError(false);
    return () => { request.current = null; needsRefresh.current = false; };
  }, [options.active, options.username]);
  useEffect(() => { refreshWhenSafe(); }, [options.active, options.category, options.selected, options.loading, options.notificationCount]);

  const start = () => {
    setError(false);
    if (!request.current) {
      const owner = current.current.username;
      const pending = notificationsApi.syncReminders().then((result) => {
        if (result.created > 0 && request.current === pending && current.current.active && current.current.username === owner) {
          needsRefresh.current = true;
          refreshWhenSafe();
        }
        return result;
      });
      request.current = pending;
    }
    const pending = request.current;
    void pending.catch(() => { if (request.current === pending && current.current.active) setError(true); });
  };
  const retry = () => { request.current = null; current.current.onRefresh(); };
  const invalidate = () => { request.current = null; };
  return { error, start, retry, invalidate, refreshWhenSafe };
}
