import { api, type CacheAwareRequestConfig } from "./client";
import { notifyReferenceDataChanged } from "../state/referenceDataEvents";
import type { AttachmentItem, DocumentSequence } from "./types/common";
import type { GameTypeOption } from "./types/org";

function gameTypesChanged<T>(value: T): T {
  notifyReferenceDataChanged("gameTypes");
  return value;
}

export const gameTypesApi = {
  list: (params?: { include_inactive?: boolean }, options?: { fresh?: boolean }) => {
    const config: CacheAwareRequestConfig = { params, ...(options?.fresh ? { refreshCache: true } : {}) };
    return api.get<GameTypeOption[]>("/game-types", config).then((r) => r.data);
  },
  create: (payload: { name: string; sort_order?: number; is_default?: boolean; channel_regions?: string[] }) =>
    api.post<GameTypeOption>("/game-types", payload).then((r) => gameTypesChanged(r.data)),
  update: (id: number, payload: { name?: string; sort_order?: number; channel_regions?: string[] }) =>
    api.patch<GameTypeOption>(`/game-types/${id}`, payload).then((r) => gameTypesChanged(r.data)),
  setActive: (id: number, active: boolean) =>
    api.patch<GameTypeOption>(`/game-types/${id}/active?active=${active}`).then((r) => gameTypesChanged(r.data)),
  setDefault: (id: number, isDefault: boolean) =>
    api.patch<GameTypeOption>(`/game-types/${id}/default?is_default=${isDefault}`).then((r) => gameTypesChanged(r.data)),
  remove: (id: number) => api.delete(`/game-types/${id}`).then(gameTypesChanged),
};

export const sequencesApi = {
  list: () => api.get<DocumentSequence[]>("/sequences").then(r => r.data),
};

export const attachmentsApi = {
  list: (entity_type: string, entity_id: string) => api.get<{ items: AttachmentItem[] }>("/attachments", { params: { entity_type, entity_id }, refreshCache: true } as CacheAwareRequestConfig).then(r => r.data),
  create: (data: Record<string, unknown>) => api.post<AttachmentItem>("/attachments", data).then(r => r.data),
  download: (id: number) => api.get<Blob>(`/attachments/${id}/download`, { responseType: "blob" }).then(r => r.data),
  remove: (id: number) => api.delete(`/attachments/${id}`).then(r => r.data),
};
