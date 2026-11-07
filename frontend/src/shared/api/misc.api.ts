import { api } from "./client";
import type { GameTypeOption, NotificationItem } from "./types";

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

export const notificationsApi = {
  list: (params: { limit: number; unread_only?: boolean }) => api.get<{ items: NotificationItem[]; total?: number; unread_total: number }>("/notifications", { params }).then(r => r.data),
  markRead: (id: number) => api.post<NotificationItem>(`/notifications/${id}/read`).then(r => r.data),
};
