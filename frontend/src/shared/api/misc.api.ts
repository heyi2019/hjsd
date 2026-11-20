import { api } from "./client";
import type { AttachmentItem, DocumentSequence, NotificationItem } from "./types/common";
import type { GameTypeOption } from "./types/org";

export interface ProfitNotificationDetail {
  notification_id: number;
  order_no: string;
  order_type: string;
  sale_amount: string | null;
  stock_no: string | null;
  inventory_entry_at: string;
  removed_at: string | null;
  recovery_operator: string | null;
}

export const gameTypesApi = {
  list: (params?: { include_inactive?: boolean }) =>
    api.get<GameTypeOption[]>("/game-types", { params }).then((r) => r.data),
  create: (payload: { name: string; sort_order?: number; is_default?: boolean; channel_regions?: string[] }) =>
    api.post<GameTypeOption>("/game-types", payload).then((r) => r.data),
  update: (id: number, payload: { name?: string; sort_order?: number; channel_regions?: string[] }) =>
    api.patch<GameTypeOption>(`/game-types/${id}`, payload).then((r) => r.data),
  setActive: (id: number, active: boolean) =>
    api.patch<GameTypeOption>(`/game-types/${id}/active?active=${active}`).then((r) => r.data),
  setDefault: (id: number, isDefault: boolean) =>
    api.patch<GameTypeOption>(`/game-types/${id}/default?is_default=${isDefault}`).then((r) => r.data),
  remove: (id: number) => api.delete(`/game-types/${id}`),
};

export const sequencesApi = {
  list: () => api.get<DocumentSequence[]>("/sequences").then(r => r.data),
};

export const attachmentsApi = {
  list: (entity_type: string, entity_id: string) => api.get<{ items: AttachmentItem[] }>("/attachments", { params: { entity_type, entity_id } }).then(r => r.data),
  create: (data: Record<string, unknown>) => api.post<AttachmentItem>("/attachments", data).then(r => r.data),
  download: (id: number) => api.get<Blob>(`/attachments/${id}/download`, { responseType: "blob" }).then(r => r.data),
  remove: (id: number) => api.delete(`/attachments/${id}`).then(r => r.data),
};

export const notificationsApi = {
  list: (params: { limit: number; before_id?: number; entity_type?: string; unread_only?: boolean; notification_type?: string }) => api.get<{ items: NotificationItem[]; total: number; unread_total: number }>("/notifications", { params }).then(r => r.data),
  pendingOrder: () => api.get<{ order_no: string | null; order_id: number | null }>("/notifications/pending-order").then(r => r.data),
  profitDetails: (ids: number[]) => api.get<ProfitNotificationDetail[]>("/notifications/profit-details", { params: { ids }, paramsSerializer: { indexes: null } }).then(r => r.data),
  markReadBatch: (ids: number[]) => api.post<{ read_ids: number[] }>("/notifications/read", { ids }).then(r => r.data),
};
