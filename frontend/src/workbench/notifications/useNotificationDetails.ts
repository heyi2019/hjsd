import { useState } from "react";
import { notificationsApi, type ProfitNotificationDetail } from "../../shared/api/notifications.api";

const BATCH_SIZE = 10;

/** 消息摘要独立加载；旧分页的响应不能覆盖新分类或新用户。 */
export function useNotificationDetails(isCurrent: (generation: number) => boolean) {
  const [details, setDetails] = useState<Record<number, ProfitNotificationDetail>>({});
  const [failed, setFailed] = useState<number[]>([]);
  const [pending, setPending] = useState<number[]>([]);
  const [retrying, setRetrying] = useState(false);

  const reset = () => { setDetails({}); setFailed([]); setPending([]); setRetrying(false); };
  const load = async (ids: number[], generation: number) => {
    if (!ids.length) return;
    setPending((current) => [...new Set([...current, ...ids])]);
    try {
      const result = await notificationsApi.profitDetails(ids);
      if (!isCurrent(generation)) return;
      setDetails((current) => ({ ...current, ...Object.fromEntries(result.map((item) => [item.notification_id, item])) }));
      setFailed((current) => current.filter((id) => !ids.includes(id)));
    } catch {
      if (isCurrent(generation)) setFailed((current) => [...new Set([...current, ...ids])]);
    } finally {
      if (isCurrent(generation)) setPending((current) => current.filter((id) => !ids.includes(id)));
    }
  };
  const retry = async (generation: number) => {
    if (retrying || !failed.length) return;
    setRetrying(true);
    try {
      for (let offset = 0; offset < failed.length; offset += BATCH_SIZE) {
        if (!isCurrent(generation)) return;
        await load(failed.slice(offset, offset + BATCH_SIZE), generation);
      }
    } finally {
      if (isCurrent(generation)) setRetrying(false);
    }
  };
  return { details, failed, pending, retrying, reset, load, retry };
}
