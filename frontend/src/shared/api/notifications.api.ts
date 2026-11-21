import { api, type CacheAwareRequestConfig } from "./client";
import type { NotificationItem } from "./types/common";

export interface ProfitNotificationDetail {
  notification_id: number;
  order_no: string;
  sale_amount: string | null;
  cost_amount: string | null;
  allocatable_profit: string | null;
}

export const notificationsApi = {
  list: (params: { limit: number; category: "latest" | "sale" | "inventory"; cursor?: string }) => {
    const config: CacheAwareRequestConfig = { params, bypassCache: true };
    return api.get<{ items: NotificationItem[]; next_cursor: string | null }>("/notifications/inbox", config).then(r => r.data);
  },
  syncInventory: () => api.post<{ created: number }>("/notifications/sync-inventory").then(r => r.data),
  pendingOrder: (notificationId?: number) => api.get<{ order_no: string | null; order_id: number | null }>("/notifications/pending-order", { params: notificationId === undefined ? undefined : { notification_id: notificationId } }).then(r => r.data),
  profitDetails: (ids: number[]) => api.get<ProfitNotificationDetail[]>("/notifications/profit-details", { params: { ids }, paramsSerializer: { indexes: null } }).then(r => r.data),
  markReadBatch: (ids: number[], category: "latest" | "sale" | "inventory") => api.post<{ read_ids: number[]; read_at: string | null; next_read_id: number | null }>("/notifications/read", { ids, category }).then(r => r.data),
};
