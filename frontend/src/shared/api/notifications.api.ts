import { api } from "./client";
import type { NotificationItem } from "./types/common";

export interface ProfitNotificationDetail {
  notification_id: number;
  order_no: string;
  order_type: string;
  sale_amount: string | null;
  game_type?: string | null;
  cost_amount?: string | null;
  allocatable_profit?: string | null;
  stock_no: string | null;
  inventory_entry_at: string;
  removed_at: string | null;
  recovery_operator: string | null;
}

export const notificationsApi = {
  list: (params: { limit: number; before_id?: number; before_created_at?: string; sort_by_time?: boolean; entity_type?: string; unread_only?: boolean; read_only?: boolean; notification_type?: string; category?: "sale" | "inventory" }) => api.get<{ items: NotificationItem[]; total: number; unread_total: number }>("/notifications", { params }).then(r => r.data),
  syncInventory: () => api.post<{ created: number }>("/notifications/sync-inventory").then(r => r.data),
  pendingOrder: (notificationId?: number) => api.get<{ order_no: string | null; order_id: number | null }>("/notifications/pending-order", { params: notificationId === undefined ? undefined : { notification_id: notificationId } }).then(r => r.data),
  profitDetails: (ids: number[]) => api.get<ProfitNotificationDetail[]>("/notifications/profit-details", { params: { ids }, paramsSerializer: { indexes: null } }).then(r => r.data),
  markReadBatch: (ids: number[]) => api.post<{ read_ids: number[] }>("/notifications/read", { ids }).then(r => r.data),
};
