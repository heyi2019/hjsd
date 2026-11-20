import { api, type CacheAwareRequestConfig } from "./client";
import type { EmployeeOption, ManagedUser, Team } from "./types/org";
import { notifyReferenceDataChanged } from "../state/referenceDataEvents";

export const employeesApi = {
  list: (options?: { fresh?: boolean }) => {
    const config: CacheAwareRequestConfig = { refreshCache: true };
    const request = options?.fresh ? api.get<EmployeeOption[]>("/users/options", config) : api.get<EmployeeOption[]>("/users/options");
    return request.then((r) => r.data);
  },
};

export const usersApi = {
  list: () => api.get<ManagedUser[]>("/users").then((r) => r.data),
  create: (payload: Record<string, unknown>) => api.post<ManagedUser>("/users", payload).then((r) => {
    notifyReferenceDataChanged("employees");
    return r.data;
  }),
  update: (id: number, payload: Record<string, unknown>) => api.patch<ManagedUser>(`/users/${id}`, payload).then((r) => {
    notifyReferenceDataChanged("employees");
    return r.data;
  }),
  resetPassword: (id: number, password: string) =>
    api.post<{ ok: boolean }>(`/users/${id}/reset-password`, { password }).then((r) => r.data),
};

export const teamsApi = {
  list: (options?: { fresh?: boolean }) => {
    const config: CacheAwareRequestConfig = { refreshCache: true };
    const request = options?.fresh ? api.get<Team[]>("/teams", config) : api.get<Team[]>("/teams");
    return request.then((r) => r.data);
  },
  create: (payload: Record<string, unknown>) => api.post<Team>("/teams", payload).then((r) => {
    notifyReferenceDataChanged("teams");
    return r.data;
  }),
  update: (id: number, payload: Record<string, unknown>) => api.patch<Team>(`/teams/${id}`, payload).then((r) => {
    notifyReferenceDataChanged("teams");
    return r.data;
  }),
};
